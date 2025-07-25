#!/usr/bin/env node

// clean-all-data.js - MongoDB + 업로드 파일 완전 정리 스크립트
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs').promises;
const path = require('path');

async function cleanAllData() {
  try {
    console.log('🧹 전체 데이터 정리 시작...');
    
    // 1. MongoDB 초기화
    console.log('\n📂 MongoDB 데이터베이스 초기화...');
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
    });
    
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    
    if (collections.length > 0) {
      await db.dropDatabase();
      console.log(`✅ MongoDB: ${collections.length}개 컬렉션 삭제 완료`);
    } else {
      console.log('💭 MongoDB: 삭제할 데이터가 없습니다.');
    }
    
    await mongoose.disconnect();
    
    // 2. 업로드 폴더 정리
    console.log('\n📁 업로드 파일 정리...');
    const uploadsDir = path.join(__dirname, '../backend/uploads');
    
    try {
      const files = await fs.readdir(uploadsDir);
      let deletedFiles = 0;
      
      for (const file of files) {
        // .gitkeep 파일은 유지
        if (file === '.gitkeep') continue;
        
        const filePath = path.join(uploadsDir, file);
        const stat = await fs.stat(filePath);
        
        if (stat.isFile()) {
          await fs.unlink(filePath);
          deletedFiles++;
        } else if (stat.isDirectory()) {
          await fs.rmdir(filePath, { recursive: true });
          deletedFiles++;
        }
      }
      
      console.log(`✅ 업로드 폴더: ${deletedFiles}개 파일/폴더 삭제 완료`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('💭 업로드 폴더가 존재하지 않습니다.');
      } else {
        console.warn('⚠️  업로드 폴더 정리 실패:', error.message);
      }
    }
    
    // 3. 로그 파일 정리 (선택사항)
    console.log('\n📝 로그 파일 정리...');
    const logsDir = path.join(__dirname, '../backend/logs');
    
    try {
      const logFiles = await fs.readdir(logsDir);
      let deletedLogs = 0;
      
      for (const file of logFiles) {
        if (file.endsWith('.log')) {
          await fs.unlink(path.join(logsDir, file));
          deletedLogs++;
        }
      }
      
      console.log(`✅ 로그 파일: ${deletedLogs}개 파일 삭제 완료`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('💭 로그 폴더가 존재하지 않습니다.');
      } else {
        console.warn('⚠️  로그 파일 정리 실패:', error.message);
      }
    }
    
    // 4. Redis 캐시 정리 (선택사항)
    console.log('\n🔄 Redis 캐시 정리 시도...');
    try {
      const redisClient = require('../backend/utils/redisClient');
      await redisClient.initialize();
      
      if (!redisClient.useMock) {
        // Redis 전체 데이터 삭제 (주의!)
        const client = await redisClient.ensureConnection();
        await client.flushdb(); // 현재 DB만 삭제
        // await client.flushall(); // 모든 DB 삭제 (더 강력)
        console.log('✅ Redis 캐시 정리 완료');
      } else {
        console.log('💭 Redis Mock 모드 - 정리할 캐시가 없습니다.');
      }
    } catch (error) {
      console.warn('⚠️  Redis 정리 실패:', error.message);
    }
    
  } catch (error) {
    console.error('❌ 데이터 정리 실패:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('🧹 전체 시스템 데이터 정리를 시작합니다...');
    console.log('⚠️  경고: 다음 데이터가 모두 삭제됩니다:');
    console.log('   - MongoDB 모든 데이터');
    console.log('   - 업로드된 파일들');
    console.log('   - 로그 파일들');
    console.log('   - Redis 캐시');
    
    if (process.env.NODE_ENV === 'production') {
      console.log('\n🚨 프로덕션 환경에서는 이 스크립트를 실행하지 마세요!');
      process.exit(1);
    }
    
    if (!process.argv.includes('--force')) {
      console.log('\n계속하려면 --force 옵션을 추가하세요:');
      console.log('node scripts/clean-all-data.js --force');
      process.exit(0);
    }
    
    await cleanAllData();
    
    console.log('\n🎉 전체 데이터 정리가 완료되었습니다!');
    console.log('📝 이제 다음 작업을 할 수 있습니다:');
    console.log('   1. 서버 재시작');
    console.log('   2. 새로운 사용자 계정 생성');
    console.log('   3. 새로운 채팅방 생성');
    
    process.exit(0);
  } catch (error) {
    console.error('\n💥 정리 실패:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { cleanAllData };
