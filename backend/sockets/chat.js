const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const CacheService = require('../services/cacheService');
const audioService = require('../services/audioService');
const aiService = require('../services/aiService');

module.exports = function(io) {
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  const messageQueues = new Map();
  const messageLoadRetries = new Map();
  const queueTimestamps = new Map(); // 큐 생성 시간 추적용
  
  // 인스턴스 ID 생성 (환경변수 또는 랜덤)
  const INSTANCE_ID = process.env.INSTANCE_ID || `instance-${Math.random().toString(36).substr(2, 9)}`;
  
  // Redis Pub/Sub을 위한 분산 상태 관리 클래스
  class DistributedState {
    constructor() {
      this.setupSubscriptions();
    }
    
    async setupSubscriptions() {
      try {
        const subscriber = await redisClient.ensureConnection();
        
        // 사용자 로그인 알림 구독
        await subscriber.subscribe('user:login');
        await subscriber.subscribe('user:logout'); 
        await subscriber.subscribe('user:room:join');
        await subscriber.subscribe('user:room:leave');
        
        subscriber.on('message', (channel, message) => {
          try {
            const data = JSON.parse(message);
            
            // 자신의 인스턴스에서 발생한 이벤트는 무시
            if (data.instanceId === INSTANCE_ID) return;
            
            switch (channel) {
              case 'user:login':
                this.handleRemoteUserLogin(data);
                break;
              case 'user:logout':
                this.handleRemoteUserLogout(data);
                break;
              case 'user:room:join':
                this.handleRemoteRoomJoin(data);
                break;
              case 'user:room:leave':
                this.handleRemoteRoomLeave(data);
                break;
            }
          } catch (error) {
            console.error('Pub/Sub message parsing error:', error);
          }
        });
        
        console.log(`[${INSTANCE_ID}] Redis Pub/Sub subscriptions established`);
      } catch (error) {
        console.error('Redis Pub/Sub setup error:', error);
      }
    }
    
    // 원격 사용자 로그인 처리
    handleRemoteUserLogin(data) {
      const { userId, socketId, instanceId } = data;
      console.log(`[${INSTANCE_ID}] Remote user login detected: ${userId} on ${instanceId}`);
      
      // 로컬에 연결된 같은 사용자가 있다면 중복 로그인 처리
      const localSocketId = connectedUsers.get(userId);
      if (localSocketId) {
        const localSocket = io.sockets.sockets.get(localSocketId);
        if (localSocket) {
          localSocket.emit('duplicate_login', {
            type: 'remote_login_detected',
            instanceId: instanceId,
            timestamp: Date.now()
          });
          
          setTimeout(() => {
            localSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            localSocket.disconnect(true);
          }, 5000);
        }
      }
    }
    
    // 원격 사용자 로그아웃 처리
    handleRemoteUserLogout(data) {
      const { userId, instanceId } = data;
      console.log(`[${INSTANCE_ID}] Remote user logout detected: ${userId} from ${instanceId}`);
    }
    
    // 원격 방 입장 처리
    handleRemoteRoomJoin(data) {
      const { userId, roomId, instanceId } = data;
      console.log(`[${INSTANCE_ID}] Remote room join: ${userId} joined ${roomId} on ${instanceId}`);
    }
    
    // 원격 방 퇴장 처리
    handleRemoteRoomLeave(data) {
      const { userId, roomId, instanceId } = data;
      console.log(`[${INSTANCE_ID}] Remote room leave: ${userId} left ${roomId} on ${instanceId}`);
    }
    
    // 사용자 로그인 알림 발행
    async notifyUserLogin(userId, socketId) {
      try {
        const publisher = await redisClient.ensureConnection();
        
        // Redis Hash에 사용자 상태 저장
        await publisher.hset('connected_users', userId, JSON.stringify({
          socketId,
          instanceId: INSTANCE_ID,
          timestamp: Date.now()
        }));
        
        // 다른 인스턴스들에게 알림
        await publisher.publish('user:login', JSON.stringify({
          userId,
          socketId,
          instanceId: INSTANCE_ID,
          timestamp: Date.now()
        }));
        
        console.log(`[${INSTANCE_ID}] Published user login: ${userId}`);
      } catch (error) {
        console.error('Notify user login error:', error);
      }
    }
    
    // 사용자 로그아웃 알림 발행
    async notifyUserLogout(userId) {
      try {
        const publisher = await redisClient.ensureConnection();
        
        // Redis Hash에서 사용자 상태 제거
        await publisher.hdel('connected_users', userId);
        
        // 다른 인스턴스들에게 알림
        await publisher.publish('user:logout', JSON.stringify({
          userId,
          instanceId: INSTANCE_ID,
          timestamp: Date.now()
        }));
        
        console.log(`[${INSTANCE_ID}] Published user logout: ${userId}`);
      } catch (error) {
        console.error('Notify user logout error:', error);
      }
    }
    
    // 방 입장 알림 발행
    async notifyRoomJoin(userId, roomId) {
      try {
        const publisher = await redisClient.ensureConnection();
        
        // Redis Hash에 사용자-방 매핑 저장
        await publisher.hset('user_rooms', userId, roomId);
        
        // 다른 인스턴스들에게 알림
        await publisher.publish('user:room:join', JSON.stringify({
          userId,
          roomId,
          instanceId: INSTANCE_ID,
          timestamp: Date.now()
        }));
        
        console.log(`[${INSTANCE_ID}] Published room join: ${userId} -> ${roomId}`);
      } catch (error) {
        console.error('Notify room join error:', error);
      }
    }
    
    // 방 퇴장 알림 발행
    async notifyRoomLeave(userId, roomId) {
      try {
        const publisher = await redisClient.ensureConnection();
        
        // Redis Hash에서 사용자-방 매핑 제거
        await publisher.hdel('user_rooms', userId);
        
        // 다른 인스턴스들에게 알림
        await publisher.publish('user:room:leave', JSON.stringify({
          userId,
          roomId,
          instanceId: INSTANCE_ID,
          timestamp: Date.now()
        }));
        
        console.log(`[${INSTANCE_ID}] Published room leave: ${userId} -> ${roomId}`);
      } catch (error) {
        console.error('Notify room leave error:', error);
      }
    }
    
    // 전역 중복 로그인 체크
    async checkGlobalDuplicateLogin(userId) {
      try {
        const publisher = await redisClient.ensureConnection();
        const existingUser = await publisher.hget('connected_users', userId);
        
        if (existingUser) {
          const userData = JSON.parse(existingUser);
          console.log(`[${INSTANCE_ID}] Global duplicate login detected for ${userId}: ${userData.instanceId}`);
          return userData;
        }
        
        return null;
      } catch (error) {
        console.error('Check global duplicate login error:', error);
        return null;
      }
    }
  }
  
  // 분산 상태 관리 인스턴스 생성
  const distributedState = new DistributedState();
  const BATCH_SIZE = 15;  // 한 번에 로드할 메시지 수 (30 → 15)
  const LOAD_DELAY = 100; // 메시지 로드 딜레이 (300ms → 100ms)
  const MAX_RETRIES = 3;  // 최대 재시도 횟수
  const MESSAGE_LOAD_TIMEOUT = 10000; // 메시지 로드 타임아웃 (10초)
  const RETRY_DELAY = 2000; // 재시도 간격 (2초)
  const DUPLICATE_LOGIN_TIMEOUT = 10000; // 중복 로그인 타임아웃 (10초)

  // 메모리 정리를 위한 정기적인 Map 정리
  setInterval(() => {
    const now = Date.now();
    
    // 5분 이상 비활성 스트리밍 세션 정리
    for (const [messageId, session] of streamingSessions.entries()) {
      if (now - session.lastUpdate > 300000) { // 5분
        streamingSessions.delete(messageId);
      }
    }
    
    // 10분 이상 비활성 메시지 큐 정리
    for (const [queueKey, timestamp] of queueTimestamps.entries()) {
      if (now - timestamp > 600000) { // 10분
        messageQueues.delete(queueKey);
        messageLoadRetries.delete(queueKey);
        queueTimestamps.delete(queueKey);
      }
    }
    
    console.debug('[Socket.IO] Memory cleanup completed', {
      streamingSessions: streamingSessions.size,
      messageQueues: messageQueues.size,
      connectedUsers: connectedUsers.size
    });
  }, 300000); // 5분마다 실행

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // Redis 캐싱 함수들 추가
  const getCachedRecentMessages = async (roomId) => {
    try {
      const cacheKey = `recent_messages:${roomId}`;
      const cached = await redisClient.get(cacheKey);
      
      if (cached) {
        logDebug('cache hit for recent messages', { roomId });
        return cached;
      }
      
      return null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  };

  const cacheRecentMessages = async (roomId, messageData) => {
    try {
      const cacheKey = `recent_messages:${roomId}`;
      await redisClient.setEx(cacheKey, 300, messageData); // 5분 캐싱
      
      logDebug('cached recent messages', { 
        roomId, 
        messageCount: messageData.messages?.length || 0 
      });
    } catch (error) {
      console.error('Cache set error:', error);
    }
  };

  const invalidateRoomCache = async (roomId) => {
    try {
      const cacheKey = `recent_messages:${roomId}`;
      await redisClient.del(cacheKey);
      logDebug('cache invalidated', { roomId });
    } catch (error) {
      console.error('Cache invalidation error:', error);
    }
  };

  // 캐시에 새 메시지 추가 (무효화 대신)
  const updateCacheWithNewMessage = async (roomId, newMessage) => {
    try {
      const cacheKey = `recent_messages:${roomId}`;
      const cachedData = await redisClient.get(cacheKey);
      
      if (cachedData && cachedData.messages) {
        // 기존 캐시에 새 메시지 추가
        const updatedMessages = [...cachedData.messages, newMessage];
        
        // 최대 15개까지만 유지 (오래된 것 제거)
        if (updatedMessages.length > 15) {
          updatedMessages.shift(); // 첫 번째(가장 오래된) 메시지 제거
        }
        
        const updatedData = {
          ...cachedData,
          messages: updatedMessages,
          hasMore: true, // 새 메시지가 추가되었으므로 더 있을 가능성
          oldestTimestamp: updatedMessages[0]?.timestamp
        };
        
        // 캐시 업데이트 (TTL 갱신)
        await redisClient.setEx(cacheKey, 300, updatedData);
        
        logDebug('cache updated with new message', { 
          roomId, 
          messageCount: updatedMessages.length,
          messageType: newMessage.type
        });
      } else {
        logDebug('no cache to update', { roomId });
      }
    } catch (error) {
      console.error('Cache update error:', error);
      // 업데이트 실패 시 캐시 무효화
      await invalidateRoomCache(roomId);
    }
  };

  // 배치 읽음 상태 업데이트
  const batchUpdateReadStatus = async (userId, roomId, messageIds) => {
    const updateKey = `read_update:${userId}:${roomId}`;
    
    try {
      // 기존 대기 중인 업데이트와 병합
      const existingUpdate = await redisClient.get(updateKey);
      const allMessageIds = existingUpdate 
        ? [...new Set([...existingUpdate, ...messageIds])]
        : messageIds;
      
      // 3초 후 일괄 처리하도록 스케줄링
      await redisClient.setEx(updateKey, 3, allMessageIds);
      
      // 3초 후 실제 업데이트 실행
      setTimeout(async () => {
        try {
          const pendingIds = await redisClient.get(updateKey);
          if (pendingIds && Array.isArray(pendingIds)) {
            await Message.updateMany(
              {
                _id: { $in: pendingIds },
                room: roomId,
                'readers.userId': { $ne: userId }
              },
              {
                $push: {
                  readers: {
                    userId: userId,
                    readAt: new Date()
                  }
                }
              }
            );
            
            await redisClient.del(updateKey);
            logDebug('batch read status updated', {
              userId,
              roomId,
              messageCount: pendingIds.length
            });
          }
        } catch (error) {
          console.error('Batch read update error:', error);
        }
      }, 3000);
      
    } catch (error) {
      console.error('Read status queue error:', error);
    }
  };

  // 메시지 일괄 로드 함수 개선
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Message loading timed out'));
      }, MESSAGE_LOAD_TIMEOUT);
    });

    try {
      // 쿼리 구성
      const query = { room: roomId };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      // 메시지 로드 with profileImage
      const messages = await Promise.race([
        Message.find(query)
          .populate('sender', 'name email profileImage')
          .populate({
            path: 'file',
            select: 'filename originalname mimetype size'
          })
          .sort({ timestamp: -1 })
          .limit(limit + 1)
          .lean(),
        timeoutPromise
      ]);

      // 결과 처리
      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      // 읽음 상태 비동기 업데이트
      if (sortedMessages.length > 0 && socket.user) {
        const messageIds = sortedMessages.map(msg => msg._id);
        Message.updateMany(
          {
            _id: { $in: messageIds },
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        ).exec().catch(error => {
          console.error('Read status update error:', error);
        });
      }

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null
      };
    } catch (error) {
      if (error.message === 'Message loading timed out') {
        logDebug('message load timeout', {
          roomId,
          before,
          limit
        });
      } else {
        console.error('Load messages error:', {
          error: error.message,
          stack: error.stack,
          roomId,
          before,
          limit
        });
      }
      throw error;
    }
  };

  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    
    try {
      if (messageLoadRetries.get(retryKey) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      messageLoadRetries.delete(retryKey);
      return result;

    } catch (error) {
      const currentRetries = messageLoadRetries.get(retryKey) || 0;
      
      if (currentRetries < MAX_RETRIES) {
        messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);
        
        logDebug('retrying message load', {
          roomId,
          retryCount: currentRetries + 1,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // 중복 로그인 처리 함수
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      // 기존 연결에 중복 로그인 알림
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      // 타임아웃 설정
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            // 기존 세션 종료
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });

            // 기존 연결 종료
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      // 이미 연결된 사용자인지 확인
      const existingSocketId = connectedUsers.get(decoded.user.id);
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          // 중복 로그인 처리
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      // 🚀 사용자 정보를 캐시에서 가져오기
      const user = await CacheService.getUserInfo(decoded.user.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();

    } catch (error) {
      console.error('Socket authentication error:', error);
      
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      
      next(new Error('Authentication failed'));
    }
  });
  
  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name,
      instanceId: INSTANCE_ID
    });

    if (socket.user) {
      // 전역 중복 로그인 체크
      distributedState.checkGlobalDuplicateLogin(socket.user.id).then(existingUser => {
        if (existingUser && existingUser.instanceId !== INSTANCE_ID) {
          // 다른 인스턴스에 연결된 사용자가 있음
          socket.emit('duplicate_login', {
            type: 'existing_session_detected',
            existingInstance: existingUser.instanceId,
            timestamp: Date.now()
          });
          
          setTimeout(() => {
            socket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '이미 다른 기기에서 로그인되어 있습니다.'
            });
            socket.disconnect(true);
          }, 5000);
          return;
        }
        
        // 로컬 중복 로그인 체크
        const previousSocketId = connectedUsers.get(socket.user.id);
        if (previousSocketId && previousSocketId !== socket.id) {
          const previousSocket = io.sockets.sockets.get(previousSocketId);
          if (previousSocket) {
            // 이전 연결에 중복 로그인 알림
            previousSocket.emit('duplicate_login', {
              type: 'new_login_attempt',
              deviceInfo: socket.handshake.headers['user-agent'],
              ipAddress: socket.handshake.address,
              timestamp: Date.now()
            });

            // 이전 연결 종료 처리
            setTimeout(() => {
              previousSocket.emit('session_ended', {
                reason: 'duplicate_login',
                message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
              });
              previousSocket.disconnect(true);
            }, DUPLICATE_LOGIN_TIMEOUT);
          }
        }
        
        // 새로운 연결 정보 저장 (로컬 + 분산)
        connectedUsers.set(socket.user.id, socket.id);
        
        // Redis Pub/Sub으로 다른 인스턴스들에게 알림
        distributedState.notifyUserLogin(socket.user.id, socket.id);
      });
    }

    // 이전 메시지 로딩 처리 개선
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 권한 체크
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        });

        if (!room) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        if (messageQueues.get(queueKey)) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

        messageQueues.set(queueKey, true);
        queueTimestamps.set(queueKey, Date.now()); // 타임스탬프 추가
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);
        
        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        setTimeout(() => {
          messageQueues.delete(queueKey);
          queueTimestamps.delete(queueKey);
        }, LOAD_DELAY);
      }
    });
    
    // 채팅방 입장 처리 개선 (Redis 캐싱 적용)
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 이미 해당 방에 참여 중인지 확인
        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom === roomId) {
          logDebug('already in room', {
            userId: socket.user.id,
            roomId
          });
          
          // 캐시된 메시지가 있으면 즉시 반환
          const cachedData = await getCachedRecentMessages(roomId);
          if (cachedData) {
            socket.emit('joinRoomSuccess', {
              roomId,
              ...cachedData,
              fromCache: true
            });
            return;
          }
          
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        // 기존 방에서 나가기
        if (currentRoom) {
          logDebug('leaving current room', { 
            userId: socket.user.id, 
            roomId: currentRoom 
          });
          socket.leave(currentRoom);
          userRooms.delete(socket.user.id);
          
          socket.to(currentRoom).emit('userLeft', {
            userId: socket.user.id,
            name: socket.user.name
          });
        }

        // 채팅방 참가 with profileImage
        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true 
          }
        ).populate('participants', 'name email profileImage');

        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        socket.join(roomId);
        userRooms.set(socket.user.id, roomId);

        // Redis Pub/Sub으로 방 입장 알림
        await distributedState.notifyRoomJoin(socket.user.id, roomId);

        // 1단계: 즉시 입장 성공 응답 (캐시 확인)
        const cachedMessages = await getCachedRecentMessages(roomId);
        
        if (cachedMessages) {
          // 캐시된 데이터가 있으면 즉시 반환
          socket.emit('joinRoomSuccess', {
            roomId,
            participants: room.participants,
            ...cachedMessages,
            fromCache: true
          });
          
          logDebug('user joined room with cached messages', {
            userId: socket.user.id,
            roomId,
            messageCount: cachedMessages.messages?.length || 0
          });
        } else {
          // 캐시가 없으면 빈 메시지로 즉시 응답
          socket.emit('joinRoomSuccess', {
            roomId,
            participants: room.participants,
            messages: [],
            hasMore: true,
            loading: true
          });

          // 2단계: 백그라운드에서 메시지 로드
          setImmediate(async () => {
            try {
              const messageLoadResult = await loadMessages(socket, roomId, null, 15); // 더 적은 수로 시작
              const { messages, hasMore, oldestTimestamp } = messageLoadResult;

              // 활성 스트리밍 메시지 조회
              const activeStreams = Array.from(streamingSessions.values())
                .filter(session => session.room === roomId)
                .map(session => ({
                  _id: session.messageId,
                  type: 'ai',
                  aiType: session.aiType,
                  content: session.content,
                  timestamp: session.timestamp,
                  isStreaming: true
                }));

              const messageData = {
                messages,
                hasMore,
                oldestTimestamp,
                activeStreams
              };

              // Redis에 캐싱
              await cacheRecentMessages(roomId, messageData);

              // 메시지 로드 완료 이벤트 발송
              socket.emit('initialMessagesLoaded', messageData);

              logDebug('background message load completed', {
                userId: socket.user.id,
                roomId,
                messageCount: messages.length,
                hasMore
              });

            } catch (error) {
              console.error('Background message load error:', error);
              socket.emit('messageLoadError', {
                error: '메시지를 불러오는 중 오류가 발생했습니다.'
              });
            }
          });
        }

        // 입장 메시지 생성 (비동기)
        setImmediate(async () => {
          try {
            const joinMessage = new Message({
              room: roomId,
              content: `${socket.user.name}님이 입장하였습니다.`,
              type: 'system',
              timestamp: new Date()
            });
            
            await joinMessage.save();
            io.to(roomId).emit('message', joinMessage);
            
            // 캐시 무효화 (새 메시지 추가됨)
            await invalidateRoomCache(roomId);
          } catch (error) {
            console.error('Join message creation error:', error);
          }
        });

        io.to(roomId).emit('participantsUpdate', room.participants);

      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });
    
    // 메시지 전송 처리
    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!messageData) {
          throw new Error('메시지 데이터가 없습니다.');
        }

        console.log('=== Received message data ===');
        console.log('Full messageData:', JSON.stringify(messageData, null, 2));
        console.log('=== End of message data ===');

        const { room, type, content, fileData } = messageData;

        if (!room) {
          throw new Error('채팅방 정보가 없습니다.');
        }

        // 채팅방 권한 확인
        const chatRoom = await Room.findOne({
          _id: room,
          participants: socket.user.id
        });

        if (!chatRoom) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        // 세션 유효성 재확인
        const sessionValidation = await SessionService.validateSession(
          socket.user.id, 
          socket.user.sessionId
        );
        
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        // AI 멘션 확인
        const aiMentions = extractAIMentions(content);
        let message;

        logDebug('message received', {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length
        });

        // 메시지 타입별 처리
        switch (type) {
          case 'file':
            if (!fileData) {
              throw new Error('파일 데이터가 없습니다.');
            }

            // fileData가 객체인지 문자열인지 확인
            let fileId;
            if (typeof fileData === 'string') {
              fileId = fileData;
            } else if (fileData._id) {
              fileId = fileData._id;
            } else if (fileData.id) {
              fileId = fileData.id;
            } else if (fileData.filename) {
              // filename으로 파일을 찾는 방법 추가
              console.log('Trying to find file by filename:', fileData.filename);
              const fileByName = await File.findOne({
                filename: fileData.filename,
                user: socket.user.id
              }).sort({ uploadDate: -1 }); // 가장 최근 파일

              if (fileByName) {
                fileId = fileByName._id;
                console.log('Found file by filename:', fileId);
              } else {
                console.error('File not found by filename:', fileData.filename);
                throw new Error('파일을 찾을 수 없습니다.');
              }
            } else {
              console.error('Invalid fileData structure:', fileData);
              throw new Error('파일 ID를 찾을 수 없습니다.');
            }

            const file = await File.findOne({
              _id: fileId,
              user: socket.user.id
            });

            if (!file) {
              throw new Error('파일을 찾을 수 없거나 접근 권한이 없습니다.');
            }

            message = new Message({
              room,
              sender: socket.user.id,
              type: 'file',
              file: file._id,
              content: content || '',
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname
              }
            });
            break;

          case 'text':
            const messageContent = content?.trim() || messageData.msg?.trim();
            if (!messageContent) {
              return;
            }

            message = new Message({
              room,
              sender: socket.user.id,
              content: messageContent,
              type: 'text',
              timestamp: new Date(),
              reactions: {}
            });
            break;

          default:
            throw new Error('지원하지 않는 메시지 타입입니다.');
        }

        await message.save();
        await message.populate([
          { path: 'sender', select: 'name email profileImage' },
          { path: 'file', select: 'filename originalname mimetype size' }
        ]);

        io.to(room).emit('message', message);

        // 캐시 업데이트 (무효화 대신 새 메시지 추가)
        await updateCacheWithNewMessage(room, message);

        // AI 멘션이 있는 경우 AI 응답 생성
        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content.replace(new RegExp(`@${ai}\\b`, 'g'), '').trim();
            await handleAIResponse(io, room, ai, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        logDebug('message processed', {
          messageId: message._id,
          type: message.type,
          room
        });

      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

        // 채팅방 퇴장 처리
        socket.on('leaveRoom', async (roomId) => {
          try {
            if (!socket.user) {
              throw new Error('Unauthorized');
            }

            // 실제로 해당 방에 참여 중인지 먼저 확인
            const currentRoom = userRooms?.get(socket.user.id);
            if (!currentRoom || currentRoom !== roomId) {
              console.log(`User ${socket.user.id} is not in room ${roomId}`);
              return;
            }

            // 🚀 캐시에서 방 정보 확인
            const room = await CacheService.getRoomInfo(roomId);

            if (!room) {
              console.log(`Room ${roomId} not found or user has no access`);
              return;
            }

            socket.leave(roomId);
            userRooms.delete(socket.user.id);

            // Redis Pub/Sub으로 방 퇴장 알림
            await distributedState.notifyRoomLeave(socket.user.id, roomId);

            // 퇴장 메시지 생성 및 저장
            const leaveMessage = await Message.create({
              room: roomId,
              content: `${socket.user.name}님이 퇴장하였습니다.`,
              type: 'system',
              timestamp: new Date()
            });

            // 참가자 목록에서 사용자 제거
            await Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: socket.user.id } },
              { new: true }
            );

            // 🚀 관련 캐시 무효화
            await Promise.all([
              CacheService.invalidateRoomInfo(roomId),
              CacheService.invalidateRoomParticipants(roomId),
              CacheService.invalidateRoomsListCache(),
              invalidateRoomCache(roomId) // 메시지 캐시도 무효화
            ]);

            // 업데이트된 참가자 목록 가져오기
            const updatedRoom = await CacheService.getRoomInfo(roomId);

            // 스트리밍 세션 정리
            for (const [messageId, session] of streamingSessions.entries()) {
              if (session.room === roomId && session.userId === socket.user.id) {
                streamingSessions.delete(messageId);
              }
            }

            // 메시지 큐 정리
            const queueKey = `${roomId}:${socket.user.id}`;
            messageQueues.delete(queueKey);
            messageLoadRetries.delete(queueKey);
            queueTimestamps.delete(queueKey);

            // 이벤트 발송
            io.to(roomId).emit('message', leaveMessage);
            if (updatedRoom) {
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }

            console.log(`User ${socket.user.id} left room ${roomId} successfully`);

          } catch (error) {
            console.error('Leave room error:', error);
            socket.emit('error', {
              message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
            });
          }
        });
    
    // 연결 해제 처리
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        // 해당 사용자의 현재 활성 연결인 경우에만 정리
        if (connectedUsers.get(socket.user.id) === socket.id) {
          connectedUsers.delete(socket.user.id);
          
          // Redis Pub/Sub으로 로그아웃 알림
          await distributedState.notifyUserLogout(socket.user.id);
        }

        const roomId = userRooms.get(socket.user.id);
        if (roomId) {
          userRooms.delete(socket.user.id);
          
          // Redis Pub/Sub으로 방 퇴장 알림
          await distributedState.notifyRoomLeave(socket.user.id, roomId);
        }

        // 메시지 큐 정리
        const userQueues = Array.from(messageQueues.keys())
          .filter(key => key.endsWith(`:${socket.user.id}`));
        userQueues.forEach(key => {
          messageQueues.delete(key);
          messageLoadRetries.delete(key);
          queueTimestamps.delete(key);
        });
        
        // 스트리밍 세션 정리
        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        // 현재 방에서 자동 퇴장 처리
        if (roomId) {
          // 다른 디바이스로 인한 연결 종료가 아닌 경우에만 처리
          if (reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
            const leaveMessage = await Message.create({
              room: roomId,
              content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
              type: 'system',
              timestamp: new Date()
            });

            const updatedRoom = await Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: socket.user.id } },
              { 
                new: true,
                runValidators: true 
              }
            ).populate('participants', 'name email profileImage');

            if (updatedRoom) {
              io.to(roomId).emit('message', leaveMessage);
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });

    // 세션 종료 또는 로그아웃 처리
    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        // 강제 로그아웃을 요청한 클라이언트의 세션 정보 확인
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        // 세션 종료 처리
        await distributedState.notifyUserLogout(socket.user.id);
        
        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        // 연결 종료
        socket.disconnect(true);

      } catch (error) {
        console.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    // 메시지 읽음 상태 처리 (배치 처리 적용)
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 배치 처리로 읽음 상태 업데이트
        await batchUpdateReadStatus(socket.user.id, roomId, messageIds);

        // 즉시 다른 사용자들에게 알림
        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        console.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    // 리액션 처리
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        // 리액션 추가/제거
        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        // 업데이트된 리액션 정보 브로드캐스트
        io.to(message.room).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });

      } catch (error) {
        console.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });

    // Audio transcription chunk processing
    socket.on('audioChunk', async ({ audioData, sessionId, sequence, roomId }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!audioData || !sessionId) {
          throw new Error('Audio data and session ID are required');
        }

        // Convert base64 audio data to buffer
        const audioBuffer = Buffer.from(audioData, 'base64');
        
        // Process audio chunk for transcription
        const partialTranscription = await audioService.processAudioChunk(audioBuffer, sessionId);
        
        if (partialTranscription && partialTranscription.trim()) {
          // Send partial transcription back to the client
          socket.emit('transcriptionChunk', {
            sessionId,
            sequence,
            transcription: partialTranscription,
            isPartial: true,
            timestamp: new Date()
          });

          logDebug('audio chunk processed', {
            sessionId,
            sequence,
            transcriptionLength: partialTranscription.length,
            userId: socket.user.id
          });
        }

      } catch (error) {
        console.error('Audio chunk processing error:', error);
        socket.emit('transcriptionError', {
          sessionId: sessionId || 'unknown',
          error: error.message || 'Audio transcription failed'
        });
      }
    });

    // Complete audio transcription
    socket.on('audioComplete', async ({ sessionId, roomId }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!sessionId) {
          throw new Error('Session ID is required');
        }

        // Notify completion
        socket.emit('transcriptionComplete', {
          sessionId,
          timestamp: new Date()
        });

        logDebug('audio transcription completed', {
          sessionId,
          userId: socket.user.id,
          roomId
        });

      } catch (error) {
        console.error('Audio completion error:', error);
        socket.emit('transcriptionError', {
          sessionId: sessionId || 'unknown',
          error: error.message || 'Audio completion failed'
        });
      }
    });

    // TTS request for AI messages
    socket.on('requestTTS', async ({ messageId, text, aiType }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!text || !messageId) {
          throw new Error('Message ID and text are required');
        }

        logDebug('TTS requested', {
          messageId,
          aiType,
          textLength: text.length,
          userId: socket.user.id
        });

        // Generate TTS audio
        const audioBuffer = await audioService.textToSpeech(text, aiType || 'default');
        
        // Convert to base64 for transmission
        const audioBase64 = audioBuffer.toString('base64');
        
        socket.emit('ttsReady', {
          messageId,
          audioData: audioBase64,
          format: 'mp3',
          voice: audioService.getVoiceForAI(aiType),
          timestamp: new Date()
        });

        logDebug('TTS generated', {
          messageId,
          aiType,
          audioSize: audioBuffer.length,
          userId: socket.user.id
        });

      } catch (error) {
        console.error('TTS generation error:', error);
        socket.emit('ttsError', {
          messageId: messageId || 'unknown',
          error: error.message || 'TTS generation failed'
        });
      }
    });
  });

  // AI 멘션 추출 함수
  function extractAIMentions(content) {
    if (!content) return [];
    
    const aiTypes = ['wayneAI', 'consultingAI'];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI)\b/g;
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }
    
    return Array.from(mentions);
  }

  // AI 응답 처리 함수 개선
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();

    // 스트리밍 세션 초기화
    streamingSessions.set(messageId, {
      room,
      aiType: aiName,
      content: '',
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {}
    });
    
    logDebug('AI response started', {
      messageId,
      aiType: aiName,
      room,
      query
    });

    // 초기 상태 전송
    io.to(room).emit('aiMessageStart', {
      messageId,
      aiType: aiName,
      timestamp
    });

    try {
      // AI 응답 생성 및 스트리밍
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', {
            messageId,
            aiType: aiName
          });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || '';
          
          const session = streamingSessions.get(messageId);
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
          }

          io.to(room).emit('aiMessageChunk', {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false
          });
        },
        onComplete: async (finalContent) => {
          // 스트리밍 세션 정리
          streamingSessions.delete(messageId);

          // AI 메시지 저장
          const aiMessage = await Message.create({
            room,
            content: finalContent.content,
            type: 'ai',
            aiType: aiName,
            timestamp: new Date(),
            reactions: {},
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens
            }
          });

          // 완료 메시지 전송
          io.to(room).emit('aiMessageComplete', {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {}
          });

          logDebug('AI response completed', {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp
          });
        },
        onError: (error) => {
          streamingSessions.delete(messageId);
          console.error('AI response error:', error);
          
          io.to(room).emit('aiMessageError', {
            messageId,
            error: error.message || 'AI 응답 생성 중 오류가 발생했습니다.',
            aiType: aiName
          });

          logDebug('AI response error', {
            messageId,
            aiType: aiName,
            error: error.message
          });
        }
      });
    } catch (error) {
      streamingSessions.delete(messageId);
      console.error('AI service error:', error);
      
      io.to(room).emit('aiMessageError', {
        messageId,
        error: error.message || 'AI 서비스 오류가 발생했습니다.',
        aiType: aiName
      });

      logDebug('AI service error', {
        messageId,
        aiType: aiName,
        error: error.message
      });
    }
  }

  return io;
};