#!/usr/bin/env node

// fix-mongodb-connection.js - MongoDB Primary 연결 및 권한 문제 해결
require('dotenv').config();
const mongoose = require('mongoose');

async function fixMongoDBConnection() {
  try {
    console.log('🔍 MongoDB 연결 문제 진단 및 해결...');
    
    const originalUri = process.env.MONGO_URI;
    console.log('📡 원본 URI:', originalUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));
    
    // 1. 현재 연결로 기본 정보 확인
    console.log('\n1️⃣ 현재 연결 상태 확인...');
    
    await mongoose.connect(originalUri, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      readPreference: 'primaryPreferred' // Primary 우선 선택
    });
    
    const db = mongoose.connection.db;
    console.log(`   연결된 DB: ${db.databaseName}`);
    
    // 2. 현재 노드 정보 확인
    try {
      const hello = await db.admin().command({ hello: 1 });
      console.log(`   현재 노드 타입: ${hello.ismaster ? 'Primary' : 'Secondary'}`);
      
      if (hello.setName) {
        console.log(`   복제본 세트: ${hello.setName}`);
        console.log(`   Primary 노드: ${hello.primary || 'Unknown'}`);
        
        if (hello.hosts) {
          console.log('   모든 노드:');
          hello.hosts.forEach(host => {
            const isPrimary = host === hello.primary;
            console.log(`     - ${host} ${isPrimary ? '(Primary)' : '(Secondary)'}`);
          });
        }
      }
    } catch (error) {
      console.log('   ⚠️  노드 정보 확인 실패:', error.message);
    }
    
    await mongoose.disconnect();
    
    // 3. Primary 우선 연결 문자열 생성
    console.log('\n2️⃣ Primary 연결 문자열 생성...');
    
    const connectionOptions = [
      '?readPreference=primary',
      '?readPreference=primary&retryWrites=true',
      '?readPreference=primary&w=majority',
      '?readPreference=primary&retryWrites=true&w=majority&readConcern=majority'
    ];
    
    let successfulUri = null;
    let workingConnection = null;
    
    for (let i = 0; i < connectionOptions.length; i++) {
      const testUri = originalUri.includes('?') 
        ? originalUri + '&' + connectionOptions[i].substring(1)
        : originalUri + connectionOptions[i];
      
      console.log(`\n   옵션 ${i + 1} 테스트: ${connectionOptions[i]}`);
      
      try {
        await mongoose.connect(testUri, {
          maxPoolSize: 1,
          serverSelectionTimeoutMS: 5000,
        });
        
        const db = mongoose.connection.db;
        const hello = await db.admin().command({ hello: 1 });
        
        console.log(`     결과: ${hello.ismaster ? '✅ Primary' : '❌ Secondary'}`);
        
        if (hello.ismaster) {
          // Primary에 연결되었다면 데이터베이스 작업 권한 테스트
          try {
            const collections = await db.listCollections().toArray();
            console.log(`     컬렉션 조회: ✅ (${collections.length}개)`);
            
            // 테스트 컬렉션으로 쓰기 권한 확인
            const testCollection = db.collection('__connection_test__');
            await testCollection.insertOne({ test: true, timestamp: new Date() });
            await testCollection.deleteOne({ test: true });
            console.log('     쓰기 권한: ✅');
            
            successfulUri = testUri;
            workingConnection = { uri: testUri, options: connectionOptions[i] };
            break;
            
          } catch (writeError) {
            console.log('     쓰기 권한: ❌', writeError.message);
          }
        }
        
        await mongoose.disconnect();
        
      } catch (error) {
        console.log(`     연결 실패: ${error.message}`);
        try {
          await mongoose.disconnect();
        } catch (disconnectError)