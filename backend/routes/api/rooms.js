const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Room = require('../../models/Room');
const User = require('../../models/User');
const CacheService = require('../../services/cacheService');
const redisClient = require('../../utils/redisClient');
const { rateLimit } = require('express-rate-limit');
let io;

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    
    // 🚀 LEAN 최적화: 헬스체크용 쿼리
    const recentRoom = await Room.findOne()
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const start = process.hrtime();
    await Room.findOne().select('_id').lean();
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    // 🚀 Redis 캐시 상태 확인
    let cacheStatus = 'unknown';
    let cacheLatency = 0;
    
    try {
      const cacheStart = process.hrtime();
      await redisClient.set('health:check', 'ok', { ttl: 10 });
      const cacheResult = await redisClient.get('health:check');
      const [cacheSec, cacheNano] = process.hrtime(cacheStart);
      cacheLatency = Math.round((cacheSec * 1000) + (cacheNano / 1000000));
      cacheStatus = cacheResult === 'ok' ? 'connected' : 'error';
    } catch (cacheError) {
      cacheStatus = 'disconnected';
      console.error('Cache health check error:', cacheError);
    }

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        },
        cache: {
          status: cacheStatus,
          latency: cacheLatency,
          type: cacheStatus === 'disconnected' ? 'in-memory-mock' : 'redis'
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    const httpStatus = (isMongoConnected && cacheStatus !== 'error') ? 200 : 503;
    res.status(httpStatus).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 채팅방 목록 조회 (페이징 적용) - 🚀 Redis 캐싱 적용
router.get('/', [limiter, auth], async (req, res) => {
  try {
    // 쿼리 파라미터 검증 (페이지네이션)
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const skip = page * pageSize;

    // 정렬 설정
    const allowedSortFields = ['createdAt', 'name', 'participantsCount'];
    const sortField = allowedSortFields.includes(req.query.sortField) 
      ? req.query.sortField 
      : 'createdAt';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder)
      ? req.query.sortOrder
      : 'desc';

    // 검색 필터
    const search = req.query.search?.trim() || '';

    // 🚀 캐시에서 먼저 확인
    const cachedResult = await CacheService.getRoomsList(page, pageSize, sortField, sortOrder, search);
    
    if (cachedResult) {
      // 캐시 히트 헤더 추가
      res.set({
        'X-Cache': 'HIT',
        'Cache-Control': 'private, max-age=300',
        'Last-Modified': new Date().toUTCString()
      });

      return res.json({
        success: true,
        ...cachedResult,
        cached: true
      });
    }

    // 캐시 미스 - DB에서 조회
    console.log(`[API] Cache miss - fetching rooms from DB`);

    // 검색 필터 구성
    const filter = {};
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }

    // 🚀 LEAN 최적화: 총 문서 수 조회
    const totalCount = await Room.countDocuments(filter);

    // 🚀 LEAN 최적화: 채팅방 목록 조회 with 페이지네이션
    const rooms = await Room.find(filter)
      .populate({
        path: 'creator',
        select: 'name email profileImage',
        options: { lean: true }
      })
      .populate({
        path: 'participants',
        select: 'name email profileImage',
        options: { lean: true }
      })
      .select('name hasPassword creator participants createdAt')
      .sort({ [sortField]: sortOrder === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    // 안전한 응답 데이터 구성 
    const safeRooms = rooms.map(room => {
      if (!room) return null;

      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };
      const participants = Array.isArray(room.participants) ? room.participants : [];

      return {
        _id: room._id?.toString() || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id?.toString() || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || '',
          profileImage: creator.profileImage || ''
        },
        participants: participants.filter(p => p && p._id).map(p => ({
          _id: p._id.toString(),
          name: p.name || '알 수 없음',
          email: p.email || '',
          profileImage: p.profileImage || ''
        })),
        participantsCount: participants.length,
        createdAt: room.createdAt || new Date(),
        isCreator: creator._id?.toString() === req.user.id,
      };
    }).filter(room => room !== null);

    // 메타데이터 계산    
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;

    const responseData = {
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: {
          field: sortField,
          order: sortOrder
        }
      }
    };

    // 🚀 결과를 캐시에 저장
    await CacheService.setRoomsList(page, pageSize, sortField, sortOrder, search, responseData);

    // 캐시 미스 헤더 추가
    res.set({
      'X-Cache': 'MISS',
      'Cache-Control': 'private, max-age=300',
      'Last-Modified': new Date().toUTCString()
    });

    // 응답 전송
    res.json({
      success: true,
      ...responseData,
      cached: false
    });

  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    const errorResponse = {
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.error.details = error.message;
      errorResponse.error.stack = error.stack;
    }

    res.status(500).json(errorResponse);
  }
});

// 채팅방 생성 (lean() 불가 - 새로운 문서 생성)
router.post('/', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }

    const newRoom = new Room({
      name: name.trim(),
      creator: req.user.id,
      participants: [req.user.id],
      password: password
    });

    const savedRoom = await newRoom.save();
    
    // 🚀 캐싱된 정보로 응답 데이터 구성
    const creatorInfo = await CacheService.getUserInfo(req.user.id);
    
    const populatedRoom = {
      _id: savedRoom._id,
      name: savedRoom.name,
      hasPassword: !!savedRoom.password,
      creator: creatorInfo,
      participants: [creatorInfo],
      createdAt: savedRoom.createdAt
    };

    // 🚀 새 방 정보를 캐시에 저장
    await CacheService.updateRoomInfoCache(savedRoom._id, populatedRoom);
    
    // 🚀 방 목록 캐시 무효화
    await CacheService.invalidateRoomsListCache();
    
    // Socket.IO를 통해 새 채팅방 생성 알림
    if (io) {
      io.to('room-list').emit('roomCreated', {
        ...populatedRoom,
        password: undefined
      });
    }
    
    res.status(201).json({
      success: true,
      data: {
        ...populatedRoom,
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 🚀 LEAN 최적화: 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate({
        path: 'creator',
        select: 'name email',
        options: { lean: true }
      })
      .populate({
        path: 'participants',
        select: 'name email',
        options: { lean: true }
      })
      .select('name hasPassword creator participants createdAt')
      .lean();

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      data: {
        ...room,
        password: undefined
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장 (수정이 필요하므로 lean() 사용 불가)
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const room = await Room.findById(req.params.roomId).select('+password');
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      const isPasswordValid = await room.checkPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();

      // 🚀 관련 캐시 무효화
      await Promise.all([
        CacheService.invalidateRoomInfo(req.params.roomId),
        CacheService.invalidateRoomParticipants(req.params.roomId),
        CacheService.invalidateRoomsListCache()
      ]);
    }

    // 🚀 업데이트된 방 정보를 캐시에서 가져오기
    const populatedRoom = await CacheService.getRoomInfo(req.params.roomId);

    // Socket.IO를 통해 참여자 업데이트 알림
    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        ...populatedRoom,
        password: undefined
      });
    }

    res.json({
      success: true,
      data: {
        ...populatedRoom,
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};