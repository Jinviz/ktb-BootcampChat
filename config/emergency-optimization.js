// emergency-optimization.js - 부하테스트 중 긴급 최적화

// 1. Socket.IO 극한 제한
const EMERGENCY_SOCKET_CONFIG = {
  pingTimeout: 1800000,      // 30분 (재연결 완전 최소화)
  pingInterval: 900000,      // 15분
  maxHttpBufferSize: 2048,   // 4KB → 2KB로 더 축소
  transports: ['websocket'], // polling 완전 차단
  compression: false,
  perMessageDeflate: false,
  
  // 연결 수 강제 제한
  maxConnections: 5000,      // 6000 → 5000으로 제한
  connectTimeout: 3000,
  
  // 메모리 절약 설정
  allowEIO3: false,
  allowUpgrades: false,
  upgradeTimeout: 1000,
  destroyUpgrade: true,
  destroyUpgradeTimeout: 500
};

// 2. 메모리 극한 절약
const MEMORY_EMERGENCY_CONFIG = {
  // 메시지 로딩 최소화
  BATCH_SIZE: 1,             // 한 번에 1개만
  MESSAGE_LOAD_TIMEOUT: 500, // 0.5초로 단축
  MAX_RETRIES: 0,            // 재시도 완전 금지
  
  // 캐시 TTL 극한 단축
  USER_INFO_TTL: 10,         // 30초 → 10초
  ROOM_INFO_TTL: 5,          // 15초 → 5초
  MESSAGE_CACHE_TTL: 5,      // 캐시 거의 비활성화
  
  // 정리 간격 최소화
  CLEANUP_INTERVAL: 1000,    // 2초 → 1초
  SESSION_CLEANUP: 2000,     // 5초 → 2초
  FORCE_GC_PROBABILITY: 0.8  // 80% 확률로 강제 GC
};

// 3. 더 공격적인 임계점
const EMERGENCY_THRESHOLDS = {
  DISABLE_AI: 500,           // 800 → 500명
  DISABLE_FILES: 800,        // 1200 → 800명
  DISABLE_REACTIONS: 1200,   // 1800 → 1200명
  DISABLE_READ_STATUS: 1500, // 2200 → 1500명
  MESSAGE_RATE_LIMIT: 2000,  // 2800 → 2000명
  EMERGENCY_MODE: 2500,      // 3500 → 2500명
  SURVIVAL_MODE: 3000,       // 4500 → 3000명
  CRITICAL_MODE: 4000,       // 5500 → 4000명
  SHUTDOWN_MODE: 5000        // 새로 추가: 5000명에서 신규 연결 차단
};

// 4. MongoDB 연결 최소화
const MONGO_EMERGENCY_CONFIG = {
  maxPoolSize: 1,            // 풀 크기 1개로 고정
  serverSelectionTimeoutMS: 200,
  socketTimeoutMS: 3000,     // 5초 → 3초
  maxIdleTimeMS: 5000,       // 10초 → 5초
  minPoolSize: 0,
  maxConnecting: 1,
  heartbeatFrequencyMS: 600000, // 10분으로 늘림
  connectTimeoutMS: 2000,
  
  // 쓰기 성능 최우선
  retryWrites: false,
  writeConcern: { w: 0, j: false },
  readPreference: 'primaryPreferred'
};

// 5. Redis 연결 최적화  
const REDIS_EMERGENCY_CONFIG = {
  connectTimeout: 2000,      // 3초 → 2초
  commandTimeout: 1000,      // 2초 → 1초
  retryDelayOnFailover: 50,  // 100 → 50ms
  maxRetriesPerRequest: 2,   // 3 → 2회
  
  // 클러스터 최적화
  slotsRefreshTimeout: 1000, // 2초 → 1초
  slotsRefreshInterval: 5000, // 10초 → 5초
  clusterRetryDelayOnClusterDown: 200, // 500 → 200ms
  
  // 메모리 절약
  enableOfflineQueue: true,
  lazyConnect: true,
  keepAlive: true,
  family: 4
};

// 6. Express 미들웨어 최소화
const EXPRESS_EMERGENCY_CONFIG = {
  limit: '512kb',            // 1MB → 512KB
  compression: false,        // 압축 비활성화 (CPU 절약)
  etag: false,
  lastModified: false,
  maxAge: 0                  // 캐시 비활성화
};

module.exports = {
  EMERGENCY_SOCKET_CONFIG,
  MEMORY_EMERGENCY_CONFIG,
  EMERGENCY_THRESHOLDS,
  MONGO_EMERGENCY_CONFIG,
  REDIS_EMERGENCY_CONFIG,
  EXPRESS_EMERGENCY_CONFIG
};
