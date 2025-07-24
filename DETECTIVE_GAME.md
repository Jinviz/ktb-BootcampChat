# 🕵️ Detective Minigame - 스티브 심문 게임

## 개요

2030년을 배경으로 한 사이버 범죄 수사 미니게임입니다. 플레이어는 수사관이 되어 시스템 장애를 일으킨 AI 용의자 '스티브'를 심문하여 자백을 받아내야 합니다.

## 🎮 게임 특징

### AI 기반 캐릭터
- **OpenAI GPT-4** 기반 동적 응답 생성
- **일관된 성격**: 회피적, 거만함, 기술적 전문용어 남발
- **상황 인식**: 증거 압박 수준에 따른 반응 변화

### 증거 수집 시스템
- **체계적 수사**: 6개 구역별 증거 발견 시스템
- **증거 데이터베이스**: 8가지 주요 증거와 세부 정보
- **힌트 시스템**: 막힐 때 도움을 제공하는 조사 힌트
- **진행 추적**: 발견한 증거와 수사 진행도 실시간 추적

### 게임 상태 관리
- **세션 추적**: 게임 진행 상황과 달성 기록 관리
- **성과 분석**: 효율성, 등급, 마일스톤 달성도 측정
- **통계 시스템**: 개인별 수사 성과와 글로벌 통계

## 🛠 기술 구조

### Backend (`backend/services/detectiveGame.js`)
```javascript
class DetectiveGameService {
  // 게임 상태 관리
  gameStates = new Map(); // userId -> gameState
  
  // 캐릭터 정의
  character = {
    name: '스모군',
    role: 'suspect',
    personality: 'evasive, arrogant, technical, defensive'
  };
}
```

### 주요 메서드
- `initializeGame(userId, roomId)` - 새 게임 세션 시작
- `processPlayerMessage(userId, message, evidence)` - 플레이어 메시지 처리
- `analyzeEvidence(evidenceList)` - 증거 분석 및 압박 수준 계산
- `generateAIResponse()` - OpenAI 기반 동적 응답 생성

### API 엔드포인트 (`backend/routes/api/detective.js`)
- `POST /api/detective/start` - 게임 시작
- `POST /api/detective/interrogate` - 심문 메시지 전송
- `GET /api/detective/status` - 게임 상태 확인
- `POST /api/detective/end` - 게임 종료

### Socket 이벤트 (`backend/sockets/chat.js`)
- `startDetectiveGame` - 게임 시작
- `detectiveInterrogate` - 실시간 심문
- `detectiveMessage` - 캐릭터 응답
- `detectiveGameComplete` - 게임 완료

### Frontend (`frontend/components/chat/DetectiveGame.js`)
- React 기반 채팅형 게임 인터페이스
- 실시간 캐릭터 무드 표시
- 증거 입력 시스템
- 게임 통계 및 결과 분석

## 🎯 게임 플레이 가이드

### 시작하기
1. 채팅방에서 **"탐정 게임"** 버튼 클릭
2. 게임 설명 모달에서 규칙 확인
3. **"게임 시작"** 버튼으로 심문 시작

### 심문 전략
```
효과적인 질문 예시:
- "@smokinggun 그날 밤에 정확히 뭘 하고 있었나요?"
- "@smokinggun Jenkins 파이프라인이 왜 우회되었나요?"
- "@smokinggun 프로덕션 브랜치에 직접 접근한 기록이 있습니다"

증거 제시 예시:
- "git push --force origin main 커맨드 실행 기록"
- "rm -rf /var/log/application/*.log 명령어 흔적"
- "프로덕션 서버 직접 접근 로그"
```

### 승리 조건
두 가지 핵심 증거를 **모두** 제시해야 스모군이 자백합니다:
1. **Force Push 증거**: `force push`, `git push --force`, `직접 프로덕션` 등
2. **로그 삭제 증거**: `log delete`, `로그 삭제`, `log wipe` 등

## 🧠 AI 응답 시스템

### 응답 생성 로직
```javascript
// 1. 증거 압박 수준 분석
const evidenceAnalysis = this.analyzeEvidence(evidenceList);

// 2. 응답 타입 결정
if (evidenceStrength > 60) {
  return this.generateHighPressureResponse(); // 사전 정의된 방어적 응답
} else {
  return await this.generateAIResponse(); // GPT-4 기반 동적 응답
}

// 3. 자백 조건 확인
if (hasForcePushEvidence && hasLogWipingEvidence) {
  return this.generateConfessionResponse(); // 게임 종료
}
```

### 캐릭터 성격 프롬프트
```
당신은 '스모군'이라는 AI 캐릭터입니다.
성격: 회피적, 거만함, 기술적 전문용어 남발, 방어적
직업: 15년 경력의 시니어 개발자
전문분야: 소프트웨어 엔지니어링, 시스템 관리, Git 운영

대화 규칙:
1. 항상 @smokinggun으로 시작하세요
2. 거만하고 방어적인 톤을 유지하세요
3. 기술적 전문용어를 많이 사용하세요
4. 다른 사람이나 시스템을 탓하세요
5. 절대 쉽게 죄를 인정하지 마세요
```

## 🎨 무드 시스템

캐릭터의 감정 상태를 시각적으로 표현:

| 무드 | 이모지 | 설명 | 발생 조건 |
|------|--------|------|-----------|
| `arrogant_introduction` | 😏 | 거만한 소개 | 게임 시작 시 |
| `arrogant_evasion` | 😏 | 거만한 회피 | 일반적인 응답 |
| `technical_evasion` | 💻 | 기술적 회피 | Git/코드 관련 질문 |
| `blame_shifting` | 👉 | 책임 전가 | Jenkins/다른 사람 탓 |
| `defensive_technical` | 🤓 | 방어적 기술론 | 증거 압박 시 |
| `defeated_confession` | 😰 | 패배한 자백 | 게임 승리 시 |

## 🔧 개발자 가이드

### 로컬 테스트
```bash
# Backend 테스트
cd backend
node test-detective-game.js

# 게임 세션 시작
curl -X POST http://localhost:8080/api/detective/start \
  -H "Content-Type: application/json" \
  -H "x-auth-token: YOUR_TOKEN" \
  -d '{"roomId": "test_room"}'

# 심문 메시지 전송
curl -X POST http://localhost:8080/api/detective/interrogate \
  -H "Content-Type: application/json" \
  -H "x-auth-token: YOUR_TOKEN" \
  -d '{
    "message": "@smokinggun 뭐 하고 있었나요?",
    "evidence": ["git push --force 기록"]
  }'
```

### 새로운 응답 패턴 추가
```javascript
// detectiveGame.js에서 새로운 키워드 기반 응답 추가
if (messageLower.includes('새로운키워드')) {
  return this.generateNewResponsePattern();
}
```

### 증거 시스템 확장
```javascript
// analyzeEvidence 메서드에서 새로운 증거 타입 추가
if (evidenceLower.includes('새로운증거')) {
  analysis.hasNewEvidenceType = true;
  analysis.evidenceStrength += 30;
}
```

## 🎪 확장 아이디어

### 추가 기능
- **다중 용의자**: 여러 AI 캐릭터 심문
- **시간 제한**: 제한 시간 내 자백 받기
- **힌트 시스템**: 증거 발견 도움말
- **난이도 조절**: 쉬움/보통/어려움 모드
- **리플레이**: 심문 과정 재생 기능

### 기술적 개선
- **음성 인식**: 음성으로 심문하기
- **감정 분석**: 플레이어 메시지 감정 분석
- **학습 시스템**: 게임 플레이 패턴 학습
- **다국어 지원**: 영어/일본어 버전

## 📊 게임 통계

게임 완료 후 제공되는 통계:
- **소요 시간**: 게임 시작부터 자백까지
- **메시지 수**: 주고받은 총 메시지 개수
- **증거 개수**: 제시한 증거 항목 수
- **성공률**: 자백 성공 여부
- **효율성**: 시간 대비 성과 점수

## 🐛 문제 해결

### 일반적인 문제
```javascript
// 1. AI 응답이 생성되지 않을 때
// Fallback to predefined responses
if (aiResponseFailed) {
  return this.generateDefaultEvasiveResponse();
}

// 2. 게임 상태가 초기화되지 않을 때
// Check game state existence
const gameState = this.gameStates.get(userId);
if (!gameState) {
  throw new Error('Game not initialized');
}

// 3. 증거 분석이 작동하지 않을 때
// Validate evidence format
if (!Array.isArray(evidenceList)) {
  evidenceList = [];
}
```

### 디버깅 팁
- 브라우저 개발자 도구에서 Socket.IO 이벤트 확인
- Backend 로그에서 AI 응답 생성 과정 추적
- `test-detective-game.js`로 서비스 로직 테스트

## 📝 라이센스 및 크레딧

- **AI 모델**: OpenAI GPT-4
- **실시간 통신**: Socket.IO
- **프론트엔드**: React + Bootstrap
- **백엔드**: Node.js + Express

---

**게임을 즐겨보세요! 스모군의 자백을 받아내는 것은 쉽지 않을 것입니다... 🕵️‍♂️**
