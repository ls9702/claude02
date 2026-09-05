# DS118 셀프호스팅 실시간 화이트보드

Excalidraw 를 임베드한 자체 호스팅 화이트보드. 관리자가 계정과 세션(보드)을 만들고 사용자를 할당하면,
사용자는 자신에게 할당된 세션의 페이지(그림판 / 시트)를 열어 함께 작업한다.

전체 스펙은 [`PLAN.md`](./PLAN.md) 참고. 현재 구현 단계는 **M6 — NAS 배포 산출물(컨테이너 · compose · 문서)**.
배포는 [`SETUP.md`](./SETUP.md), 운영은 [`OPERATIONS.md`](./OPERATIONS.md).

## 저장소 구조

```
backend/               Fastify 5 + better-sqlite3 (ESM TypeScript, dev 는 tsx / 빌드는 tsc)
  Dockerfile           app 이미지 (멀티스테이지, node:22-alpine, non-root)
frontend/              Vite 8 + React 19 + @excalidraw/excalidraw 0.18.1
room/                  excalidraw-room 릴레이 (업스트림 벤더링, MIT — `room/LICENSE`)
  Dockerfile           room 이미지
e2e/                   Playwright 시나리오 테스트
  tests/               dev 모드 E2E (`npm run e2e`)
  prod-tests/          프로덕션 모드 스모크 (`npm run e2e:prod`)
docker-compose.yml     NAS 배포 (app + room)
build-arm64.sh         PC 에서 arm64 크로스 빌드 → dist-images/*.tar
SETUP.md               NAS 배포 가이드 (DSM · 리버스 프록시 · 인증서)
OPERATIONS.md          운영 안내서 (계정 · 백업 · 업데이트 · 문제 해결)
```

## 빠른 시작

```bash
npm install                 # 워크스페이스 설치 + Excalidraw 폰트 자체 호스팅 복사
cp .env.example .env        # ADMIN_PASSWORD 를 반드시 채운다
npm run dev                 # backend(3001) + room(3002) + frontend(5173) 동시 실행
```

브라우저에서 <http://localhost:5173> 접속 → `ADMIN_USERNAME`/`ADMIN_PASSWORD` 로 로그인 →
비밀번호 변경 화면(최초 1회 강제) → 관리자 화면에서 사용자·세션 생성.

Vite dev 서버는 `/api`, `/files`, `/ws`, `/socket.io`(WebSocket 포함)를 백엔드(3001)로 프록시한다.
백엔드는 다시 `/socket.io` 를 room(3002)으로 프록시한다 — 브라우저는 릴레이에 직접 붙지 않는다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `npm run dev` | backend + room + frontend 동시 실행 |
| `npm run build` | backend·room(tsc) → `*/dist`, frontend(vite) → `frontend/dist` |
| `npm start` | 빌드된 백엔드 실행 (프로덕션에서 `frontend/dist` 도 서빙) |
| `npm run typecheck` | 모든 워크스페이스 `tsc --noEmit` |
| `npm test` | backend / frontend vitest |
| `npm run e2e` | Playwright E2E (백엔드·room·프론트를 임시 DATA_DIR 로 자동 기동) |
| `npm run e2e:prod` | **프로덕션 모드 스모크** — 빌드 산출물을 `NODE_ENV=production` 으로 서빙하며 CSP·사전 압축·캐시 헤더·자체 호스팅 폰트와 캔버스/이미지/협업/시트/AI 를 함께 확인한다 (포트 3901/3902/3903) |

## 환경변수

`.env.example` 참고.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3001` | 백엔드 포트 |
| `HOST` | `0.0.0.0` | 바인딩 주소 |
| `DATA_DIR` | `./data` | SQLite(`app.db`)와 업로드 파일 저장 위치 |
| `ADMIN_USERNAME` | `admin` | 부트스트랩 관리자 아이디 |
| `ADMIN_PASSWORD` | (없음) | **최초 기동 필수.** users 테이블이 비어 있을 때만 사용되며, 이 계정은 최초 로그인 후 비밀번호 변경이 강제된다 |
| `COOKIE_SECURE` | `false` | HTTPS 배포 시 `true` (세션 쿠키 `Secure`) |
| `TRUST_PROXY` | `false` | `X-Forwarded-For` 신뢰 여부. 기본값에서는 헤더를 무시하고 실제 소켓 주소를 `req.ip` 로 쓴다. **DSM 리버스 프록시 뒤에서는 `TRUST_PROXY=1`** (1홉 신뢰). 홉 수(`2`)나 신뢰할 IP/CIDR 목록(`127.0.0.1,10.0.0.0/8`)도 지정할 수 있다 |
| `PUBLIC_URL` | `http://localhost:5173` | 프론트 공개 주소 |
| `ROOM_URL` | `http://127.0.0.1:3002` | excalidraw-room 주소 (`/socket.io` 프록시 업스트림) |
| `FRONTEND_DIST` | `../frontend/dist` | 프로덕션 정적 파일 경로 (backend cwd 기준) |
| `GEMINI_API_KEY` | (없음) | **AI 검색 카드 (M4).** 비어 있으면 AI 기능 전체가 꺼진다(`/api/ai/ping` → `{ai:false}`, ✨ 버튼 없음). 키는 **서버에만** 있고 브라우저로 내려가지 않는다 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 호출할 Gemini 모델 |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | 업스트림 주소. E2E 는 `e2e/mock-gemini.mjs` 를 가리킨다 |
| `AI_RATE_LIMIT_PER_MIN` | `20` | AI 호출 분당 퓨즈 (사용자 무관 **전체 합**, 폭주 방지용) |
| `COMMENT_WS_PING_MS` | `30000` | 댓글 WebSocket ping 주기. pong 을 연속 2회 놓친 소켓은 서버가 끊는다 |
| `NODE_ENV` | `development` | `production` 이면 정적 서빙 + SPA fallback + CSP 활성화 |
| `APP_VERSION` | `dev` | `GET /api/health` 가 그대로 돌려준다. 배포 이미지 태그를 넣어 두면 지금 무엇이 도는지 알 수 있다 |
| `NODE_OPTIONS` | (없음) | 컨테이너에서 `--max-old-space-size` 로 V8 힙 상한을 `mem_limit` 아래에 둔다 (docker-compose.yml) |

## API 요약

모든 응답은 JSON, 오류는 `{ "error": { "code", "message" } }` (message 는 한국어).
인증은 httpOnly 세션 쿠키 `sid` (90일 슬라이딩 만료).

```
POST   /api/auth/login          {username,password} → {user}
POST   /api/auth/logout
GET    /api/auth/me             → {user}
POST   /api/auth/password       {currentPassword,newPassword}

GET    /api/admin/users                        POST   /api/admin/users
PATCH  /api/admin/users/:id                    DELETE /api/admin/users/:id
GET    /api/admin/sessions                     POST   /api/admin/sessions
PATCH  /api/admin/sessions/:id                 DELETE /api/admin/sessions/:id
PUT    /api/admin/sessions/:id/members/:userId DELETE /api/admin/sessions/:id/members/:userId
POST   /api/admin/backup        → VACUUM INTO data/backup/app-<ts>.db (최신 7개 유지)
GET    /api/admin/backup        → {backups:[...최신순], keep}

GET    /api/health              → {ok, db, room, uptime, version}  (인증 불필요, HEALTHCHECK 용)

GET    /api/sessions                    → 내게 할당된 세션 목록
GET    /api/sessions/:id                → {session, pages}
POST   /api/sessions/:id/pages          {name, type:'canvas'|'sheet'}
PUT    /api/sessions/:id/pages/order    {pageIds:[...]}
PATCH  /api/pages/:id                   {name}
DELETE /api/pages/:id
GET    /api/pages/:id/room              → {roomId, roomKey}   (세션 멤버에게만)

GET    /api/pages/:id/scene             → {elements, appState, version}
PUT    /api/pages/:id/scene             {elements, appState} → 서버 병합 결과
GET    /api/pages/:id/snapshots         POST /api/pages/:id/snapshots/:snapId/restore
PUT    /api/pages/:id/thumbnail         (image/png, ≤200KB)   GET /api/pages/:id/thumbnail

POST   /api/pages/:id/files             (multipart: fileId, mime, file — 파일당 ≤5MB)
POST   /api/pages/:id/files/exists      {ids:[...]} → {existing:[...]}   (협업 중 재업로드 방지)
GET    /files/:fileId                   → 이미지 바이너리 (페이지 접근 권한 필요)

GET    /api/pages/:id/comments          → {comments:[...]}   (`?includeResolved=1` 로 해결된 것도)
POST   /api/pages/:id/comments          {elementId?, x, y, body} → {comment}
PATCH  /api/comments/:id                {body?, resolved?, x?, y?} → {comment}
DELETE /api/comments/:id
POST   /api/comments/:id/replies        {body} → {reply}
DELETE /api/replies/:id

GET    /api/ai/ping                     → {ai:boolean}  (로그인 필수. 서버 키 + 내 계정의 ai_allowed)
POST   /api/ai/ask                      {pageId, prompt, grounding, context?} → **Gemini 응답 그대로**
GET    /api/admin/ai/stats              → {configured, model, rateLimitPerMin, daily:[{day,count}]}

GET    /ws/comments/:pageId             → 댓글 실시간 채널 (WebSocket, 쿠키 인증 + 페이지 권한)
ANY    /socket.io/*                     → room 릴레이 프록시 (로그인 필수, 폴링·WS 업그레이드 모두)
```

### 씬 병합 규칙

여러 클라이언트가 각자 전체 씬을 주기 저장하므로, `PUT /scene` 은 저장본과 들어온 씬을 **요소 단위로 병합**한다
(`backend/src/scenes/reconcile.ts`, 순수 함수 + 단위 테스트).

- `id` 로 매칭, `version` 이 큰 쪽 채택, 같으면 `versionNonce` 가 작은 쪽 채택 (Excalidraw `reconcileElements` 와 동일)
- 한쪽에만 있으면 포함, `isDeleted` 요소도 동일하게 버전 비교
- `appState` 는 공유 가능한 키(`viewBackgroundColor`, `gridSize`, `gridStep`, `gridModeEnabled`, `objectsSnapModeEnabled`, `name`)만 저장 — 뷰포트·선택 상태는 저장하지 않는다.
  같은 키 목록을 프론트(`frontend/src/canvas/appState.ts`)도 갖고 있어, 요소 변경 없이 배경색·그리드만 바뀌어도 저장이 걸린다
- 저장 20회마다 또는 5분 경과 시 스냅샷, 페이지당 최근 20개 유지

### 보안 관련 동작

- 로그인은 IP 당 분당 10회로 제한된다(초과 시 `429 rate_limited`). IP 는 `TRUST_PROXY` 설정을 따르므로,
  기본값에서는 `X-Forwarded-For` 를 바꿔가며 제한을 우회할 수 없다.
- 존재하지 않는 아이디로 로그인해도 더미 해시로 bcrypt 비교를 수행해 응답 시간이 비슷하다(계정 열거 방지).
- `must_change_password=1` 인 사용자는 `/api/auth/me`, `/api/auth/password`, `/api/auth/logout` 외의
  모든 `/api/*`·`/files/*` 요청에서 `403 must_change_password` 를 받는다(프론트는 이 코드를 보면 `/password` 로 이동).
- 관리자는 자기 자신을 삭제할 수 없고, 마지막 관리자의 삭제·강등도 차단된다.

### 이미지 파일 소유권

업로드한 파일은 `files(id, mime, size, path, …)` 한 행이고, 어느 페이지에서 쓰이는지는
`page_files(page_id, file_id)` 링크 테이블이 가진다. 같은 이미지를 여러 세션·페이지에 붙여도 파일은 하나만 저장되며,
접근 권한은 "그 파일과 링크된 페이지 중 하나라도 볼 수 있으면 허용"으로 판정한다.
페이지·세션을 삭제하면 링크가 사라지고, **링크가 0개가 된 파일만** DB 행과 디스크 파일이 함께 삭제된다
(씬에서 이미지 요소만 지운 경우에는 스냅샷 복원을 위해 링크를 끊지 않는다).

## 실시간 협업 (M2)

캔버스 페이지를 열면 자동으로 그 페이지의 룸에 참여하고, 페이지를 떠나면 자동으로 나간다.
시작/중지 버튼은 없다.

```
[브라우저 A] ─┐                     ┌─ /api, /files  → Fastify 라우트
              ├─ 같은 오리진(app) ──┤
[브라우저 B] ─┘                     └─ /socket.io    → @fastify/http-proxy → room(3002)
```

- **릴레이**: `room/` 은 업스트림 excalidraw-room 을 그대로 벤더링한 무상태 서버다
  (이벤트 이름·volatile 브로드캐스트·follow 룸 규칙 동일).
- **협업 클라이언트**: `frontend/src/collab/` 은 excalidraw.com 앱(`excalidraw-app/collab/`, MIT)을 포팅한 것이다.
  Firebase 저장/파일/링크 부분만 우리 API 로 갈아끼웠고, 프로토콜·타이밍 상수(`SYNC_FULL_SCENE_INTERVAL_MS`,
  `CURSOR_SYNC_TIMEOUT`, `INITIAL_SCENE_UPDATE_TIMEOUT`, `IDLE_THRESHOLD` …)는 업스트림 값을 유지한다.
- **룸 키**: URL 에 넣지 않는다. `GET /api/pages/:id/room` 이 세션 멤버에게만 내려주고,
  릴레이로 오가는 페이로드는 그 키로 AES-GCM 암호화한다 (`frontend/src/collab/encryption.ts`).
- **인증**: `/socket.io` 프록시는 HTTP 폴링과 WebSocket 업그레이드 **양쪽 모두** 세션 쿠키를 요구한다.
  `@fastify/http-proxy` 가 업그레이드 요청도 Fastify 라우터로 흘려보내므로 라우트 preHandler(`requireAuth`)가 그대로 돈다.
- **저장 경로는 하나다**: 모든 저장은 `Collab.saveScene()` 을 지난다. 편집이 멈추면 1.5초 디바운스로,
  편집이 계속되면 업스트림과 같은 20초 주기 스로틀로 저장하며, 탭을 숨기거나 페이지를 떠날 때 flush 한다.
- **이미지**: 새 이미지는 장변 2048px 로 줄여 `POST /api/pages/:id/files` 로 올린 뒤 요소 상태가 `saved` 로 바뀌고,
  그 브로드캐스트를 받은 상대가 `GET /files/:id` 로 내려받는다.
- **접속자**: Excalidraw 기본 아바타/커서 UI 를 쓰고, 상단 탭 바에 "접속 N명" 을 표시한다.
  발표자 따라가기는 Excalidraw 내장 `onUserFollow` 에 연결되어 있다.

## 오브젝트 댓글 (M3)

캔버스 위에 얹는 오버레이 레이어다 — **Excalidraw 본체는 건드리지 않는다**.

- **앵커**: 댓글은 요소(`elementId`)나 좌표에 붙는다. 요소 앵커의 핀 위치는 그 요소의 **우상단**(`x+width`, `y`)이라
  요소를 옮기거나 크기를 바꾸면 핀이 따라간다(`frontend/src/comments/anchor.ts`, 순수 함수 + 단위 테스트).
- **고아 댓글**: 앵커 요소가 삭제되면 핀은 **마지막 위치에 그대로 남고** "요소 삭제됨" 배지가 붙는다.
  이때 저장 좌표를 `PATCH /api/comments/:id {x,y}` 로 **한 번만** 갱신해, 다시 열어도 같은 자리에 뜬다.
  (요소가 움직일 때마다 저장하지는 않는다 — 위치는 언제나 요소에서 다시 계산한다.)
- **좌표 변환**: `sceneCoordsToViewportCoords` / `viewportCoordsToSceneCoords` 를 쓰고, 최신 `appState` 는
  Excalidraw `onChange` 에서 받는다. 줌·스크롤·요소 이동이 이어져도 재계산은 `requestAnimationFrame` 으로 프레임당 한 번이다.
- **작성**: "💬 댓글" 버튼을 누르면 오버레이가 캔버스를 덮어 클릭을 가로챈다(Excalidraw 로 내려가지 않는다).
  클릭 지점에 요소가 있으면(최상단 우선) 요소 앵커, 없으면 좌표 앵커가 된다. 저장·취소·ESC 로 모드가 풀린다.
  요소가 **회전**해 있으면 클릭 지점을 요소의 로컬 좌표계로 되돌려 판정하고, 핀도 회전한 우상단에 붙는다.
- **겹친 핀**: 화면에서 12px 안으로 겹치는 핀은 생성 순서대로 26px 씩 가로로 펼친다
  (`frontend/src/comments/cluster.ts`, 순수 함수 + 단위 테스트). 아래 핀도 항상 직접 누를 수 있다.
- **터치 기기**: `@media (pointer: coarse)` 에서 핀·댓글 모드·목록 버튼의 탭 타겟이 40px 이상이 된다(데스크톱 모양은 그대로).
- **실시간**: `/ws/comments/:pageId` (@fastify/websocket). 서버가 pageId 별 구독자를 들고 있다가
  `{type:'comment.created'|'comment.updated'|'comment.deleted'|'reply.created'|'reply.deleted', payload}` 를
  **발신자 포함** 같은 페이지 접속자에게 보낸다. 클라이언트는 끊기면 지수 백오프로 재접속하고, 다시 붙을 때 목록을 새로 읽는다.
  서버는 `COMMENT_WS_PING_MS`(기본 30초) 주기로 ping 을 보내고 pong 을 추적한다 — **연속 2회 놓친 소켓은 끊어**
  좀비 구독을 치운다(`backend/src/comments/heartbeat.ts`, 상태 기계는 순수 함수).
- **권한**: 읽기는 세션 멤버, 작성·답글은 멤버(잠긴 세션은 관리자만 — `403 session_locked`),
  본문 수정·삭제는 작성자 또는 관리자, **해결/해결 취소는 멤버 누구나(잠긴 세션에서도 허용)**.
- **배지**: 상단 바에 현재 페이지의 미해결 수(💬 N), 세션 목록 카드에 세션 전체의 미해결 수
  (`GET /api/sessions` 의 `unresolvedComments`, 서버 집계).

### upgrade 리스너 공존

`@fastify/websocket` 은 서버의 모든 WebSocket upgrade 를 가로채 Fastify 라우터로 흘려보내고,
`/socket.io` 프록시(`@fastify/http-proxy`)도 같은 일을 한다. 둘을 그대로 두면 하나의 upgrade 가 라우터에
두 번 들어가므로, `backend/src/comments/ws.ts` 가 `@fastify/websocket` 이 등록한 리스너를 감싸
**`/ws/*` 만** 처리하게 바꾼다(그 밖의 경로는 프록시가 가져가거나, 아무도 담당하지 않으면 소켓을 끊는다).

## AI 검색 카드 (M4)

질문을 하면 Gemini 가 답하고, 그 답을 **평범한 Excalidraw 요소 묶음**(카드)으로 캔버스에 넣는다.

- **키는 서버에만**: 브라우저는 `/api/ai/*` 만 부른다. 서버가 `GEMINI_API_KEY` 를 붙여 업스트림
  `generateContent` 를 호출하고 **응답을 그대로 전달**한다 — 응답 파싱은 프론트 한 곳(`frontend/src/ai/aiClient.ts`)에서만 한다.
- **3중 게이트**: 사용자 토글(`localStorage: whiteboard/ai-enabled`) **and** 서버에 키 있음 **and** `users.ai_allowed`.
  세 조건이 모두 참일 때만 ✨ 버튼이 나온다(`GET /api/ai/ping` 한 번으로 뒤 두 개를 확인).
- **권한**: `POST /api/ai/ask` 는 로그인 + `pageId` 접근 권한(`requirePageAccess`) + `ai_allowed` 를 모두 지나야 한다.
- **안전 장치**: 본문 64KB(413), 질문 500자·컨텍스트 2000자(400), 분당 퓨즈 `AI_RATE_LIMIT_PER_MIN`회(429 `rate`),
  업스트림 타임아웃 30초/클라이언트 35초, 업스트림 오류 본문은 400자로 잘라 전달(401·403 은 `auth` 로 구분).
- **형식 규약**: 검색 그라운딩(`google_search`)과 JSON 스키마는 함께 쓸 수 없으므로 카드 형식은 **프롬프트 규약**으로 얻는다 —
  서버가 고정한 `systemInstruction`("첫 줄 30자 이내 제목, 이어서 3~6개 불릿, 각 80자 이내, 한국어",
  `backend/src/ai/prompts.ts`). 프론트 파서(`parseCard`)는 규약을 어긴 답변도 **첫 문장을 제목, 나머지를 불릿**으로 폴백해
  반드시 카드를 만든다.
- **카드의 실체**: 둥근 사각형 + 제목·본문·출처 텍스트를 같은 `groupIds` 로 묶고 `customData.aiCard = {query, at, by}` 를 남긴
  일반 요소다(`frontend/src/ai/cardBuilder.ts` 가 배치를 계산하고 `insertCard.ts` 가 `convertToExcalidrawElements` 로 만든다).
  출처는 요소의 `link` 속성이라 클릭하면 열린다. **협업 동기화·저장·내보내기는 기존 경로가 그대로 처리한다 — AI 전용 저장 로직이 없다.**
- **저장하지 않는 것**: 질문과 답변. 시트를 닫으면 사라지고, 캔버스에 넣은 카드만 씬 데이터가 된다.
  서버는 `ai_calls_daily` 에 **호출 수만** 센다(관리자 화면 표시용).
- **관리자**: 사용자 표에서 계정별 AI 허용을 끄고 켤 수 있고, 사용자 탭 위에 서버 키 유무·모델·최근 7일 호출 수가 뜬다.

## Excalidraw 폰트 자체 호스팅

`@excalidraw/excalidraw` 는 기본적으로 폰트를 외부 CDN 에서 받는다. 외부 의존을 없애기 위해
`frontend/scripts/copy-excalidraw-assets.mjs` 가 postinstall/prebuild 에서
`node_modules/@excalidraw/excalidraw/dist/prod/fonts` → `frontend/public/excalidraw-assets/fonts` 로 복사하고,
`frontend/index.html` 최상단에서 `window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/"` 를 설정한다.
복사본은 저장소에 커밋하지 않는다(`.gitignore`). E2E 에 외부 요청이 없는지 검증하는 테스트가 있다.

업스트림은 `@font-face` 의 **두 번째 후보**로 언제나 CDN(esm.sh)을 덧붙인다(`ASSETS_FALLBACK_URL`, 하드코딩).
프로덕션 CSP 의 `font-src 'self' data:` 가 그 후보를 막으므로 브라우저 콘솔에
`Refused to load the font 'https://esm.sh/...'` 가 폰트 수만큼 찍히지만, **실제 폰트는 첫 번째 후보인
우리 오리진에서 받는다** — `npm run e2e:prod` 의 「폰트」 테스트가 `document.fonts.check()` 와
네트워크 요청으로 이를 확인한다. 자세한 내용은 `KNOWN_ISSUES.md` 19번.

## 테스트

```bash
npm run typecheck   # backend / frontend / e2e
npm test            # vitest (backend + frontend)
npm run e2e         # Playwright 시나리오 (dev 모드)
npm run e2e:prod    # 프로덕션 모드 스모크 (빌드 후 실행)
```

E2E 는 `e2e/.tmp/data` 를 비우고 백엔드(`ADMIN_PASSWORD=admin1234`)·room(3002)·가짜 Gemini(`e2e/mock-gemini.mjs`, 3003)·
Vite dev 서버(`VITE_E2E=1`)를 직접 띄운다. AI 시나리오는 진짜 Google 을 부르지 않는다 —
백엔드의 `GEMINI_BASE_URL` 이 모킹 서버를 가리키고 키는 `e2e-test-key` 다.
Chromium 은 `PLAYWRIGHT_BROWSERS_PATH` 에 미리 설치된 것을 사용한다.

`npm run e2e:prod` 는 배포 형태를 그대로 시험한다 — `node backend/dist/index.js` 를 `NODE_ENV=production`
으로 띄우고 SPA 도 그 서버가 서빙한다(Vite dev 서버 없음). 포트는 **3901/3902/3903**, 상태 디렉터리는
`e2e/.state-prod` 로 dev E2E(3001/3002/3003/5173)와 겹치지 않아 두 벌을 같은 머신에서 돌릴 수 있다.
프론트는 `npm run build:e2e`(= `vite build --mode e2e`)로 만든다 — **프로덕션 빌드에 테스트 훅만 남긴 것**이고,
배포 이미지는 언제나 평범한 `npm run build` 산출물이다.

## 배포 (M6)

NAS(Synology DS118 · DSM 7.2 · arm64 · RAM 1GB)에 컨테이너 두 개로 올린다.
자세한 절차는 **[SETUP.md](./SETUP.md)**, 운영은 **[OPERATIONS.md](./OPERATIONS.md)** 를 본다.

```bash
./build-arm64.sh        # PC 에서 arm64 크로스 빌드 → dist-images/*.tar
```

```
[브라우저] ──HTTPS──> [DSM 리버스 프록시] ──HTTP──> [app :3001] ──내부망──> [room :3002]
                       (WebSocket 프리셋)            SPA·API·WS·백업        협업 릴레이
```

- **이미지**: `backend/Dockerfile`(app) · `room/Dockerfile`(room). `node:22-alpine` 멀티스테이지,
  최종 이미지는 **non-root(uid 1000)** 이고 컴파일러·소스·프론트엔드 의존성이 들어가지 않는다.
  `HEALTHCHECK` 는 `/api/health`(app) · `/`(room) 를 본다.
- **정적 서빙**: 프론트 빌드 뒤 `frontend/scripts/precompress.mjs` 가 `*.br`/`*.gz` 를 만들고
  `@fastify/static` 의 `preCompressed` 가 그대로 흘려보낸다. 런타임 압축을 쓰지 않는 이유는
  DS118 의 CPU(1.4GHz A53)에서 요청마다 압축하는 비용이 그대로 지연이 되기 때문이다.
  해시가 붙은 자산은 `max-age=31536000, immutable`, `index.html` 은 `no-cache` 로 내려간다.
- **보안 헤더**: 프로덕션에서만 CSP 를 붙인다(`backend/src/security.ts`, KNOWN_ISSUES 5번).
  `index.html` 의 인라인 스크립트는 기동 시 계산한 **sha256 해시**로 허용하고 `'unsafe-inline'`/`'unsafe-eval'`
  은 열지 않는다.
- **정상 종료**: SIGTERM 을 받으면 새 연결을 막고 WebSocket 을 닫은 뒤 SQLite 를 닫는다(WAL 체크포인트).
  room 도 같은 처리를 한다.
- **백업**: `POST /api/admin/backup` → `VACUUM INTO data/backup/app-<ts>.db`, 최신 7개 유지.
  DSM 작업 스케줄러에서 curl 로 부르는 예시가 OPERATIONS.md 에 있다.
- **헬스**: `GET /api/health` → `{ok, db, room, uptime, version}`.
  릴레이가 죽어도 `ok` 는 참이다 — app 은 저장·댓글·시트·AI 를 계속 처리할 수 있고,
  여기서 unhealthy 로 떨어뜨리면 도커가 멀쩡한 app 을 재시작해 오히려 서비스가 끊긴다.

### 메모리 상한

`docker-compose.yml` 의 `mem_limit` 은 개발 PC(x86_64/glibc)에서 **프로덕션 빌드**로 잰 값에 여유를 붙였다.

| 상황 | app RSS | room RSS |
|---|---|---|
| 기동 직후(idle) | 100~113MB | 78~84MB |
| 5명 동시 편집(사람 속도, 90초) | 최대 140MB | 최대 84MB |
| 5명이 초당 수십 요소를 붓는 스트레스(60초, 최종 4,300요소) | 최대 372MB | 최대 99MB |

→ app `mem_limit 384m` / `mem_reservation 192m`, room `mem_limit 144m` / `mem_reservation 96m`.
`NODE_OPTIONS=--max-old-space-size`(app 256 / room 96)로 cgroup 이 죽이기 전에 GC 가 먼저 돌게 한다.
arm64/musl 인 NAS 에서는 값이 다를 수 있으므로 운영 첫 주에 Container Manager 의 컨테이너별 메모리를 확인한다
(SETUP.md 9번 체크리스트 10항).
