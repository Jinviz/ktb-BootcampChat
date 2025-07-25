#!/usr/bin/env node

// reset-database.js - MongoDB 데이터베이스 완전 초기화 스크립트
require('dotenv').config();
const mongoose = require('mongoose');

async function resetDatabase() {
  try {
    console.log('🔄 MongoDB 데이터베이스 초기화 시작...');
    
    // MongoDB 연결
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    
    console.log('✅ MongoDB 연결 성공');
    
    // 현재 데이터베이스 정보
    const db = mongoose.connection.db;
    const dbName = db.databaseName;
    console.log(`📂 현재 데이터베이스: ${dbName}`);
    
    // 모든 컬렉션 목록 가져오기
    const collections = await db.listCollections().toArray();
    console.log('📋 기존 컬렉션 목록:');
    collections.forEach(col => console.log(`   - ${col.name}`));
    
    if (collections.length === 0) {
      console.log('💭 삭제할 컬렉션이 없습니다.');
      return;
    }
    
    // 사용자 확인
    console.log('\n⚠️  경고: 모든 데이터가 영구적으로 삭제됩니다!');
    console.log('   - 사용자 계정');
    console.log('   - 채팅 메시지');
    console.log('   - 채팅방');
    console.log('   - 업로드된 파일 정보');
    console.log('   - 세션 정보');
    
    // 개발 환경에서는 바로 실행, 프로덕션에서는 추가 확인
    if (process.env.NODE_ENV === 'production') {
      console.log('\n🚨 프로덕션 환경입니다! 정말로 진행하시겠습니까?');
      console.log('계속하려면 "YES_DELETE_ALL_DATA"를 입력하세요:');
      
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise(resolve => {
        rl.question('> ', resolve);
      });
      rl.close();
      
      if (answer !== 'YES_DELETE_ALL_DATA') {
        console.log('❌ 초기화가 취소되었습니다.');
        return;
      }
    }
    
    console.log('\n🗑️  데이터베이스 초기화 진행...');
    
    // 방법 1: 전체 데이터베이스 삭제 (빠름)
    await db.dropDatabase();
    console.log('✅ 데이터베이스가 완전히 삭제되었습니다.');
    
    // 또는 방법 2: 개별 컬렉션 삭제 (세밀한 제어)
    /*
    let deletedCount = 0;
    for (const collection of collections) {
      try {
        await db.collection(collection.name).drop();
        console.log(`   ✅ ${collection.name} 삭제 완료`);
        deletedCount++;
      } catch (error) {
        if (error.code === 26) { // NamespaceNotFound
          console.log(`   ⚠️  ${collection.name} 이미 삭제됨`);
        } else {
          console.error(`   ❌ ${collection.name} 삭제 실패:`, error.message);
        }
      }
    }
    console.log(`✅ ${deletedCount}개 컬렉션이 삭제되었습니다.`);
    */
    
    // 완료 확인
    const remainingCollections = await db.listCollections().toArray();
    console.log(`\n📊 초기화 결과:`);
    console.log(`   - 삭제 전: ${collections.length}개 컬렉션`);
    console.log(`   - 삭제 후: ${remainingCollections.length}개 컬렉션`);
    
    if (remainingCollections.length === 0) {
      console.log('🎉 데이터베이스가 완전히 초기화되었습니다!');
    } else {
      console.log('⚠️  일부 컬렉션이 남아있습니다:');
      remainingCollections.forEach(col => console.log(`   - ${col.name}`));
    }
    
  } catch (error) {
    console.error('❌ 데이터베이스 초기화 실패:', error);
    throw error;
  } finally {
    // 연결 종료
    await mongoose.disconnect();
    console.log('🔌 MongoDB 연결이 종료되었습니다.');
  }
}

// 메인 실행
async function main() {
  try {
    await resetDatabase();
    console.log('\n✨ 초기화 완료! 새로 시작할 준비가 되었습니다.');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 초기화 실패:', error.message);
    process.exit(1);
  }
}

// CLI 인수 처리
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
${require('chalk').bold.cyan('MongoDB 데이터베이스 초기화 스크립트')}

사용법: node scripts/reset-database.js [옵션]

옵션:
  --help, -h          이 도움말 표시
  --force             확인 없이 즉시 삭제 (개발 환경 전용)
  --collections-only  데이터베이스는 유지하고 컬렉션만 삭제

환경변수:
  MONGO_URI          MongoDB 연결 URL

예시:
  node scripts/reset-database.js
  node scripts/reset-database.js --force
  NODE_ENV=development node scripts/reset-database.js --force

⚠️  주의: 이 작업은 되돌릴 수 없습니다!
`);
  process.exit(0);
}

// --force 옵션 처리
if (process.argv.includes('--force') && process.env.NODE_ENV !== 'production') {
  console.log('🚀 Force 모드: 확인 없이 즉시 삭제합니다...');
}

if (require.main === module) {
  main();
}

module.exports = { resetDatabase };
