#!/usr/bin/env node

// find-primary-node.js - Primary 노드 찾고 데이터 초기화
require('dotenv').config();
const mongoose = require('mongoose');

async function findAndConnectToPrimary() {
  try {
    console.log('🎯 Primary 노드 찾고 데이터 초기화...');
    
    const originalUri = process.env.MONGO_URI;
    console.log('📡 원본 URI:', originalUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));
    
    // URI에서 호스트 정보 추출
    const uriMatch = originalUri.match(/mongodb(?:\+srv)?:\/\/([^\/]+)\/(.*)$/);
    if (!uriMatch) {
      throw new Error('MongoDB URI 형식을 파싱할 수 없습니다');
    }
    
    const hostPart = uriMatch[1];
    const dbAndOptions = uriMatch[2];
    
    // 사용자:비밀번호@호스트 형태에서 호스트 부분만 추출
    const atIndex = hostPart.lastIndexOf('@');
    const authPart = atIndex !== -1 ? hostPart.substring(0, atIndex + 1) : '';
    const hostsPart = atIndex !== -1 ? hostPart.substring(atIndex + 1) : hostPart;
    
    // 호스트들 분리
    const hosts = hostsPart.split(',').map(host => host.trim());
    
    console.log('🔍 Primary 노드 검색 중...');
    hosts.forEach((host, index) => {
      console.log(`   ${index + 1}. ${host}`);
    });
    
    let primaryNode = null;
    
    // 각 호스트에 연결하여 Primary 찾기
    for (const host of hosts) {
      console.log(`\n🔌 ${host} 테스트 중...`);
      
      try {
        // 개별 호스트로 직접 연결
        const singleHostUri = `mongodb://${authPart}${host}/${dbAndOptions}`;
        
        await mongoose.connect(singleHostUri, {
          maxPoolSize: 1,
          serverSelectionTimeoutMS: 3000,
          directConnection: true,
        });
        
        const db = mongoose.connection.db;
        
        // Primary 여부 확인
        try {
          const hello = await db.admin().command({ hello: 1 });
          
          if (hello.ismaster) {
            console.log(`   ✅ PRIMARY 발견!`);
            primaryNode = { host, uri: singleHostUri, db };
            break;
          } else {
            console.log(`   ❌ Secondary`);
          }
          
        } catch (adminError) {
          // admin 권한 없어도 쓰기 테스트
          try {
            const testCollection = db.collection('__primary_test__');
            await testCollection.insertOne({ test: true });
            await testCollection.deleteOne({ test: true });
            
            console.log(`   ✅ PRIMARY (쓰기 테스트로 확인)`);
            primaryNode = { host, uri: singleHostUri, db };
            break;
            
          } catch (writeError) {
            console.log(`   ❌ Secondary (쓰기 실패)`);
          }
        }
        
        await mongoose.disconnect();
        
      } catch (error) {
        console.log(`   ❌ 연결 실패: ${error.message}`);
      }
    }
    
    if (!primaryNode) {
      throw new Error('Primary 노드를 찾을 수 없습니다');
    }
    
    console.log(`\n🎯 Primary 노드 연결 성공: ${primaryNode.host}`);
    
    // Primary에서 데이터 초기화
    return await resetDataOnPrimary(primaryNode);
    
  } catch (error) {
    console.error('❌ Primary 연결 실패:', error);
    throw error;
  }
}

async function resetDataOnPrimary(primaryNode) {
  try {
    console.log('\n🗑️  Primary 노드에서 데이터 초기화 시작...');
    
    const db = primaryNode.db;
    const dbName = db.databaseName;
    
    console.log(`📂 데이터베이스: ${dbName}`);
    console.log(`🖥️  Primary 호스트: ${primaryNode.host}`);
    
    // 모든 컬렉션 확인
    const collections = await db.listCollections().toArray();
    console.log(`📋 발견된 컬렉션: ${collections.length}개`);
    
    if (collections.length === 0) {
      console.log('💭 삭제할 데이터가 없습니다.');
      return;
    }
    
    collections.forEach(col => console.log(`   - ${col.name}`));
    
    // 사용자 확인
    if (!process.argv.includes('--force')) {
      console.log('\n⚠️  경고: 모든 데이터가 영구적으로 삭제됩니다!');
      console.log('계속하려면 --force 옵션을 추가하세요:');
      console.log('node scripts/find-primary-node.js --force');
      return;
    }
    
    console.log('\n🚀 데이터 삭제 시작...');
    
    // 방법 1: 전체 데이터베이스 삭제 (가장 깔끔)
    try {
      console.log('🗑️  전체 데이터베이스 삭제 시도...');
      await db.dropDatabase();
      console.log('✅ 데이터베이스 완전 삭제 성공!');
      
      // 확인
      const remainingCollections = await db.listCollections().toArray();
      console.log(`📊 결과: ${remainingCollections.length}개 컬렉션 남음`);
      
      if (remainingCollections.length === 0) {
        console.log('🎉 데이터베이스가 완전히 초기화되었습니다!');
      }
      
    } catch (dropError) {
      console.log('⚠️  데이터베이스 삭제 실패, 개별 컬렉션 삭제 시도...');
      console.log(`오류: ${dropError.message}`);
      
      // 방법 2: 개별 컬렉션 삭제
      let deletedCount = 0;
      for (const collection of collections) {
        try {
          console.log(`   🔄 ${collection.name} 삭제 중...`);
          await db.collection(collection.name).drop();
          console.log(`   ✅ ${collection.name} 삭제 완료`);
          deletedCount++;
        } catch (colError) {
          console.log(`   ❌ ${collection.name} 삭제 실패: ${colError.message}`);
          
          // 컬렉션 삭제 실패 시 문서만 삭제
          try {
            const deleteResult = await db.collection(collection.name).deleteMany({});
            console.log(`   ⚠️  ${collection.name}: ${deleteResult.deletedCount}개 문서만 삭제`);
          } catch (docError) {
            console.log(`   ❌ ${collection.name}: 문서 삭제도 실패`);
          }
        }
      }
      
      console.log(`📊 결과: ${deletedCount}/${collections.length}개 컬렉션 삭제`);
    }
    
    console.log('\n✨ Primary 노드에서 데이터 초기화 완료!');
    console.log('💡 이제 애플리케이션을 재시작하여 새로 시작할 수 있습니다.');
    
  } catch (error) {
    console.error('❌ 데이터 초기화 실패:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Primary 연결 종료');
  }
}

// 빠른 실행 함수들
async function quickReset() {
  try {
    console.log('🚀 빠른 초기화 모드');
    await findAndConnectToPrimary();
    process.exit(0);
  } catch (error) {
    console.error('💥 초기화 실패:', error.message);
    process.exit(1);
  }
}

// CLI 처리
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
🎯 Primary 노드 데이터 초기화 도구

사용법:
  node scripts/find-primary-node.js --force    # Primary 찾고 데이터 삭제
  npm run db:reset:primary                     # package.json 스크립트로 실행
  
옵션:
  --force     확인 없이 즉시 삭제
  --help      이 도움말 표시

특징:
  ✅ 자동으로 Primary 노드 탐지
  ✅ 직접 연결로 권한 문제 해결  
  ✅ dropDatabase() 사용으로 완전 삭제
  ✅ 실패 시 대체 방법 자동 실행
`);
  process.exit(0);
}

if (require.main === module) {
  quickReset();
}

module.exports = { findAndConnectToPrimary, resetDataOnPrimary };