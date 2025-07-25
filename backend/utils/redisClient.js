// backend/utils/redisClient.js
const Redis = require('ioredis');
const { redisHost, redisPort } = require('../config/keys');

class MockRedisClient {
  constructor() {
    this.store = new Map();
    this.isConnected = true;
    console.log('Using in-memory Redis mock (Redis server not available)');
  }

  async connect() {
    return this;
  }

  async set(key, value, options = {}) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.store.set(key, { value: stringValue, expires: options.ttl ? Date.now() + (options.ttl * 1000) : null });
    return 'OK';
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expires && Date.now() > item.expires) {
      this.store.delete(key);
      return null;
    }
    
    try {
      return JSON.parse(item.value);
    } catch {
      return item.value;
    }
  }

  async setEx(key, seconds, value) {
    return this.set(key, value, { ttl: seconds });
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    const item = this.store.get(key);
    if (item) {
      item.expires = Date.now() + (seconds * 1000);
      return 1;
    }
    return 0;
  }

  async quit() {
    this.store.clear();
    console.log('Mock Redis connection closed');
  }
}

class RedisClient {
  constructor() {
    this.client = null;
    this.publisher = null;
    this.subscriber = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 3;
    this.retryDelay = 2000;
    this.useMock = false;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return this.client;
    }

    try {
      await this.connect();
      await this.setupPubSubClients();
      this.initialized = true;
      return this.client;
    } catch (error) {
      console.warn('Redis initialization failed, using mock client:', error.message);
      this.client = new MockRedisClient();
      this.publisher = new MockRedisClient();
      this.subscriber = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      this.initialized = true;
      return this.client;
    }
  }

  async setupPubSubClients() {
    if (this.useMock) return;

    try {
      if (redisHost.includes(',')) {
        // Cluster 모드
        const redisHosts = redisHost.split(',').map(host => {
          return { host: host.trim(), port: parseInt(redisPort) };
        });

        // Publisher 클라이언트 (명령어 전용) - 고성능 설정
        this.publisher = new Redis.Cluster(redisHosts, {
          redisOptions: {
            connectTimeout: 2000,      // 더 빠른 연결
            commandTimeout: 1500,      // 더 빠른 명령어 실행
            retryDelayOnFailover: 25,  
            maxRetriesPerRequest: 3,   // 재시도 줄임
            enableOfflineQueue: false,
            family: 4,
            keepAlive: true,
            enableAutoPipelining: true, // 파이프라이닝으로 성능 향상
            lazyConnect: false
          },
          enableOfflineQueue: false,
          retryDelayOnFailover: 25,
          retryDelayOnClusterDown: 200,
          maxRetriesPerRequest: 3,   // 빠른 실패
          scaleReads: 'master',      // Publisher는 master만 사용
          lazyConnect: false,
          
          // 고성능 클러스터 설정
          slotsRefreshTimeout: 500,
          slotsRefreshInterval: 3000,
          enableReadyCheck: false
        });

        // Subscriber 클라이언트 (구독 전용) - 안정성 우선
        this.subscriber = new Redis.Cluster(redisHosts, {
          redisOptions: {
            connectTimeout: 3000,
            commandTimeout: 2000,
            retryDelayOnFailover: 50,
            maxRetriesPerRequest: 5,   // 구독은 안정성 우선
            enableOfflineQueue: false,
            family: 4,
            keepAlive: true,
            enableAutoPipelining: false, // 구독에는 파이프라이닝 비활성화
            lazyConnect: false
          },
          enableOfflineQueue: false,
          retryDelayOnFailover: 50,
          retryDelayOnClusterDown: 300,
          maxRetriesPerRequest: 5,
          scaleReads: 'slave',       // Subscriber는 slave 사용 가능
          lazyConnect: false,
          
          // 안정성 우선 설정
          slotsRefreshTimeout: 1000,
          slotsRefreshInterval: 5000
        });

      } else {
        // Single Redis 모드
        this.publisher = new Redis({
          host: redisHost,
          port: redisPort,
          connectTimeout: 2000,
          commandTimeout: 2000,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 2,
          lazyConnect: false
        });

        this.subscriber = new Redis({
          host: redisHost,
          port: redisPort,
          connectTimeout: 2000,
          commandTimeout: 2000,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 2,
          lazyConnect: false
        });
      }

      // Publisher 이벤트 핸들러
      this.publisher.on('connect', () => {
        console.log('Redis Publisher connected');
      });

      this.publisher.on('error', (err) => {
        console.error('Redis Publisher error:', err.message);
      });

      // Subscriber 이벤트 핸들러
      this.subscriber.on('connect', () => {
        console.log('Redis Subscriber connected');
      });

      this.subscriber.on('error', (err) => {
        console.error('Redis Subscriber error:', err.message);
      });

      console.log('Redis Pub/Sub clients initialized successfully');

    } catch (error) {
      console.error('Redis Pub/Sub setup failed:', error);
      throw error;
    }
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    // Check if Redis configuration is available
    if (!redisHost || !redisPort) {
      console.log('Redis configuration not found, using in-memory mock');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }

    try {
      console.log('Attempting to connect to Redis...');

      // Redis Cluster 설정 체크
      if (redisHost.includes(',')) {
        console.log('Detected Redis Cluster configuration');

        const redisHosts = redisHost.split(',').map(host => {
          return { host: host.trim(), port: parseInt(redisPort) };
        });

        console.log('Redis Cluster hosts:', redisHosts);

        this.client = new Redis.Cluster(redisHosts, {
          redisOptions: {
            connectTimeout: 3000,      // 10초 → 3초로 단축
            commandTimeout: 2000,      // 10초 → 2초로 단축  
            retryDelayOnFailover: 25,  // 100ms → 25ms로 단축
            maxRetriesPerRequest: 5,   // 10 → 5로 줄임 (중요!)
            enableOfflineQueue: false, // 성능 최적화
            family: 4,
            keepAlive: true,
            lazyConnect: false,        // 즉시 연결
            
            // 클러스터 최적화 설정
            enableReadyCheck: false,   // 빠른 시작
            maxLoadBalancingConnectionAttempts: 3
          },
          enableOfflineQueue: false,   // 큐 비활성화
          retryDelayOnFailover: 25,    // 100ms → 25ms로 단축
          retryDelayOnClusterDown: 300, // 1000ms → 300ms로 단축
          maxRetriesPerRequest: 5,     // 10 → 5로 줄임
          scaleReads: 'slave',
          clusterRetryDelayOnClusterDown: 300,
          clusterRetryDelayOnFailover: 25,
          enableReadyCheck: false,     // 빠른 시작
          lazyConnect: false,          // 즉시 연결
          
          // 클러스터 토폴로지 최적화
          slotsRefreshTimeout: 1000,   // 슬롯 새로고침 1초
          slotsRefreshInterval: 5000,  // 5초마다 새로고침
          maxRetriesPerRequest: 5      // 명시적 설정
        });

        this.client.on('connect', () => {
          console.log('Redis Cluster Connected');
          this.isConnected = true;
          this.connectionAttempts = 0;
          this.useMock = false;
        });

        this.client.on('error', (err) => {
          console.error('Redis Cluster Error:', err.message);
          this.connectionAttempts++;

          if (!this.useMock && this.connectionAttempts >= this.maxRetries) {
            console.log('Max Redis reconnection attempts reached, switching to in-memory mock');
            this.client = new MockRedisClient();
            this.isConnected = true;
            this.useMock = true;
          }
        });

        this.client.on('node error', (err, node) => {
          const nodeInfo = node?.options ? `${node.options.host}:${node.options.port}` : 'unknown node';
          console.error(`Redis Node Error on ${nodeInfo}:`, err.message);
        });

        // 연결 테스트 (타임아웃 적용)
        const connectTimeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection timeout')), 15000); // 15초로 증가
        });

        await Promise.race([
          this.client.ping(),
          connectTimeout
        ]);

        console.log('Redis Cluster ping successful');

      } else {
        // 단일 Redis 모드
        console.log('Using single Redis instance');

        this.client = new Redis({
          host: redisHost,
          port: redisPort,
          connectTimeout: 2000,
          commandTimeout: 2000,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 2,
          lazyConnect: true
        });

        this.client.on('connect', () => {
          console.log('Redis Client Connected');
          this.isConnected = true;
          this.connectionAttempts = 0;
          this.useMock = false;
        });

        this.client.on('error', (err) => {
          console.error('Redis Client Error:', err.message);
          this.connectionAttempts++;

          if (this.connectionAttempts >= this.maxRetries && !this.useMock) {
            console.log('Switching to in-memory mock Redis');
            this.client = new MockRedisClient();
            this.isConnected = true;
            this.useMock = true;
          }
        });

        // 연결 테스트
        await this.client.ping();
        console.log('Redis ping successful');
      }

      this.isConnected = true;
      return this.client;

    } catch (error) {
      console.error('Redis connection failed:', error.message);
      console.log('Using in-memory mock Redis instead');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }
  }

  async ensureConnection() {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.client;
  }

  async set(key, value, options = {}) {
    try {
      const client = await this.ensureConnection();

      if (this.useMock) {
        return await client.set(key, value, options);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }
4
      return await client.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      const client = await this.ensureConnection();

      if (this.useMock) {
        return await client.get(key);
      }

      const value = await client.get(key);
      if (!value) return null;

      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  }

  async setEx(key, seconds, value) {
    try {
      const client = await this.ensureConnection();

      if (this.useMock) {
        return await client.setEx(key, seconds, value);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      // Redis Cluster에서는 setex (소문자) 사용
      return await client.setex(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis setEx error:', error);
      throw error;
    }
  }

  async del(key) {
    try {
      const client = await this.ensureConnection();
      return await client.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      const client = await this.ensureConnection();
      return await client.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      throw error;
    }
  }

  // Publisher 전용 메서드
  async getPublisher() {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.publisher || this.client;
  }

  // Subscriber 전용 메서드
  async getSubscriber() {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.subscriber || this.client;
  }

  // Pub/Sub 발행 (배치 처리 지원)
  async publish(channel, message) {
    try {
      const publisher = await this.getPublisher();
      const result = await publisher.publish(channel, message);
      return result;
    } catch (error) {
      console.error('Redis publish error:', error);
      throw error;
    }
  }

  // 배치 Hash 연산 (성능 최적화)
  async batchHashOperations(operations) {
    try {
      const client = await this.ensureConnection();
      const pipeline = client.pipeline();
      
      operations.forEach(op => {
        switch (op.type) {
          case 'hset':
            pipeline.hset(op.key, op.field, op.value);
            break;
          case 'hget':
            pipeline.hget(op.key, op.field);
            break;
          case 'hdel':
            pipeline.hdel(op.key, op.field);
            break;
        }
      });
      
      const results = await pipeline.exec();
      return results;
    } catch (error) {
      console.error('Redis batch hash operations error:', error);
      throw error;
    }
  }

  // Hash 연산 최적화 (hset)
  async hset(key, field, value) {
    try {
      const client = await this.ensureConnection();
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return await client.hset(key, field, stringValue);
    } catch (error) {
      console.error('Redis hset error:', error);
      throw error;
    }
  }

  // Hash 연산 최적화 (hget)
  async hget(key, field) {
    try {
      const client = await this.ensureConnection();
      const value = await client.hget(key, field);
      if (!value) return null;
      
      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      console.error('Redis hget error:', error);
      throw error;
    }
  }

  // Hash 연산 최적화 (hdel)
  async hdel(key, field) {
    try {
      const client = await this.ensureConnection();
      return await client.hdel(key, field);
    } catch (error) {
      console.error('Redis hdel error:', error);
      throw error;
    }
  }

  // Pub/Sub 구독
  async subscribe(channels) {
    try {
      const subscriber = await this.getSubscriber();
      if (Array.isArray(channels)) {
        await subscriber.subscribe(...channels);
      } else {
        await subscriber.subscribe(channels);
      }
      return subscriber;
    } catch (error) {
      console.error('Redis subscribe error:', error);
      throw error;
    }
  }
}

// Publisher 전용 메서드
RedisClient.prototype.getPublisher = async function() {
  if (!this.initialized) {
    await this.initialize();
  }
  return this.publisher || this.client;
};

// Subscriber 전용 메서드
RedisClient.prototype.getSubscriber = async function() {
  if (!this.initialized) {
    await this.initialize();
  }
  return this.subscriber || this.client;
};

// Pub/Sub 발행
RedisClient.prototype.publish = async function(channel, message) {
  try {
    const publisher = await this.getPublisher();
    const result = await publisher.publish(channel, message);
    return result;
  } catch (error) {
    console.error('Redis publish error:', error);
    throw error;
  }
};

// Hash 연산 최적화 (hset)
RedisClient.prototype.hset = async function(key, field, value) {
  try {
    const client = await this.ensureConnection();
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return await client.hset(key, field, stringValue);
  } catch (error) {
    console.error('Redis hset error:', error);
    throw error;
  }
};

// Hash 연산 최적화 (hget)
RedisClient.prototype.hget = async function(key, field) {
  try {
    const client = await this.ensureConnection();
    const value = await client.hget(key, field);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch (parseError) {
      return value;
    }
  } catch (error) {
    console.error('Redis hget error:', error);
    throw error;
  }
};

// Hash 연산 최적화 (hdel)
RedisClient.prototype.hdel = async function(key, field) {
  try {
    const client = await this.ensureConnection();
    return await client.hdel(key, field);
  } catch (error) {
    console.error('Redis hdel error:', error);
    throw error;
  }
};

// Pub/Sub 구독
RedisClient.prototype.subscribe = async function(channels) {
  try {
    const subscriber = await this.getSubscriber();
    if (Array.isArray(channels)) {
      await subscriber.subscribe(...channels);
    } else {
      await subscriber.subscribe(channels);
    }
    return subscriber;
  } catch (error) {
    console.error('Redis subscribe error:', error);
    throw error;
  }
};

const redisClient = new RedisClient();
module.exports = redisClient;