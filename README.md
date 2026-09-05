# DS118 셀프호스팅 실시간 화이트보드

Excalidraw 를 임베드한 자체 호스팅 화이트보드. 관리자가 계정과 세션(보드)을 만들고 사용자를 할당하면,
사용자는 자신에게 할당된 세션의 페이지(그림판 / 시트)를 열어 함께 작업한다.

전체 스펙은 [`PLAN.md`](./PLAN.md) 참고. 현재 구현 단계는 **M2 — 실시간 협업(excalidraw-room 릴레이 + 협업 클라이언트 포팅)**.

## 저장소 구조

```
backend/    Fastify 5 + better-sqlite3 (ESM TypeScript, dev 는 tsx / 빌드는 tsc)
frontend/   Vite 8 + React 19 + @excalidraw/excalidraw 0.18.1
room/       excalidraw-room 릴레이 (업스트림 벤더링, MIT — `room/LICENSE`)
e2e/        Playwright 시나리오 테스트
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
| `NODE_ENV` | `development` | `production` 이면 정적 서빙 + SPA fallback 활성화 |

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

## Excalidraw 폰트 자체 호스팅

`@excalidraw/excalidraw` 는 기본적으로 폰트를 외부 CDN 에서 받는다. 외부 의존을 없애기 위해
`frontend/scripts/copy-excalidraw-assets.mjs` 가 postinstall/prebuild 에서
`node_modules/@excalidraw/excalidraw/dist/prod/fonts` → `frontend/public/excalidraw-assets/fonts` 로 복사하고,
`frontend/index.html` 최상단에서 `window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/"` 를 설정한다.
복사본은 저장소에 커밋하지 않는다(`.gitignore`). E2E 에 외부 요청이 없는지 검증하는 테스트가 있다.

## 테스트

```bash
npm run typecheck   # backend / frontend / e2e
npm test            # vitest (backend + frontend)
npm run e2e         # Playwright 시나리오
```

E2E 는 `e2e/.tmp/data` 를 비우고 백엔드(`ADMIN_PASSWORD=admin1234`)·room(3002)·Vite dev 서버(`VITE_E2E=1`)를 직접 띄운다.
Chromium 은 `PLAYWRIGHT_BROWSERS_PATH` 에 미리 설치된 것을 사용한다.
