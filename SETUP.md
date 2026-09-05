# SETUP — Synology DS118 배포 가이드

DS118(DSM 7.2, ARMv8 1GB) 한 대에 이 앱을 올려 `https://draw.863ad.co.kr` 로 쓰는 절차다.
순서대로 하면 되고, 각 단계 끝의 **확인** 항목이 통과해야 다음으로 넘어간다.

메뉴 경로는 DSM 7.2 한국어 기준으로 적었다. 스크린샷 대신 정확한 메뉴 이름을 쓴다.

| 항목 | 값 |
|---|---|
| 도메인 | `draw.863ad.co.kr` |
| 컨테이너 | `whiteboard-app`(3001, 리버스 프록시 대상) · `whiteboard-room`(3002, 내부 전용) |
| 데이터 | NAS 의 `docker/whiteboard/data` (SQLite · 업로드 파일 · 백업) |
| 필요한 외부 포트 | 443(HTTPS), 80(Let's Encrypt 발급·갱신용) |

> **먼저 읽을 것**: 이 앱은 HTTPS 를 전제로 만들어져 있다(`COOKIE_SECURE=true`).
> 인증서·리버스 프록시(5·6단계)를 끝내기 전에 HTTP 로 접속하면 **로그인이 되지 않는다**.

---

## 1. DSM 7.2 로 업데이트

1. **제어판 → 업데이트 및 복원 → DSM 업데이트**
2. 업데이트 전에 **제어판 → 업데이트 및 복원 → 구성 백업** 으로 설정을 내려받아 둔다.
3. DSM 7.2 이상으로 올리고 재부팅한다.

**확인**: **제어판 → 정보 센터** 의 DSM 버전이 7.2 이상.

---

## 2. Container Manager 설치 (커뮤니티 스크립트)

DS118 의 RTD1296 은 시놀로지 패키지 센터에서 Container Manager 를 정식 지원하지 않는다.
[007revad/ContainerManager_for_all_armv8](https://github.com/007revad/ContainerManager_for_all_armv8)
스크립트로 설치한다. (이 스크립트는 DS118 지원을 명시하고 있다.)

1. **제어판 → 터미널 및 SNMP → 터미널 → SSH 서비스 활성화** 체크 → 적용
2. PC 에서 SSH 로 접속: `ssh <관리자계정>@<NAS주소>`
3. 스크립트를 내려받아 실행한다 (저장소 README 의 최신 절차를 따를 것):

   ```bash
   git clone https://github.com/007revad/ContainerManager_for_all_armv8.git
   cd ContainerManager_for_all_armv8
   sudo -i /volume1/<경로>/ContainerManager_for_all_armv8/container_manager_for_all_armv8.sh
   ```

   스크립트가 **패키지 센터에서 Container Manager 를 먼저 설치하라**고 하면 그대로 따른다.
4. 설치가 끝나면 **패키지 센터 → 설치됨 → Container Manager → 자동 업데이트 해제**.
   DSM 이 Container Manager 를 자동으로 갱신하면 이 패치가 풀려 도커가 죽는다.
   **패키지 센터 → 설정 → 자동 업데이트** 에서도 Container Manager 를 제외한다.
5. 보안을 위해 작업이 끝나면 **SSH 를 다시 끈다** (1번 화면에서 체크 해제).

**확인**: **Container Manager** 를 열었을 때 「개요/컨테이너/이미지/프로젝트」 탭이 모두 보이고
「이미지」 탭에서 오류가 나지 않는다.

---

## 3. PC 에서 arm64 이미지 빌드

NAS(1GB RAM)에서는 빌드하지 않는다. PC 에서 크로스 빌드해 tar 로 옮긴다.

```bash
git clone <이 저장소> && cd ds118-whiteboard
./build-arm64.sh
```

- 두 이미지(`ds118-whiteboard-app`, `ds118-whiteboard-room`)를 `linux/arm64` 로 빌드하고
  `dist-images/*.tar` 로 저장한다.
- 태그는 `<git short sha>-<YYYYMMDD>` 형식이다. 마지막에 출력되는 태그를 적어 둔다.
- 처음 빌드는 QEMU 에뮬레이션이라 **10~30분** 걸릴 수 있다. 두 번째부터는 캐시가 듣는다.
- 실패하면 스크립트가 원인별 힌트를 출력한다. 가장 흔한 것은 QEMU 미설치다:

  ```bash
  docker run --privileged --rm tonistiigi/binfmt --install arm64
  ```

**확인**: `dist-images/` 에 tar 두 개가 있고, `docker image ls | grep ds118-whiteboard` 에
같은 태그의 이미지가 두 개 보인다.

---

## 4. NAS 에 이미지·프로젝트 올리기

### 4-1. 폴더 만들기

**File Station** 에서 다음 구조를 만든다 (공유 폴더 `docker` 는 Container Manager 설치 시 생긴다).

```
docker/
└── whiteboard/
    ├── docker-compose.yml    ← 저장소의 파일을 그대로 올린다
    ├── .env                  ← .env.production.example 을 복사해 값을 채운 것
    └── data/                 ← 비워 둔다 (SQLite·업로드·백업이 여기 쌓인다)
```

### 4-2. data 폴더 권한

컨테이너는 **uid 1000(node)** 로 돌기 때문에 `data/` 를 그 사용자가 쓸 수 있어야 한다.
SSH 로 한 번만 실행한다(2단계에서 SSH 를 껐다면 잠시 다시 켠다):

```bash
sudo chown -R 1000:1000 /volume1/docker/whiteboard/data
```

> 이 단계를 빼먹으면 컨테이너가 기동 직후 `SQLITE_CANTOPEN` 으로 죽는다.

### 4-3. `.env` 작성

`.env.production.example` 을 복사해 최소한 아래를 채운다. (파일 이름은 반드시 `.env`)

```dotenv
ADMIN_PASSWORD=처음-로그인용-8자이상
COOKIE_SECURE=true
TRUST_PROXY=1
PUBLIC_URL=https://draw.863ad.co.kr
NODE_ENV=production
GEMINI_API_KEY=          # AI 를 쓰지 않으면 비워 둔다
APP_TAG=<3단계에서 적어 둔 태그>
ROOM_TAG=<3단계에서 적어 둔 태그>
```

### 4-4. 이미지 불러오기

1. `dist-images/*.tar` 두 개를 **File Station** 으로 NAS 에 올린다(아무 폴더나 좋다).
2. **Container Manager → 이미지 → 추가 → 파일에서 추가** 로 tar 를 하나씩 불러온다.

**확인**: 「이미지」 목록에 `ds118-whiteboard-app:<태그>` 와 `ds118-whiteboard-room:<태그>` 가 보인다.

### 4-5. 프로젝트 만들기

1. **Container Manager → 프로젝트 → 생성**
2. 프로젝트 이름: `whiteboard`
3. 경로: `docker/whiteboard` (4-1 에서 만든 폴더)
4. 소스: **기존 docker-compose.yml 사용**
5. 「다음」 → 웹 포털 설정은 **건너뛴다**(리버스 프록시는 6단계에서 직접 만든다)
6. 「완료」 → 프로젝트가 빌드/시작된다.

**확인**:
- 「컨테이너」 탭에 `whiteboard-app`, `whiteboard-room` 이 **실행 중**이고 상태가 `healthy` 다.
- NAS 안에서 헬스가 응답한다 (SSH 또는 DSM 의 텍스트 편집기 대신 브라우저로):
  `http://<NAS주소>:3001/api/health` → `{"ok":true,"db":"ok","room":"ok",...}`

---

## 5. DNS · 포트포워딩 · 인증서

### 5-1. DNS

도메인 등록기관(또는 DNS 서비스)에서 `draw.863ad.co.kr` 의 **A 레코드**를 집 공인 IP 로 만든다.
공인 IP 가 바뀌는 회선이면 **제어판 → 외부 액세스 → DDNS** 로 시놀로지 DDNS 를 함께 쓰거나,
도메인 쪽 DDNS 갱신을 설정한다.

### 5-2. 공유기 포트포워딩

| 외부 포트 | 내부 대상 | 용도 |
|---|---|---|
| 443 | NAS:443 | HTTPS 서비스 |
| 80 | NAS:80 | Let's Encrypt HTTP-01 발급·갱신 (**필수**) |

- **3001/3002 는 절대 열지 않는다.** 외부에서 오는 것은 443 뿐이다.
- DSM 관리 포트(5000/5001)도 열지 않는다.

**확인**: 외부망(휴대폰 LTE 등)에서 `http://draw.863ad.co.kr` 이 DSM 화면이라도 응답한다.

### 5-3. Let's Encrypt 인증서

1. **제어판 → 보안 → 인증서 → 추가 → 새 인증서 추가 → Let's Encrypt 에서 인증서 받기**
2. 도메인 이름: `draw.863ad.co.kr`, 이메일: 본인 주소, 주체 대체 이름: 비워 둠
3. 발급이 끝나면 **인증서 → 설정** 에서 `draw.863ad.co.kr` 서비스에 이 인증서를 지정한다.

**확인**: 인증서 목록에 만료일이 약 3개월 뒤인 항목이 생긴다. (DSM 이 자동 갱신한다 — 그래서 80 포트를 계속 열어 둔다.)

---

## 6. DSM 리버스 프록시 (WebSocket 포함)

### 6-1. WebSocket 헤더 프리셋 만들기

이 앱은 실시간 협업(socket.io)·댓글·시트·세션 이벤트에 **WebSocket** 을 쓴다.
DSM 의 리버스 프록시는 기본적으로 업그레이드 헤더를 전달하지 않으므로 프리셋을 만들어 붙인다.

1. **제어판 → 로그인 포털 → 고급 → 리버스 프록시 → 생성**
2. 「사용자 지정 헤더」 탭 → **생성 → WebSocket** 을 누른다.
   `Upgrade: $http_upgrade` 와 `Connection: $connection_upgrade` 두 줄이 자동으로 들어간다.
3. 같은 화면에서 아래 헤더도 추가한다(프록시 뒤에서 `Secure` 쿠키와 IP 별 rate limit 이 제대로 동작하려면 필요하다):

   | 헤더 이름 | 값 |
   |---|---|
   | `X-Forwarded-Proto` | `$scheme` |
   | `X-Real-IP` | `$remote_addr` |
   | `X-Forwarded-For` | `$proxy_add_x_forwarded_for` |

### 6-2. 규칙

같은 「생성」 화면의 「일반」 탭:

| 항목 | 값 |
|---|---|
| 설명 | `whiteboard` |
| **원본** 프로토콜 | `HTTPS` |
| 원본 호스트 이름 | `draw.863ad.co.kr` |
| 원본 포트 | `443` |
| HSTS 활성화 | 켬 (선택) |
| **대상** 프로토콜 | `HTTP` |
| 대상 호스트 이름 | `localhost` |
| 대상 포트 | `3001` |

저장한 뒤 규칙 목록에서 이 규칙을 선택 → **편집 → 사용자 지정 헤더** 에 6-1 의 헤더 네 줄이 들어 있는지 확인한다.

### 6-3. HTTP → HTTPS

**제어판 → 로그인 포털 → DSM → HTTP 연결을 HTTPS 로 자동 리디렉션** 을 켠다.
(Let's Encrypt 갱신용 `/.well-known/acme-challenge/` 는 DSM 이 알아서 예외 처리한다.)

**확인**: `https://draw.863ad.co.kr` 에서 로그인 화면이 뜨고, 브라우저 주소창에 자물쇠가 보인다.

---

## 7. DSM 방화벽

**제어판 → 보안 → 방화벽 → 규칙 편집**

| 순서 | 포트 | 소스 | 동작 |
|---|---|---|---|
| 1 | 443, 80 | 모두 | 허용 |
| 2 | 5000, 5001 | 내부망(예: 192.168.0.0/24) | 허용 |
| 3 | 전체 | 모두 | 거부 |

- 3001/3002 를 허용 목록에 넣지 않는다. 리버스 프록시는 NAS 내부에서 `localhost:3001` 로 붙으므로 방화벽과 무관하다.
- **제어판 → 보안 → 보호 → 자동 차단** 을 켜 두면 로그인 무차별 대입을 IP 단위로 막을 수 있다.

---

## 8. 최초 로그인과 비밀번호 변경

1. `https://draw.863ad.co.kr` 접속 → 아이디 `admin`, 비밀번호는 `.env` 의 `ADMIN_PASSWORD`
2. 로그인하면 **비밀번호 변경 화면으로 강제 이동**한다. 새 비밀번호(8자 이상)를 정한다.
   - 변경 전에는 다른 화면·API 가 서버에서 막힌다(프론트 라우팅에만 의존하지 않는다).
3. 이후 사용자 발급·세션 개설은 **OPERATIONS.md** 를 따른다.

---

## 9. 검증 체크리스트

배포 직후 아래를 한 번씩 확인한다. (○ 표시가 모두 채워져야 완료다)

| # | 항목 | 방법 | 기대 |
|---|---|---|---|
| 1 | HTTPS | `https://draw.863ad.co.kr` | 자물쇠 표시, 인증서 발급자 Let's Encrypt |
| 2 | 헬스 | `https://draw.863ad.co.kr/api/health` | `{"ok":true,"db":"ok","room":"ok",...}` |
| 3 | 로그인 유지 | 로그인 후 브라우저를 완전히 껐다 다시 열기 | 다시 로그인하지 않아도 된다 (세션 90일) |
| 4 | 협업 2명 | 서로 다른 기기(또는 시크릿 창)에서 같은 페이지를 연다 | 상단에 「접속 2명」, 한쪽 그림이 즉시 반대쪽에 보인다 |
| 5 | 이미지 | 캔버스에 사진을 붙여넣기 | 업로드되고 새로고침 후에도 보인다 |
| 6 | 댓글 | 도형을 「💬 댓글」 모드로 클릭해 글 남기기 | 핀이 생기고 다른 접속자 화면에도 즉시 뜬다 |
| 7 | 시트 | 「+ 페이지」 → 시트 → 회비 장부 | 표가 열리고 합계·잔액이 계산되어 보인다 |
| 8 | AI | 사용자 메뉴에서 「AI 도우미 사용」 켜기 → ✨ | 질문에 답이 오고 카드가 캔버스에 들어간다 (키가 있을 때만) |
| 9 | 재부팅 자동 기동 | DSM 재부팅 후 2~3분 대기 | 두 컨테이너가 스스로 다시 뜬다 (`restart: unless-stopped`) |
| 10 | 메모리 | **리소스 모니터 → 성능 → 메모리** 와 Container Manager 의 컨테이너별 메모리 | 두 컨테이너 합이 여유 안 (아래 참고) |
| 11 | 백업 | OPERATIONS.md 의 백업 절차를 한 번 수행 | `data/backup/app-*.db` 가 생긴다 |

### 10번(메모리) 보충

`docker-compose.yml` 의 상한은 **app 384MB · room 144MB** 다. 개발 PC(x86_64/glibc)에서 프로덕션
빌드로 잰 값에 여유를 붙인 것이라, arm64/musl 인 NAS 에서는 다를 수 있다.
운영 첫 주에 Container Manager 의 컨테이너별 메모리를 보고,

- 평소 사용에서 app 이 200MB 를 넘지 않으면 상한을 낮춰도 된다.
- 컨테이너가 알 수 없는 이유로 재시작된다면 상한에 걸려 OOM 으로 죽는 것이다 —
  **Container Manager → 컨테이너 → 세부 정보 → 로그**에 마지막 종료 사유가 남는다. 상한을 올린다.

---

## 문제가 생기면

증상별 대처는 **OPERATIONS.md 의 「문제 해결」** 에 모아 두었다. 가장 흔한 세 가지만 여기에 적는다.

- **로그인은 되는데 새로고침하면 풀린다** → `COOKIE_SECURE=true` 인데 HTTP 로 접속했거나,
  리버스 프록시에 `X-Forwarded-Proto` 헤더가 없다. 6-1 을 다시 본다.
- **다른 사람 그림이 실시간으로 안 보인다** → WebSocket 프리셋이 빠졌다. 6-1 을 다시 본다.
- **화면 우측 상단에 「실시간 협업 서버에 연결할 수 없습니다」** → room 컨테이너가 죽었다.
  Container Manager 에서 `whiteboard-room` 을 다시 시작한다.
