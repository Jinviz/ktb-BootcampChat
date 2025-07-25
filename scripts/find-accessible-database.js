#!/usr/bin/env node

// find-accessible-database.js - 접근 가능한 데이터베이스 찾고 데이터 삭제
require('dotenv').config();
const mongoose = require('mongoose');

async function findAccessibleDatabase() {
  try {
    console.log('🔍 접근 가능한 데이터베이스 찾는 중...');
    
    // Primary 노드에 연결
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      readPreference: 'primary',
      directConnection: false, // 복제본 세트 자동 발견 허용
    });
    
    console.log('✅ MongoDB 연결 성공');
    
    const client = mongoose.connection.getClient();
    const admin = client.db().admin();
    
    // 1. 모든 데이터베이스 목록 확인
    console.log('\n📂 데이터베이스 목록 확인...');
    try {
      const databases = await admin.listDatabases();
      console.log('발견된 데이터베이스:');
      databases.databases.forEach(db => {
        console.log(`   - ${db.name} (${(db.sizeOnDisk / 1024 / 1024).toFixed(2)} MB)`);
      });
      
      // 2. 각 데이터베이스별 접근 권한 테스트
      console.log('\n🔐 데이터베이스별 권한 테스트...');
      
      const accessibleDatabases = [];
      
      for (const dbInfo of databases.databases) {
        const dbName = dbInfo.name;
        
        // 시스템 DB는 건너뛰기
        if (['admin', 'local', 'config'].includes(dbName)) {
          console.log(`   ${dbName}: 🚫 시스템 DB (건너뛰기)`);
          continue;
        }
        
        try {
          const testDb = client.db(dbName);
          
          // 컬렉션 목록 조회 테스트
          const collections = await testDb.listCollections().toArray();
          console.log(`   ${dbName}: ✅ 읽기 가능 (${collections.length}개 컬렉션)`);
          
          if (collections.length > 0) {
            // 첫 번째 컬렉션에서 문서 수 확인
            const firstCollection = collections[0].name;
            const count = await testDb.collection(firstCollection).countDocuments();
            console.log(`     └─ ${firstCollection}: ${count.toLocaleString()}개 문서`);
            
            // 쓰기 권한 테스트
            try {
              const testCollection = testDb.collection('__write_test__');
              await testCollection.insertOne({ test: true, timestamp: new Date() });
              await testCollection.deleteOne({ test: true });
              console.log(`     └─ 쓰기 권한: ✅`);
              
              accessibleDatabases.push({
                name: dbName,
                collections: collections,
                canWrite: true,
                documentCount: count
              });
              
            } catch (writeError) {
              console.log(`     └─ 쓰기 권한: ❌ (${writeError.message})`);
              accessibleDatabases.push({
                name: dbName,
                collections: collections,
                canWrite: false,
                documentCount: count
              });
            }
          }
          
        } catch (accessError) {
          console.log(`   ${dbName}: ❌ 접근 불가 (${accessError.message})`);
        }
      }
      
      // 3. 접근 가능한 DB에서 데이터 삭제
      if (accessibleDatabases.length === 0) {
        console.log('\n😵 접근 가능한 데이터베이스가 없습니다.');
        console.log('💡 다음을 확인해주세요:');
        console.log('   - MongoDB 사용자 권한');
        console.log('   - 데이터베이스 이름 확인');
        console.log('   - 인증 정보 확인');
        return;
      }
      
      console.log('\n📋 데이터 삭제 가능한 데이터베이스:');
      const writableDatabases = accessibleDatabases.filter(db => db.canWrite);
      
      if (writableDatabases.length === 0) {
        console.log('😞 쓰기 권한이 있는 데이터베이스가 없습니다.');
        return;
      }
      
      writableDatabases.forEach(db => {
        console.log(`   ✅ ${db.name} (${db.collections.length}개 컬렉션, ${db.documentCount.toLocaleString()}개 문서)`);
      });
      
      // 4. 사용자 확인 후 데이터 삭제
      if (!process.argv.includes('--force')) {
        console.log('\n⚠️  경고: 위 데이터베이스의 모든 데이터가 삭제됩니다!');
        console.log('계속하려면 --force 옵션을 추가하세요:');
        console.log('node scripts/find-accessible-database.js --force');
        return;
      }
      
      console.log('\n🗑️  데이터 삭제 시작...');
      
      for (const dbInfo of writableDatabases) {
        console.log(`\n📂 ${dbInfo.name} 데이터베이스 처리 중...`);
        const targetDb = client.db(dbInfo.name);
        
        try {
          // 전체 데이터베이스 삭제 시도
          await targetDb.dropDatabase();
          console.log(`   ✅ ${dbInfo.name} 완전 삭제 성공!`);
          
        } catch (dropError) {
          console.log(`   ⚠️  DB 삭제 실패, 개별 컬렉션 삭제 시도...`);
          
          // 개별 컬렉션 삭제
          let deletedCollections = 0;
          for (const collection of dbInfo.collections) {
            try {
              console.log(`     🔄 ${collection.name} 삭제 중...`);
              
              // 컬렉션 드롭
              await targetDb.collection(collection.name).drop();
              console.log(`     ✅ ${collection.name} 삭제 완료`);
              deletedCollections++;
              
            } catch (colError) {
              // 컬렉션 삭제 실패 시 문서만 삭제
              try {
                const deleteResult = await targetDb.collection(collection.name).deleteMany({});
                console.log(`     ⚠️  ${collection.name}: ${deleteResult.deletedCount}개 문서만 삭제`);
              } catch (docError) {
                console.log(`     ❌ ${collection.name}: 완전 실패`);
              }
            }
          }
          
          console.log(`   📊 ${dbInfo.name}: ${deletedCollections}/${dbInfo.collections.length}개 컬렉션 처리`);
        }
      }
      
      console.log('\n🎉 데이터 삭제 완료!');
      
    } catch (listError) {
      console.log('❌ 데이터베이스 목록 조회 실패:', listError.message);
      
      // admin 권한 없을 때 대체 방법
      console.log('\n🔄 대체 방법: 일반적인 DB 이름들 테스트...');
      
      const commonDbNames = [
        'test',
        'chat', 
        'bootcampchat',
        'bootcampChat',
        'ktb-chat',
        'ktbchat',
        'chatapp',
        'app'
      ];
      
      for (const dbName of commonDbNames) {
        try {
          console.log(`\n🔍 ${dbName} 테스트...`);
          const testDb = client.db(dbName);
          
          const collections = await testDb.listCollections().toArray();
          
          if (collections.length > 0) {
            console.log(`   ✅ 발견! ${collections.length}개 컬렉션`);
            collections.forEach(col => console.log(`     - ${col.name}`));
            
            if (process.argv.includes('--force')) {
              console.log(`   🗑️  ${dbName} 데이터 삭제 중...`);
              
              try {
                await testDb.dropDatabase();
                console.log(`   ✅ ${dbName} 완전 삭제 성공!`);
              } catch (dropError) {
                // 개별 컬렉션 삭제
                for (const col of collections) {
                  try {
                    await testDb.collection(col.name).drop();
                    console.log(`     ✅ ${col.name} 삭제`);
                  } catch (colError) {
                    const deleteResult = await testDb.collection(col.name).deleteMany({});
                    console.log(`     ⚠️  ${col.name}: ${deleteResult.deletedCount}개 문서 삭제`);
                  }
                }
              }
            }
          } else {
            console.log(`   💭 비어있음`);
          }
          
        } catch (dbError) {
          console.log(`   ❌ 접근 불가`);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ 처리 실패:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 연결 종료');
  }
}

// 실행
async function main() {
  try {
    await findAccessibleDatabase();
    process.exit(0);
  } catch (error) {
    console.error('💥 실패:', error.message);
    process.exit(1);
  }
}

if (process.argv.includes('--help')) {
  console.log(`
🔍 접근 가능한 데이터베이스 찾고 데이터 삭제

사용법:
  node scripts/find-accessible-database.js        # 권한 확인만
  node scripts/find-accessible-database.js --force # 데이터 삭제 실행

특징:
  ✅ 모든 DB 권한 자동 테스트
  ✅ 접근 가능한 DB만 처리  
  ✅ 읽기/쓰기 권한 개별 확인
  ✅ 안전한 삭제 (--force 필수)
`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { findAccessibleDatabase };
