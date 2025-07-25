#!/usr/bin/env node

// check-mongodb-status.js - MongoDB 연결 및 상태 확인
require('dotenv').config();
const mongoose = require('mongoose');

async function checkMongoDBStatus() {
  try {
    console.log('🔍 MongoDB 상태 확인 중...');
    console.log('📡 연결 URI:', process.env.MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));
    
    // MongoDB 연결
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 10000,
    });
    
    console.log('✅ MongoDB 연결 성공');
    
    const db = mongoose.connection.db;
    const admin = db.admin();
    
    // 1. 기본 정보
    console.log('\n📊 기본 정보:');
    console.log(`   데이터베이스: ${db.databaseName}`);
    
    // 2. 서버 상태 확인
    console.log('\n🖥️  서버 상태:');
    try {
      const serverStatus = await admin.command({ serverStatus: 1 });
      console.log(`   호스트: ${serverStatus.host}`);
      console.log(`   버전: ${serverStatus.version}`);
      console.log(`   업타임: ${Math.round(serverStatus.uptime / 3600)}시간`);
      console.log(`   연결 수: ${serverStatus.connections.current}/${serverStatus.connections.available}`);
    } catch (error) {
      console.log('   ⚠️  서버 상태 정보 조회 실패:', error.message);
    }
    
    // 3. 복제본 세트 상태 확인
    console.log('\n🔄 복제본 세트 상태:');
    try {
      const isMasterInfo = await admin.command({ isMaster: 1 });
      
      if (isMasterInfo.ismaster !== undefined) {
        console.log(`   현재 노드가 Primary: ${isMasterInfo.ismaster ? '✅ YES' : '❌ NO'}`);
        
        if (isMasterInfo.setName) {
          console.log(`   복제본 세트명: ${isMasterInfo.setName}`);
          console.log(`   Primary 노드: ${isMasterInfo.primary || 'N/A'}`);
          console.log(`   Secondary 노드들:`);
          (isMasterInfo.hosts || []).forEach(host => {
            const isPrimary = host === isMasterInfo.primary;
            console.log(`     - ${host} ${isPrimary ? '(Primary)' : '(Secondary)'}`);
          });
          
          // 복제본 세트 상세 상태
          try {
            const rsStatus = await admin.command({ replSetGetStatus: 1 });
            console.log('\n   복제본 세트 멤버 상태:');
            rsStatus.members.forEach(member => {
              const state = member.stateStr;
              const health = member.health === 1 ? '✅' : '❌';
              console.log(`     - ${member.name}: ${state} ${health}`);
            });
          } catch (rsError) {
            console.log('   ⚠️  복제본 세트 상세 정보 조회 실패:', rsError.message);
          }
          
        } else {
          console.log('   📝 단일 노드 (복제본 세트 아님)');
        }
      }
    } catch (error) {
      console.log('   ⚠️  복제본 세트 정보 조회 실패:', error.message);
    }
    
    // 4. 데이터베이스 권한 확인
    console.log('\n🔐 권한 확인:');
    try {
      const collections = await db.listCollections().toArray();
      console.log(`   컬렉션 조회: ✅ (${collections.length}개)`);
      
      // 쓰기 권한 테스트
      const testCollection = db.collection('__test_write_permission__');
      await testCollection.insertOne({ test: true, timestamp: new Date() });
      await testCollection.deleteOne({ test: true });
      console.log('   쓰기 권한: ✅');
      
      // 데이터베이스 삭제 권한 테스트 (위험하므로 테스트용 DB에서만)
      if (db.databaseName.includes('test') || db.databaseName.includes('dev')) {
        console.log('   삭제 권한: 🧪 테스트 가능 (개발/테스트 DB)');
      } else {
        console.log('   삭제 권한: ⚠️  프로덕션 DB - 테스트 안함');
      }
      
    } catch (error) {
      console.log('   ❌ 권한 확인 실패:', error.message);
    }
    
    // 5. 컬렉션 정보
    console.log('\n📋 컬렉션 정보:');
    try {
      const collections = await db.listCollections().toArray();
      if (collections.length === 0) {
        console.log('   📝 컬렉션이 없습니다.');
      } else {
        for (const collection of collections) {
          try {
            const count = await db.collection(collection.name).countDocuments();
            console.log(`   - ${collection.name}: ${count.toLocaleString()}개 문서`);
          } catch (countError) {
            console.log(`   - ${collection.name}: 개수 확인 실패`);
          }
        }
      }
    } catch (error) {
      console.log('   ⚠️  컬렉션 정보 조회 실패:', error.message);
    }
    
    // 6. 권장 사항
    console.log('\n💡 권장 사항:');
    
    try {
      const isMasterInfo = await admin.command({ isMaster: 1 });
      
      if (!isMasterInfo.ismaster && isMasterInfo.setName) {
        console.log('   ⚠️  현재 노드가 Primary가 아닙니다.');
        console.log('   🔄 Primary 노드로 연결하려면:');
        console.log(`      - Primary 주소: ${isMasterInfo.primary}`);
        console.log('      - 연결 문자열에 ?readPreference=primary 추가');
        console.log('      - 또는 Primary 노드 직접 연결');
      } else if (!isMasterInfo.setName) {
        console.log('   ✅ 단일 노드 - 모든 작업 가능');
      } else {
        console.log('   ✅ Primary 노드 - 모든 작업 가능');
      }
    } catch (error) {
      console.log('   ⚠️  권장사항 분석 실패');
    }
    
  } catch (error) {
    console.error('❌ MongoDB 상태 확인 실패:', error);
    
    if (error.message.includes('authentication')) {
      console.log('\n🔐 인증 관련 문제일 수 있습니다:');
      console.log('   - 사용자명/비밀번호 확인');
      console.log('   - 인증 데이터베이스 확인');
    } else if (error.message.includes('timeout')) {
      console.log('\n⏰ 연결 시간 초과:');
      console.log('   - 네트워크 연결 확인');
      console.log('   - 방화벽 설정 확인');
      console.log('   - MongoDB 서버 상태 확인');
    }
    