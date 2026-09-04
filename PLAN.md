# DS118 셀프호스팅 실시간 화이트보드 — 전체 스펙 (v3)

> **상태: 계획 확정, 구현 보류.** 사용자 검토 후 구현 시작 예정. (2026-09-04)

## Context

Figma처럼 사진·그림·개념도를 그릴 수 있는 웹 기반 실시간 화이트보드를 개인 NAS(Synology DS118)에서 소규모(동시 5명 이하)로 운영한다. 오픈소스 **Excalidraw**를 캔버스 엔진으로 쓰되, 요구 기능(로그인 유지, 사용자별 세션 할당, 세션 내 다중 페이지, 오브젝트 댓글, AI 검색 카드, 엑셀형 시트 페이지)은 순정 구성으로 불가능하므로 **`@excalidraw/excalidraw` npm 패키지를 임베드한 커스텀 래퍼 앱을 직접 개발**한다. 세션의 페이지는 **그림판(캔버스) 페이지와 시트(스프레드시트) 페이지 두 종류**를 섞어 만들 수 있다.

**확정된 결정사항**

| 항목 | 결정 |
|---|---|
| 하드웨어 | Synology DS118 — Realtek RTD1296 (ARMv8, 쿼드 A53 1.4GHz), RAM 1GB, DSM 7.0.1 → 7.2+ 업데이트 예정 |
| 도메인 | `draw.863ad.co.kr` + HTTPS |
| 동시 사용자 | 최대 5명 |
| 캔버스 엔진 | Excalidraw (MIT) — 패키지 임베드 + excalidraw.com 협업 코드 포팅 |
| 시트 엔진 | Fortune-sheet (MIT) — 수식·서식 지원, `onOp` 훅으로 자체 실시간 동기화 |
| AI 제공자 | Google Gemini (claude01 프로젝트와 동일 키·설계) |
| 개발 방식 | Opus 5 구현 → Sonnet 5 병렬 검증 → Opus 5 수정 → Fable 5 최종 검토 |

---

## 1. 시스템 개요

| 항목 | 내용 |
|---|---|
| 목적 | 실시간 협업 화이트보드 (손그림·도형·개념도·이미지·댓글·AI 검색 카드) + 엑셀형 시트 페이지(회비 장부 등) |
| 사용자 모델 | 관리자가 계정 발급·세션 개설·사용자를 세션에 할당. 사용자는 할당된 세션만 접근 |
| 클라이언트 | 웹 브라우저 (PC/태블릿/모바일, 펜 입력) |
| 서버 | DS118 Container Manager(도커, 커뮤니티 스크립트로 활성화), arm64 이미지 2개 |

---

## 2. 기능 스펙

### 2.1 캔버스 — Excalidraw 패키지 기본 제공 (개발 불필요)

| 분류 | 기능 |
|---|---|
| 글씨 | 텍스트 도구, 폰트 3종(손글씨/일반/코드), 도형 안 텍스트, 화살표 라벨, 한국어 UI |
| 그림 | 손그림, 도형(사각형/원/다이아몬드/선), 지우개, 스타일(굵기/색/채우기/투명도), 이미지 붙여넣기·드래그앤드롭·크롭, 자작 도형 라이브러리 |
| 확대/이동 | 무한 캔버스, 줌/팬, 핀치 줌, 펜/터치 입력 |
| 자석 기능 | 화살표 바인딩(도형에 자동 부착·추적), 오브젝트 스냅(정렬 가이드), 그리드 스냅, 엘보 화살표 |
| 기타 | 프레임, 그룹화, 정렬/분배, z-order, 잠금, Alt+방향키 순서도 생성, 레이저 포인터, 텍스트 검색, 다크 모드, 실행취소, PNG/SVG/.excalidraw 내보내기 |

- **자체 호스팅 필수 항목**: 패키지는 폰트를 외부 CDN에서 받으므로 `node_modules/@excalidraw/excalidraw/dist/prod/fonts`를 정적 경로에 복사하고 `window.EXCALIDRAW_ASSET_PATH`를 설정한다 (빌드 스크립트에 포함).
- **패키지 밖 기능(선택)**: Mermaid 변환은 `@excalidraw/mermaid-to-excalidraw` 별도 연결(반나절). 공개 라이브러리 탐색은 외부 사이트 연동이라 인터넷 연결 시에만 동작.

### 2.2 인증/계정 (신규 개발)

- 로그인 페이지 (ID/비밀번호, bcrypt 해시 저장), 로그아웃, 비밀번호 변경
- **로그인 유지**: httpOnly 세션 쿠키, 90일 슬라이딩 만료 — 한번 로그인한 기기는 로그아웃 전까지 유지
- 역할: 관리자 / 일반 사용자
- 관리자 초기 계정은 최초 기동 시 환경변수 `ADMIN_PASSWORD`로 부트스트랩, 이후 비밀번호 변경 강제

### 2.3 세션·페이지 관리 (신규 개발)

- **관리자**: 사용자 계정 생성/삭제, 세션(보드) 생성/삭제, **사용자 ↔ 세션 할당/해제**, 세션 읽기 전용 잠금(보관)
- **사용자**: 로그인 후 자신에게 할당된 세션 목록 → 클릭으로 진입, **세션 간 자유 전환** (A가 세션1·세션2에 할당되면 둘 다 이동 가능)
- **세션 내 다중 페이지**: 페이지 탭/사이드바로 전환, 추가/이름변경/삭제/순서변경, 페이지 썸네일(캔버스는 `exportToBlob`으로 생성해 저장 시 업로드)
- **페이지 타입 2종**: `canvas`(그림판, Excalidraw) / `sheet`(시트, Fortune-sheet). 페이지 추가 시 타입 선택, 탭에 타입 아이콘 표시. 한 세션에 두 타입을 자유롭게 섞을 수 있음 (예: 세션 "동호회" = 그림판 "행사 기획" + 시트 "회비 장부")
- 접근 제어: 할당되지 않은 세션은 목록에 안 보이고 URL 직접 접근도 서버에서 차단
- 세션 목록에 미해결 댓글 수 배지

### 2.4 실시간 협업 (excalidraw-room 재사용 + 협업 클라이언트 포팅)

- 페이지 단위 협업: 같은 페이지를 연 사용자끼리 실시간 동기화 (페이지당 룸 1개 자동 매핑)
- 참가자 커서·선택 영역·접속자 목록, 발표자 화면 따라가기(`onUserFollow`)
- **릴레이**: 업스트림 excalidraw-room을 그대로 사용 (무상태). 룸 키는 URL이 아닌 **페이지별 DB 저장 → 권한 있는 사용자에게만 API로 전달**
- **협업 클라이언트**: `@excalidraw/excalidraw` 패키지는 병합 유틸(`reconcileElements`, `restoreElements`, `getSceneVersion` 등)만 export하고, 실제 협업 로직(소켓·암호화·커서·씬 병합·파일 동기화, 약 700줄)은 excalidraw.com 앱 코드(`excalidraw-app/collab/`)에 있다 → **MIT 코드를 포팅**하고 Firebase 부분만 우리 API로 교체
- **이미지 동기화**: Excalidraw는 이미지를 요소와 별도의 `BinaryFiles`(fileId)로 관리 → 백엔드 파일 API(`/api/files/:fileId`, 페이지 소속 검증, 중복 방지, 크기 제한). 업로드 전 클라이언트에서 리사이즈(장변 2048px)
- **저장 충돌 방지**: 여러 클라이언트가 전체 씬을 주기 저장하면 덮어쓰기 발생 → 서버가 저장된 씬과 **요소 단위 버전(version/versionNonce)으로 병합** 후 저장하고 병합 결과를 응답 (excalidraw.com의 Firestore 트랜잭션 방식)

### 2.5 오브젝트 댓글 (신규 개발)

- 캔버스 요소(또는 좌표)에 **댓글 핀** 부착 — 요소 이동 시 핀도 따라감 (`sceneCoordsToViewportCoords`로 오버레이 위치 계산)
- 핀 클릭 → 스레드(대댓글), 작성자·시간, 해결(resolve) 처리
- 사이드바 댓글 목록, WebSocket 실시간 반영
- Excalidraw 캔버스 위 오버레이 레이어 + 백엔드 저장 (Excalidraw 본체 수정 없음)
- 요소 삭제 시 해당 댓글은 좌표 고정으로 전환 (고아 댓글 규칙)

### 2.6 AI 검색 카드 (claude01 "AI 도우미" 설계 이식, 신규 개발)

**목표**: 캔버스에서 질문을 입력하면 Gemini가 **웹 검색 기반으로 즉시 답을 찾고**, 결과를 **카드(제목 + 요약 불릿 + 출처 링크)** 로 캔버스에 넣는다.

**설계 원칙 (claude01 계승)**
- **API 키는 서버에만**: `GEMINI_API_KEY`는 앱 컨테이너 환경변수. 브라우저는 사용자별 "AI 사용" 토글만 저장
- **서버 프록시**: 브라우저 → `/api/ai/*` → Gemini `generateContent`. 로그인 쿠키 인증 + `pageId` 접근 권한 검사
- **노출 게이트**: 사용자 토글 ON **and** `GET /api/ai/ping → {ai:true}` (서버 키 보유) → 그때만 ✨ 버튼 표시. 관리자가 `users.ai_allowed`로 사용자별 차단 가능
- **답변은 저장하지 않음**: 시트를 닫으면 사라지고, 「캔버스에 추가」한 카드만 씬 데이터가 됨

**UI 흐름**
1. 캔버스 ✨ 버튼 또는 단축키 → 사이드 시트. 텍스트 요소를 선택한 상태면 그 텍스트가 질문에 프리필
2. 질문 입력 + Enter. 「검색 기반」 체크박스 **기본 ON** (끄면 모델 지식만으로 빠르고 싸게)
3. 로딩(검색 그라운딩은 수 초) → 미리보기 카드(제목·불릿·출처 링크·"Gemini · 검색 N건")
4. 「캔버스에 추가」 → 뷰포트 중앙(선택 요소가 있으면 그 옆)에 카드 생성. 「다시 묻기」 가능

**카드의 실체 = 일반 Excalidraw 요소 묶음**
- `convertToExcalidrawElements` 스켈레톤: 둥근 사각형 컨테이너 + 제목 텍스트 + 불릿 본문 + 출처별 링크 텍스트(`link` 속성 → 클릭 시 열림)
- 같은 `groupIds`로 묶고 `customData.aiCard = {query, at, by}` 마킹
- 이후 일반 요소이므로 편집·협업 동기화·저장·내보내기가 그대로 동작 — 추가 저장 로직 없음

**요청/응답 규약**
- `POST /api/ai/ask {pageId, prompt, grounding}` → 서버가 Gemini 페이로드 구성(`gemini-2.5-flash` 기본, 환경변수로 변경; `grounding`이면 `tools:[{google_search:{}}]`) → **업스트림 응답을 그대로 전달**, 파싱은 클라이언트 한 곳(`extractText`/`extractCitations`)
- 검색 그라운딩과 JSON 스키마는 동시 사용 불가 → 카드 형식은 **프롬프트 규약**("첫 줄 제목 30자 이내, 이어서 3~6개 불릿 각 80자 이내"). 파서는 관대하게: 규약 미준수 시 첫 문장을 제목, 나머지를 본문으로 폴백
- 출처는 `groundingMetadata`에서 제목+URL 최대 5개
- 프롬프트는 `frontend/src/ai/prompts.ts` 한 곳에서 생성(단위 테스트). 캡: 질문 500자, 선택 텍스트 컨텍스트 2000자

**비용·안전 장치**
- 서버 분당 퓨즈 전체 20회/분 (쿼터가 아니라 폭주 방지용), 본문 64KB 제한(413), 서버 타임아웃 30초/클라이언트 35초, 응답 캐시 없음
- 타입드 에러 6종(`unavailable | network | auth | rate | server | parse`) → 고정 한국어 메시지. 실패는 시트 안에서만 표시, 전역 상태·재시도 없음
- 관리자 화면에 일별 호출 수 표시(선택)

**claude01에서 재사용할 코드** (`/home/user/ls9702/claude01`, 읽기 전용 참고)
- `src/ai/aiClient.ts` — 에러 매핑, `extractText`/`extractCitations`, 타임아웃
- `src/ai/prompts.ts` — 프롬프트 빌더·캡 상수 패턴
- `server/ai.php` — 페이로드 구성, 퓨즈, 업스트림 에러 잘라내기(400자) → Fastify 라우트로 포팅
- `src/components/ai/AiAskSheet.tsx` — 시트 UI 골격

**비목표**: 이미지 검색 결과 삽입(그라운딩은 이미지 미반환), 대화 이력 저장, 스트리밍

### 2.7 시트 페이지 — 엑셀형 표 (신규 개발, Fortune-sheet 기반)

**목표**: 세션 안에 스프레드시트 페이지를 만들어 회비 수입·지출 같은 표 데이터를 여러 명이 함께 입력·조회한다.

**엔진 선택: Fortune-sheet (MIT, React 패키지 `@fortune-sheet/react`)**
- 제공 기능: 셀 편집, **수식(SUM/IF/VLOOKUP 등 내장 함수)**, 서식(글꼴·색·정렬·테두리·병합·숫자 형식), 행/열 삽입·삭제·숨김, 정렬·필터, 틀 고정, 조건부 서식, 데이터 유효성, 셀 코멘트, 여러 시트 탭
- 협업: `onOp` 콜백이 사용자 편집을 op 배열로 내보내고 `applyOp`으로 반영 → **우리 백엔드 WebSocket으로 릴레이**해 실시간 동기화 (excalidraw-room이 아닌 app 컨테이너 담당)
- 제외한 대안: Univer(핵심은 Apache-2.0이지만 **실시간 협업·xlsx 가져오기/내보내기가 유료 Pro**), Handsontable(상용 라이선스), jspreadsheet CE(기능 제한)

**회비 장부 템플릿 (페이지 생성 시 선택)**
- 열: 날짜 / 구분(수입·지출, 드롭다운 유효성) / 항목 / 금액 / 담당 / 메모
- 하단 자동 집계 수식: 수입 합계 · 지출 합계 · **현재 잔액** (`=SUMIF(구분,"수입",금액)-SUMIF(구분,"지출",금액)`)
- 두 번째 시트 탭 "월별 요약": 월별 수입/지출/잔액 (`SUMIFS`)
- 금액 열 원화 숫자 형식, 지출 행 조건부 서식(연한 빨강)
- 빈 시트로도 생성 가능 (범용 엑셀 용도)

**저장/동기화**
- 시트 전체 데이터(Fortune-sheet JSON)를 페이지 단위로 DB 저장(`sheets` 테이블), 버전 스냅샷은 캔버스와 동일 정책
- 실시간: 클라이언트 op → `/ws/sheet/:pageId` → 서버가 같은 페이지 접속자에게 브로드캐스트 + 서버 메모리 사본에 적용 → 주기(예: 5초)·마지막 접속자 이탈 시 DB 저장. 셀 단위 op라 충돌은 "마지막 op 승리"로 충분(5명 규모)
- 접속자 표시(누가 보고 있는지), 셀 선택 위치 공유는 선택 기능

**가져오기/내보내기**
- **xlsx 내보내기/가져오기**: SheetJS 커뮤니티판(Apache-2.0)으로 Fortune-sheet JSON ↔ xlsx 변환 (값·기본 서식·수식 문자열). 회비 정산 시 엑셀로 뽑아 공유하는 용도
- CSV 내보내기

**성능/용량**
- 시트 렌더링은 전부 브라우저에서 수행 → NAS 부담은 JSON 저장·op 릴레이뿐(무시할 수준)
- Fortune-sheet 번들은 시트 페이지를 열 때만 지연 로드(code splitting)해 그림판만 쓰는 사용자의 초기 로딩에 영향 없음
- 시트당 크기 상한(예: 5,000행) 안내 — 장부 용도로 충분

**리스크**: Fortune-sheet는 pre-1.0(API 변경 가능, 최근 커밋 빈도 낮음) → 버전 고정 + 저장 포맷을 우리 쪽 스키마로 한 번 감싸 저장(엔진 교체 시 마이그레이션 가능). 폴백 후보: Univer 오픈 코어 + 자체 동기화

### 2.8 저장/백업

- 페이지 자동 저장: 캔버스는 편집 중 주기 저장 + 이탈 시 저장(서버 병합, §2.4), 시트는 서버 사본을 주기 저장(§2.7)
- 버전 스냅샷: 페이지별 최근 N개 보관, 복원 가능
- 내보내기: PNG/SVG/.excalidraw (Excalidraw 기본)
- **백업**: 실행 중 DB 파일 복사는 손상 위험 → 백엔드 관리자 엔드포인트(또는 컨테이너 내 스케줄)가 `VACUUM INTO`로 정합성 있는 사본을 만들고, DSM Task Scheduler는 그 사본 + 업로드 파일 디렉터리만 외부로 복사

---

## 3. 아키텍처

```
[브라우저]
   │ HTTPS (draw.863ad.co.kr)
   ▼
[DSM 리버스 프록시]  TLS 종단 (DSM Let's Encrypt 자동 갱신), WebSocket 헤더 프리셋
   ├──> [app]  Node.js + Fastify + SQLite                                  (~120MB)
   │      정적 프론트 서빙(사전 압축·장기 캐시), 인증(세션 쿠키),
   │      사용자/세션/페이지/파일/댓글 API, 씬 병합 저장,
   │      댓글 WebSocket, 시트 op 릴레이 WebSocket, Gemini 프록시(/api/ai)
   └──> [excalidraw-room]  캔버스 실시간 릴레이 (무상태, 업스트림 그대로)     (~60MB)
```

- **컨테이너 2개, 합계 약 180MB** — DSM(300~400MB) 제외 여유 500~600MB 내
- **프론트엔드**: React + Vite + `@excalidraw/excalidraw` SPA, excalidraw.com 협업 코드 포팅, `@fortune-sheet/react`(시트 페이지에서만 지연 로드), SheetJS(xlsx 변환), 폰트 자체 호스팅, 빌드 시 brotli/gzip 사전 압축 (원격 사용자 체감 속도의 병목은 NAS CPU가 아니라 가정용 업로드 대역폭)
- **백엔드**: Fastify, better-sqlite3(arm64 prebuilt; 문제 시 Node 22+ `node:sqlite`로 대체), `@fastify/static`, `@fastify/websocket`, `@fastify/rate-limit`
- **DB 테이블**: users(ai_allowed 포함), sessions, session_members, pages(type: canvas|sheet, 룸 키·순서·썸네일), scenes(캔버스 스냅샷), sheets(시트 JSON 스냅샷), files, comments, comment_replies
- **빌드**: 모든 이미지는 PC에서 `docker buildx --platform linux/arm64` 크로스 빌드

---

## 4. 네트워크/보안

- `draw.863ad.co.kr` → 집 공인 IP, **443 + 80 포트포워딩** (80은 DSM Let's Encrypt HTTP-01 발급·갱신용)
- DSM 내장 리버스 프록시가 443 → app 컨테이너로 전달 (WebSocket 프리셋 적용). HTTPS 필수 — wss·클립보드 API가 요구
- 세션 쿠키: httpOnly + Secure + SameSite=Lax, 로그인 시도 rate limit
- DSM 관리 포트(5000/5001) 외부 비공개, DSM 방화벽은 443/80만 개방
- 업로드 크기 제한(백엔드), AI 프록시는 로그인·퓨즈·본문 크기 검사를 업스트림 호출 전에 수행

---

## 5. 사전 작업 (사용자 수행)

1. DSM 7.0.1 → 7.2+ 업데이트 (설정 백업 후)
2. SSH로 [007revad/ContainerManager_for_all_armv8](https://github.com/007revad/ContainerManager_for_all_armv8) 실행 → Container Manager 설치 (DS118 지원 명시), 패키지 자동 업데이트 제외 설정
3. `draw.863ad.co.kr` DNS A 레코드 + 공유기 443/80 포트포워딩
4. DSM 제어판에서 Let's Encrypt 인증서 발급 + 리버스 프록시 규칙 생성 (SETUP.md 가이드 예정)
5. `GEMINI_API_KEY`, `ADMIN_PASSWORD` 등 환경변수 준비

---

## 6. 저장소 산출물 구조

```
├── frontend/            # React+Vite+@excalidraw/excalidraw SPA
│   └── src/
│       ├── auth/        # 로그인, 세션 유지
│       ├── sessions/    # 세션 목록, 페이지 탭, 관리자 화면
│       ├── canvas/      # Excalidraw 래퍼, 저장/불러오기
│       ├── collab/      # excalidraw.com 협업 코드 포팅
│       ├── comments/    # 댓글 핀 오버레이, 스레드
│       ├── sheet/       # Fortune-sheet 래퍼, op 동기화, 장부 템플릿, xlsx 변환 (지연 로드)
│       └── ai/          # aiClient, prompts, AiAskSheet, cardBuilder (claude01 이식)
├── backend/             # Fastify + SQLite
│   └── src/ (auth, sessions, pages, scenes(병합), sheets(op 릴레이·저장), files, comments(WS), ai(Gemini 프록시·퓨즈), static)
├── room/                # excalidraw-room arm64 빌드 (업스트림 그대로)
├── e2e/                 # Playwright 테스트 (Sonnet 검증 에이전트용, 브라우저 2개 협업 시나리오)
├── docker-compose.yml   # app + room
├── build-arm64.sh       # 크로스 빌드 (폰트 복사·사전 압축 포함)
├── SETUP.md             # NAS 배포 가이드 (DSM 업데이트 → 도커 → 리버스 프록시·인증서 → 배포)
└── OPERATIONS.md        # 계정/세션 관리, 백업(VACUUM INTO), 업데이트, AI 키 설정
```

---

## 7. 개발 마일스톤

| 단계 | 내용 | 예상 |
|---|---|---|
| M1 | 백엔드 뼈대: 로그인(쿠키 유지), 사용자/세션/페이지 CRUD·할당, 파일 API / 프론트: 로그인·세션 목록·페이지 탭·캔버스 저장/불러오기, 폰트 자체 호스팅, E2E 골격 | 1주 |
| M2 | 실시간 협업: 협업 코드 포팅(Firebase → 우리 API), 페이지↔룸 매핑, 서버 측 병합 저장, 접속자 표시 | 1주 |
| M3 | 오브젝트 댓글: 핀 오버레이, 스레드, 실시간 반영 | 1주 |
| M4 | AI 검색 카드: Gemini 프록시 라우트·퓨즈, 시트 UI, 카드 요소 생성, 업스트림 모킹 E2E | 3~4일 |
| M5 | 시트 페이지: 페이지 타입 분기, Fortune-sheet 래퍼·지연 로드, op 릴레이 WS·서버 저장, 회비 장부 템플릿, xlsx/CSV 가져오기·내보내기 | 1주 |
| M6 | arm64 빌드, docker-compose, DSM 리버스 프록시·인증서, SETUP/OPERATIONS 문서 | 2~3일 |

총 개발 규모: **약 5.5주 (파트타임 기준)**

---

## 8. 개발 프로세스 — 모델 역할 분담

각 마일스톤을 아래 사이클로 진행한다 (메인 세션의 서브에이전트로 실행):

```
[Opus 5]  구현 — 마일스톤 단위로 코드 작성
    ↓
[Sonnet 5 × N]  검증 — 병렬로 영역별 테스트, 재현 절차 포함 버그 리포트
    ↓
[Opus 5]  버그 수정
    ↓
[Fable 5 (메인 세션)]  최종 검토 — 요구사항 충족·코드 리뷰, 커밋/푸시
```

- **Sonnet 검증 영역**: ①인증/로그인 유지 ②세션 할당·접근 차단 ③페이지 CRUD·전환·타입 분기 ④실시간 협업 동기화·이미지 ⑤댓글 ⑥AI 카드(업스트림 모킹) ⑦시트 동시 편집·장부 템플릿 수식·xlsx 내보내기
- 사이클 종료 조건: Sonnet 테스트 전원 통과 + Fable 검토 통과 → 다음 마일스톤

---

## 9. 검증 방법

1. **로컬**: `docker compose up` → 브라우저 2개(다른 계정)로 로그인 유지, 세션 할당·차단, 페이지 전환, 동시 편집·이미지 동기화, 댓글 실시간 반영, AI 카드 생성(모킹), 시트 동시 입력·잔액 수식 재계산·xlsx 내보내기 확인
2. **arm64**: buildx로 arm64 이미지 빌드 성공 + QEMU 기동 스모크 테스트
3. **NAS**: DS118 배포 후 HTTPS 접속, 재부팅 자동 기동, 5명 동시 편집 중 RAM 800MB 이하 확인
4. **백업/복원**: `VACUUM INTO` 사본을 새 볼륨에 복원해 무결성 확인

---

## 10. 리스크

| 리스크 | 대응 |
|---|---|
| Container Manager 비공식 설치 | DSM 메이저 업데이트 시 스크립트 재실행 절차를 SETUP.md에 기록 |
| RAM 1GB | 스냅샷 보관 수 제한, 이미지 리사이즈·크기 제한, 불필요한 DSM 패키지 중지 |
| Excalidraw 패키지 업그레이드 시 room 프로토콜 불일치 | 프론트·room 버전을 함께 고정 |
| Gemini 응답 형식 변경 | 파싱을 클라이언트 한 곳에 격리, 규약 미준수 시 전체 텍스트 폴백 |
| 검색 그라운딩 지연(수 초) | 로딩 표시 필수, 타임아웃 30/35초 |
| Fortune-sheet pre-1.0·유지보수 둔화 | 버전 고정, 저장 포맷을 자체 스키마로 감싸 엔진 교체 여지 확보, 폴백은 Univer 오픈 코어 |
| 시트 동시 편집 충돌 | 셀 단위 op "마지막 승리" (5명 규모에 충분), 서버가 op 순서 부여 |

---

## 11. 결정 이력 (검토한 대안과 제외 이유)

| 대안 | 결론 | 이유 |
|---|---|---|
| ExcaliDash (Excalidraw 대시보드) | 제외 | Node+SQLite 백엔드가 1GB ARM에 부담, arm64 이미지 미확인, 댓글·다중 페이지 없음 |
| AFFiNE | 제외 | RAM 2~3GB + Postgres/Redis 필요 |
| tldraw | 제외 | 2025.9 라이선스 변경으로 프로덕션 유료 |
| 순정 Excalidraw + Basic Auth | 폐기 | 로그인 유지·세션 할당·다중 페이지·댓글 불가 |
| nginx 컨테이너 + certbot | 제거 | DSM 리버스 프록시 + DSM Let's Encrypt로 대체, 컨테이너 3 → 2 |
| 릴레이를 백엔드에 통합 | 기각 | 60MB 절약보다 포팅한 협업 코드와의 프로토콜 호환이 중요 |
| Postgres | 기각 | SQLite로 충분, RAM 절약 |
| Univer (시트 엔진) | 제외 | 핵심은 Apache-2.0이나 실시간 협업·xlsx 가져오기/내보내기·차트가 유료 Pro |
| Handsontable / jspreadsheet CE | 제외 | 상용 라이선스 / 무료판 기능 제한 |
| 장부 전용 테이블(스프레드시트 아님) | 기각 | 가볍지만 "엑셀 기능" 요구를 못 채움 → 범용 시트 + 장부 템플릿으로 양쪽 충족 |
