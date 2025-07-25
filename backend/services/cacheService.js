const redisClient = require('../utils/redisClient');
const User = require('../models/User');
const Room = require('../models/Room');

class CacheService {
  // TTL 설정 (초 단위)
  static TTL = {
    USER_INFO: 900,        // 30분
    ROOM_INFO: 600,         // 10분
    ROOM_LIST: 300,         // 5분
    ROOM_PARTICIPANTS: 300, // 5분
    USER_SEARCH: 300        // 5분
  };

  // 캐시 키 생성 헬퍼
  static getKey(type, ...params) {
    const keyMap = {
      USER_INFO: (userId) => `user:${userId}`,
      ROOM_INFO: (roomId) => `room:${roomId}`,
      ROOM_LIST: (page, sortField, sortOrder, search) => 
        `rooms:list:${page}:${sortField}:${sortOrder}:${search || 'all'}`,
      ROOM_PARTICIPANTS: (roomId) => `room:participants:${roomId}`,
      USER_SEARCH: (query, page, limit) => `search:users:${query}:${page}:${limit}`
    };
    
    return keyMap[type](...params);
  }

  // ===================
  // 1. 사용자 정보 캐싱
  // ===================
  
  static async getUserInfo(userId) {
    try {
      const cacheKey = this.getKey('USER_INFO', userId);
      
      // 캐시에서 조회
      let user = await redisClient.get(cacheKey);
      
      if (!user) {
        // DB에서 조회
        user = await User.findById(userId)
          .select('_id name email profileImage createdAt')
          .lean();
          
        if (user) {
          // 캐시에 저장
          await redisClient.setEx(cacheKey, this.TTL.USER_INFO, user);
          console.log(`[Cache] User info cached: ${userId}`);
        }
      } else {
        console.log(`[Cache] User info cache hit: ${userId}`);
      }
      
      return user;
    } catch (error) {
      console.error('Cache getUserInfo error:', error);
      // 캐시 실패 시 DB 직접 조회
      return await User.findById(userId)
        .select('_id name email profileImage createdAt')
        .lean();
    }
  }

  static async invalidateUserInfo(userId) {
    try {
      const cacheKey = this.getKey('USER_INFO', userId);
      await redisClient.del(cacheKey);
      console.log(`[Cache] User info invalidated: ${userId}`);
    } catch (error) {
      console.error('Cache invalidateUserInfo error:', error);
    }
  }

  static async updateUserInfoCache(userId, userData) {
    try {
      const cacheKey = this.getKey('USER_INFO', userId);
      await redisClient.setEx(cacheKey, this.TTL.USER_INFO, userData);
      console.log(`[Cache] User info updated: ${userId}`);
    } catch (error) {
      console.error('Cache updateUserInfoCache error:', error);
    }
  }

  // ===================
  // 2. 채팅방 정보 캐싱
  // ===================
  
  static async getRoomInfo(roomId) {
    try {
      const cacheKey = this.getKey('ROOM_INFO', roomId);
      
      // 캐시에서 조회
      let room = await redisClient.get(cacheKey);
      
      if (!room) {
        // DB에서 조회
        room = await Room.findById(roomId)
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
          .lean();
          
        if (room) {
          // 캐시에 저장
          await redisClient.setEx(cacheKey, this.TTL.ROOM_INFO, room);
          console.log(`[Cache] Room info cached: ${roomId}`);
        }
      } else {
        console.log(`[Cache] Room info cache hit: ${roomId}`);
      }
      
      return room;
    } catch (error) {
      console.error('Cache getRoomInfo error:', error);
      // 캐시 실패 시 DB 직접 조회
      return Room.findById(roomId)
      .populate({
        path: 'creator',
        select: 'name email profileImage',
        options: {lean: true}
      })
      .populate({
        path: 'participants',
        select: 'name email profileImage',
        options: {lean: true}
      })
      .select('name hasPassword creator participants createdAt')
      .lean();
    }
  }

  static async invalidateRoomInfo(roomId) {
    try {
      const cacheKey = this.getKey('ROOM_INFO', roomId);
      await redisClient.del(cacheKey);
      console.log(`[Cache] Room info invalidated: ${roomId}`);
    } catch (error) {
      console.error('Cache invalidateRoomInfo error:', error);
    }
  }

  static async updateRoomInfoCache(roomId, roomData) {
    try {
      const cacheKey = this.getKey('ROOM_INFO', roomId);
      await redisClient.setEx(cacheKey, this.TTL.ROOM_INFO, roomData);
      console.log(`[Cache] Room info updated: ${roomId}`);
    } catch (error) {
      console.error('Cache updateRoomInfoCache error:', error);
    }
  }

  // ===================
  // 3. 채팅방 목록 캐싱
  // ===================
  
  static async getRoomsList(page, pageSize, sortField, sortOrder, search) {
    try {
      const cacheKey = this.getKey('ROOM_LIST', page, sortField, sortOrder, search);
      
      // 캐시에서 조회
      let cachedData = await redisClient.get(cacheKey);
      
      if (!cachedData) {
        console.log(`[Cache] Room list cache miss: ${cacheKey}`);
        return null; // 캐시 미스 시 null 반환
      }
      
      console.log(`[Cache] Room list cache hit: ${cacheKey}`);
      return cachedData;
    } catch (error) {
      console.error('Cache getRoomsList error:', error);
      return null;
    }
  }

  static async setRoomsList(page, pageSize, sortField, sortOrder, search, data) {
    try {
      const cacheKey = this.getKey('ROOM_LIST', page, sortField, sortOrder, search);
      await redisClient.setEx(cacheKey, this.TTL.ROOM_LIST, data);
      console.log(`[Cache] Room list cached: ${cacheKey}`);
    } catch (error) {
      console.error('Cache setRoomsList error:', error);
    }
  }

  static async invalidateRoomsListCache() {
    try {
      console.log('[Cache] Starting room list cache invalidation...');
      
      // Redis SCAN으로 패턴 매칭된 모든 키 찾기 (완전 무효화)
      const client = await redisClient.ensureConnection();
      
      if (redisClient.useMock) {
        // Mock 클라이언트 사용 시 - 메모리에서 직접 삭제
        const mockStore = client._mockStore || new Map();
        const keysToDelete = [];
        
        for (const key of mockStore.keys()) {
          if (key.startsWith('rooms:list:')) {
            keysToDelete.push(key);
          }
        }
        
        keysToDelete.forEach(key => mockStore.delete(key));
        console.log(`[Cache] Mock - Room list cache invalidated: ${keysToDelete.length} keys`);
        return;
      }
      
      // 실제 Redis 클라이언트 사용 시
      try {
        // SCAN으로 패턴 매칭
        const keys = await client.keys('rooms:list:*');
        
        if (keys.length > 0) {
          // 배치로 삭제 (Redis 성능 최적화)
          const batchSize = 100;
          let deletedCount = 0;
          
          for (let i = 0; i < keys.length; i += batchSize) {
            const batch = keys.slice(i, i + batchSize);
            await client.del(...batch);
            deletedCount += batch.length;
          }
          
          console.log(`[Cache] Redis - Room list cache invalidated: ${deletedCount} keys`);
        } else {
          console.log('[Cache] No room list cache keys found to invalidate');
        }
        
      } catch (scanError) {
        console.warn('[Cache] SCAN failed, using fallback invalidation:', scanError.message);
        
        // SCAN 실패 시 폴백: 주요 조합만 무효화
        const fallbackKeys = [];
        const sortFields = ['createdAt', 'name', 'participantsCount'];
        const sortOrders = ['asc', 'desc'];
        const searchTerms = ['all', '', 'undefined', 'null'];
        
        // 첫 10페이지의 주요 조합들
        for (let page = 0; page < 10; page++) {
          for (const sortField of sortFields) {
            for (const sortOrder of sortOrders) {
              for (const search of searchTerms) {
                fallbackKeys.push(this.getKey('ROOM_LIST', page, sortField, sortOrder, search));
              }
            }
          }
        }
        
        await this.invalidateMultiple(fallbackKeys);
        console.log(`[Cache] Fallback invalidation completed: ${fallbackKeys.length} keys`);
      }
      
    } catch (error) {
      console.error('Cache invalidateRoomsListCache error:', error);
      
      // 최후의 수단: TTL 기반 만료 대기
      console.warn('[Cache] Using TTL-based expiration as fallback');
    }
  }

  // ===================
  // 4. 채팅방 참여자 캐싱
  // ===================
  
  static async getRoomParticipants(roomId) {
    try {
      const cacheKey = this.getKey('ROOM_PARTICIPANTS', roomId);
      
      // 캐시에서 조회
      let participants = await redisClient.get(cacheKey);
      
      if (!participants) {
        // DB에서 조회
        const room = await Room.findById(roomId)
          .populate({
            path: 'participants',
            select: 'name email profileImage',
            options: { lean: true }
          })
          .select('participants')
          .lean();
          
        if (room && room.participants) {
          participants = room.participants;
          // 캐시에 저장
          await redisClient.setEx(cacheKey, this.TTL.ROOM_PARTICIPANTS, participants);
          console.log(`[Cache] Room participants cached: ${roomId}`);
        }
      } else {
        console.log(`[Cache] Room participants cache hit: ${roomId}`);
      }
      
      return participants || [];
    } catch (error) {
      console.error('Cache getRoomParticipants error:', error);
      // 캐시 실패 시 DB 직접 조회
      const room = await Room.findById(roomId)
        .populate({
          path: 'participants',
          select: 'name email profileImage',
          options: { lean: true }
        })
        .select('participants')
        .lean();
      return room?.participants || [];
    }
  }

  static async invalidateRoomParticipants(roomId) {
    try {
      const cacheKey = this.getKey('ROOM_PARTICIPANTS', roomId);
      await redisClient.del(cacheKey);
      console.log(`[Cache] Room participants invalidated: ${roomId}`);
    } catch (error) {
      console.error('Cache invalidateRoomParticipants error:', error);
    }
  }

  // ===================
  // 5. 사용자 검색 캐싱
  // ===================
  
  static async getUserSearchResults(query, page, limit) {
    try {
      const cacheKey = this.getKey('USER_SEARCH', query, page, limit);
      
      // 캐시에서 조회
      let results = await redisClient.get(cacheKey);
      
      if (!results) {
        console.log(`[Cache] User search cache miss: ${query}`);
        return null;
      }
      
      console.log(`[Cache] User search cache hit: ${query}`);
      return results;
    } catch (error) {
      console.error('Cache getUserSearchResults error:', error);
      return null;
    }
  }

  static async setUserSearchResults(query, page, limit, results) {
    try {
      const cacheKey = this.getKey('USER_SEARCH', query, page, limit);
      await redisClient.setEx(cacheKey, this.TTL.USER_SEARCH, results);
      console.log(`[Cache] User search results cached: ${query}`);
    } catch (error) {
      console.error('Cache setUserSearchResults error:', error);
    }
  }

  // ===================
  // 유틸리티 메서드
  // ===================
  
  static async invalidateMultiple(keys) {
    try {
      if (keys.length > 0) {
        await Promise.all(keys.map(key => redisClient.del(key)));
        console.log(`[Cache] Multiple keys invalidated: ${keys.length}`);
      }
    } catch (error) {
      console.error('Cache invalidateMultiple error:', error);
    }
  }

  static async warmupUserCache(userId) {
    try {
      await this.getUserInfo(userId);
      console.log(`[Cache] User cache warmed up: ${userId}`);
    } catch (error) {
      console.error('Cache warmupUserCache error:', error);
    }
  }

  static async warmupRoomCache(roomId) {
    try {
      await Promise.all([
        this.getRoomInfo(roomId),
        this.getRoomParticipants(roomId)
      ]);
      console.log(`[Cache] Room cache warmed up: ${roomId}`);
    } catch (error) {
      console.error('Cache warmupRoomCache error:', error);
    }
  }
}

module.exports = CacheService;
