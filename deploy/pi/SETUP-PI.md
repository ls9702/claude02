# SETUP-PI — 라즈베리파이4 배포 가이드

라즈베리파이4 한 대에 이 앱을 올려 `https://draw.863ad.co.kr` 로 쓰는 절차다.
순서대로 하면 되고, 각 단계 끝의 **확인** 항목이 통과해야 다음으로 넘어간다.

NAS(DS118)에 올리는 절차는 저장소 루트의 [SETUP.md](../../SETUP.md) 에 따로 있다.
**앱 코드와 이미지는 완전히 같다** — 다른 것은 리버스 프록시뿐이다.
NAS 는 DSM 내장 리버스 프록시를 쓰고, Pi 는 **Caddy 컨테이너**가 그 자리를 대신한다.

| 항목 | 값 |
|---|---|
| 도메인 | `draw.863ad.co.kr` |
| 컨테이너 | `whiteboard-caddy`(80·443) · `whiteboard-app`(3001, 내부) · `whiteboard-room`(3002, 내부) |
| 데이터 | `deploy/pi/data` (SQLite · 업로드 파일 · 백업) |
| 필요한 외부 포트 | **A안**: 80·443 을 Pi 로 / **B안**: 없음(Cloudflare Tunnel) |
| 백업 | 매일 03:00 → NAS (`backup-to-nas.sh` + systemd 타이머) |

```
[브라우저] ──HTTPS(443)──> [caddy]  TLS 종단 · 자동 인증서 · WebSocket 통과
                              │ (도커 내부망, 호스트에 열리지 않음)
                              ├──> [app :3001]   SPA·API·WS·백업
                              └────────┬─────────
                                       └──> [room :3002]  캔버스 협업 릴레이
```

> **먼저 읽을 것**: 이 앱은 HTTPS 를 전제로 만들어져 있다(`COOKIE_SECURE=true`).
> 6·7단계(노출 방식·DNS)를 끝내기 전에 HTTP 로 접속하면 **로그인이 되지 않는다**.

---

## 0. 사전 확인 (Pi 에서)

Pi 에 모니터·키보드를 붙이거나 SSH 로 들어가서 아래를 순서대로 확인한다.
**여기서 하나라도 어긋나면 1단계(OS 재설치)로 간다.**

```bash
cat /proc/device-tree/model    # 예: Raspberry Pi 4 Model B Rev 1.4
free -h                        # 전체 RAM (2GB / 4GB / 8GB)
uname -m                       # ★ aarch64 여야 한다
lsblk                          # SD 카드 · USB SSD 확인
ip -4 a                        # 현재 IP 와 인터페이스(eth0/wlan0)
vcgencmd measure_temp          # 온도 (평상시 60도 이하가 좋다)
```

**확인**

| 항목 | 기준 | 아니면 |
|---|---|---|
| `uname -m` | **`aarch64`** | `armv7l` 이면 32비트 OS 다 → 1단계에서 **64-bit** 로 재설치. 이 앱의 이미지는 arm64 전용이라 32비트에서는 아예 돌지 않는다 |
| `free -h` | 2GB 이상 | 1GB 모델이면 app 384m + room 144m + Caddy 128m 이 빠듯하다. 가능하면 4GB 이상 |
| 모델 | Raspberry Pi 4 | Pi 3 은 A53 이라 DS118 과 비슷한 성능이 된다(가능은 하다) |

또 하나, **공유기1(메인) 관리 화면에서 지금 NAS 로 가 있는 포트포워딩 목록을 캡처해 둔다.**
A안(6단계)으로 갈 때 이 목록이 반드시 필요하다. DSM 의
**제어판 → 로그인 포털 → 고급 → 리버스 프록시** 목록도 같이 캡처한다 —
거기 적힌 **호스트명**들을 Caddyfile 로 옮겨야 NAS 서비스가 계속 외부에서 열린다.

---

## 1. OS 설치 (Raspberry Pi OS Lite 64-bit)

이미 64비트 OS 가 깔려 있고 잘 돌고 있으면 이 단계를 건너뛴다.

1. PC 에 **Raspberry Pi Imager** 를 설치한다.
2. OS 선택 → **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)** (Bookworm).
   데스크톱 버전은 RAM 을 200~400MB 더 먹는다. 서버로만 쓸 것이므로 Lite 로 한다.
3. 쓰기 전에 **설정(톱니바퀴)** 에서 미리 넣는다:
   - 호스트명: `whiteboard` (원하는 이름)
   - **SSH 사용** 체크 + 공개키 등록(권장) 또는 비밀번호
   - 사용자 이름·비밀번호 (아래 문서는 사용자 `pi` 기준)
   - Wi-Fi 는 넣지 않아도 된다 — **가능하면 유선**으로 붙인다
4. SD 카드에 쓰고 Pi 에 꽂아 부팅한 뒤 SSH 로 들어간다.
5. 기본 설정:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone Asia/Seoul     # 백업 타이머가 로컬 시간을 쓴다
sudo apt install -y curl rsync               # 백업 스크립트가 쓴다
# 보안 업데이트 자동 적용
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

**확인**: `uname -m` → `aarch64`, `timedatectl` 의 Time zone 이 `Asia/Seoul`.

---

## 2. Docker 설치

라즈베리파이는 도커 **공식 지원** 대상이라 설치 스크립트 한 줄이면 된다
(NAS 처럼 커뮤니티 스크립트를 쓸 필요가 없고, OS 업데이트로 깨질 일도 없다).

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
# 그룹 변경을 적용하려면 로그아웃했다 다시 들어오거나:
newgrp docker
```

**확인**

```bash
docker version          # Client/Server 둘 다 나와야 한다
docker compose version  # v2.x (「docker-compose」 가 아니라 「docker compose」)
docker run --rm hello-world
```

> `docker compose` 가 없다고 나오면 `sudo apt install -y docker-compose-plugin`.

---

## 3. 네트워크 — 공유기1 에서 Pi 에 DHCP 예약

Pi 를 공유기2(AiMesh 노드)에 붙여 두어도 **설정은 공유기1(메인)에서 한다.**
AiMesh 노드는 같은 서브넷을 브리지할 뿐이라, DHCP·포트포워딩은 전부 공유기1 이 관리한다.
**Pi 를 옮길 필요가 없다.**

1. Pi 의 MAC 주소를 적는다: `ip link show eth0` (유선) 또는 `wlan0` (무선)의 `link/ether`
2. 공유기1 관리 화면 → **LAN → DHCP 서버 → 수동 할당(예약)** 에 MAC ↔ 원하는 IP 를 등록
   (예: `192.168.1.50`). NAS 에 이미 예약이 걸려 있듯 Pi 에도 걸어 둔다.
3. Pi 를 재부팅하고 `ip -4 a` 로 그 IP 를 받았는지 확인한다.

**확인**: 재부팅 후에도 Pi 의 IP 가 예약한 값 그대로다.

> 가능하면 공유기1↔공유기2 를 **유선 백홀**로 잇는다. 무선 백홀이어도 동시 5명 규모의
> WebSocket 트래픽에는 충분하지만, 유선이면 지연이 눈에 띄게 안정된다.

---

## 4. 이미지 준비 — 두 가지 방법 중 하나

### 4-A. PC 에서 크로스 빌드 → Pi 로 전송 (RAM 2GB Pi 는 이쪽)

PC(도커 설치됨)에서:

```bash
git clone <저장소> whiteboard && cd whiteboard
./build-arm64.sh
# → dist-images/whiteboard-app-<TAG>.tar, whiteboard-room-<TAG>.tar
scp dist-images/whiteboard-*-<TAG>.tar pi@192.168.1.50:~/
```

Pi 에서:

```bash
docker load -i ~/whiteboard-app-<TAG>.tar
docker load -i ~/whiteboard-room-<TAG>.tar
docker image ls | grep whiteboard
```

### 4-B. Pi 에서 직접 빌드 (RAM 4GB 이상 권장, 10~20분)

```bash
git clone <저장소> ~/whiteboard
cd ~/whiteboard/deploy/pi
cp .env.example .env && vi .env          # 5단계를 먼저 하고 와도 된다
docker compose -f docker-compose.yml -f docker-compose.build.yml build
```

`docker-compose.build.yml` 은 빌드 컨텍스트를 저장소 루트로 잡아 주는 오버레이다.
빌드가 끝나면 `whiteboard-app:latest` / `whiteboard-room:latest` 가 생기므로,
이후에는 오버레이 없이 `docker compose up -d` 만 쓴다.

> RAM 2GB 에서는 `better-sqlite3` 컴파일 중에 메모리가 모자라 죽을 수 있다.
> 그때는 4-A 로 가거나, 스왑을 임시로 2GB 로 늘렸다가 빌드 후 되돌린다.

**확인**: `docker image ls` 에 `whiteboard-app` 과 `whiteboard-room` 이 둘 다 보인다.

---

## 5. `.env` 작성 · 데이터 폴더 · 기동

저장소를 Pi 의 `~/whiteboard` 에 두었다고 가정한다(4-A 로 왔으면 여기서 `git clone` 한다).

```bash
cd ~/whiteboard/deploy/pi
cp .env.example .env
chmod 600 .env
vi .env
```

지금 채울 것(나머지는 6단계에서):

| 항목 | 값 |
|---|---|
| `ADMIN_PASSWORD` | 8자 이상. 첫 로그인에서 바꾼다 |
| `PUBLIC_URL` | `https://draw.863ad.co.kr` |
| `COOKIE_SECURE` | `true` |
| `APP_TAG` / `ROOM_TAG` | 4-A 면 `<TAG>`, 4-B(직접 빌드)면 `latest` |
| `CADDY_EMAIL` | **자기 메일 주소** (인증서 만료 알림) |
| `GEMINI_API_KEY` | AI 를 쓸 때만. 비우면 ✨ 버튼이 안 나온다 |

데이터 폴더를 만들고 **소유자를 uid 1000 으로** 맞춘다.
컨테이너가 non-root(uid 1000)로 돌기 때문이다.

```bash
mkdir -p data caddy/data caddy/config
sudo chown -R 1000:1000 data
ls -ld data       # drwxr-xr-x ... 1000 1000
```

> Raspberry Pi OS 의 첫 사용자(`pi`)가 보통 uid 1000 이라 `id -u` 가 1000 이면
> `sudo chown` 없이도 맞는다. `id -u` 로 확인하고, 1000 이 아니면 위 명령을 그대로 쓴다.

띄운다:

```bash
docker compose up -d
docker compose ps          # caddy · app · room 세 개가 Up
docker compose logs -f app # "listening" 류 로그 확인 후 Ctrl+C
```

**확인**: Pi 안에서 앱이 응답한다.

```bash
docker compose exec caddy wget -qO- http://app:3001/api/health
# {"ok":true,"db":true,"room":true,...}
```

> 아직 브라우저로는 접속되지 않는다 — 6·7단계가 남았다.
> `docker compose logs caddy` 에 인증서 발급 실패가 보이는 것도 이 시점에는 정상이다.

---

## 6. 노출 방식 — A안 / B안 중 **택 1**

집의 공인 IP 는 하나고 **443 은 한 장비만** 받을 수 있다. 지금은 NAS 가 받고 있으므로
Pi 를 외부에 열려면 둘 중 하나를 골라야 한다.

| | A안 (Caddy 가 443 을 받는다) | B안 (Cloudflare Tunnel) |
|---|---|---|
| 공유기 변경 | **필요** (80·443 → Pi) | 없음 |
| NAS 설정 변경 | 없음 (Caddy 가 NAS 로 되돌려 준다) | 없음 |
| 도메인 조건 | 아무 DNS 나 | `863ad.co.kr` 네임서버가 **Cloudflare** 여야 함 |
| 위험 | NAS 호스트명을 빠뜨리면 그 서비스가 안 열림 | 트래픽이 Cloudflare 를 경유 |
| 되돌리기 | 공유기 포워딩을 NAS 로 복구 | 터널 컨테이너를 내림 |

> 도메인을 Cloudflare 에 둘 수 있으면 **B안**이 가장 덜 침습적이다("NAS 는 그대로" 에 정확히 부합).
> 그럴 수 없으면 A안.

### 6-A. A안 — 공유기 80/443 을 Pi 로 옮긴다

1. `.env` 를 A안으로 맞춘다:

   ```
   SITE_ADDRESS=draw.863ad.co.kr
   TRUST_PROXY=1
   NAS_IP=192.168.1.100        # NAS 의 LAN IP
   ```

2. **NAS 호스트명을 Caddyfile 로 옮긴다.** 0단계에서 캡처한 DSM 리버스 프록시 목록을 보고,
   `Caddyfile` 아래쪽의 주석 블록을 참고해 실제 호스트명마다 블록을 하나씩 만든다.

   ```
   travel.863ad.co.kr {
       encode zstd gzip
       reverse_proxy http://{$NAS_IP}:80
   }

   dsm.863ad.co.kr {
       reverse_proxy https://{$NAS_IP}:5001 {
           transport http {
               tls
               tls_insecure_skip_verify
           }
       }
   }
   ```

   - NAS 가 **HTTP→HTTPS 강제 리다이렉트**를 켜 두었으면 아래쪽(5001, HTTPS)을 쓴다.
     그대로 80 으로 넘기면 리다이렉트가 되돌아와 무한 루프가 된다.
   - `tls_insecure_skip_verify` 는 **Caddy→NAS 내부 구간**의 인증서 검증만 생략한다.
     브라우저↔Caddy 구간은 Let's Encrypt 정식 인증서 그대로다.
   - 호스트명을 **하나라도 빠뜨리면 그 서비스는 외부에서 안 열린다.** 목록을 두 번 대조한다.

3. 문법을 먼저 확인하고 반영한다:

   ```bash
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
   docker compose restart caddy
   ```

4. **공유기1 → 포트포워딩**: `80`·`443` 의 목적지를 NAS 에서 **Pi 의 예약 IP** 로 바꾼다.
   `5000`/`5001` 등 나머지 포워딩은 **그대로 NAS 에 둔다** — 바꾸는 것은 80·443 뿐이다.

   > 사람이 적은 시간(저녁 늦게)에 바꾼다. 문제가 생기면 이 포워딩만 NAS 로 되돌리면
   > 즉시 원상복구된다.

5. 인증서 발급을 지켜본다(80 포트가 Pi 로 와야 발급된다):

   ```bash
   docker compose logs -f caddy | grep -i -E "certificate|obtain|error"
   ```

**확인**: 브라우저에서 `https://draw.863ad.co.kr` 이 자물쇠와 함께 열리고,
**옮겨 적은 NAS 호스트명들도 전부 정상**이다(여행 앱·DSM 등 하나씩 눌러 본다).

### 6-B. B안 — Cloudflare Tunnel

1. `863ad.co.kr` 의 네임서버를 Cloudflare 로 옮긴다(Cloudflare 대시보드 안내대로).
2. **Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel** → Cloudflared 선택 →
   이름 지정 → **토큰을 복사**한다.
3. 같은 화면의 **Public Hostname** 에 추가:
   - Subdomain `draw`, Domain `863ad.co.kr`
   - Service: **HTTP**, URL: **`caddy:80`**
4. `.env` 를 B안으로 맞춘다:

   ```
   SITE_ADDRESS=:80
   TRUST_PROXY=2
   CLOUDFLARE_TUNNEL_TOKEN=<복사한 토큰>
   ```

   - `SITE_ADDRESS=:80` — Caddy 는 인증서를 발급하지 않는다. TLS 는 Cloudflare 가 맡는다.
   - `TRUST_PROXY=2` — 홉이 하나 늘어난다(브라우저 → cloudflared → caddy → app).
     이 값이 맞아야 로그인 rate limit 이 진짜 클라이언트 IP 로 세어진다.
   - `COOKIE_SECURE` 는 **true 그대로** 둔다. 브라우저가 보는 주소는 https 다.

5. 터널까지 함께 띄운다:

   ```bash
   docker compose --profile tunnel up -d
   docker compose logs -f cloudflared      # "Registered tunnel connection" 이 보이면 성공
   ```

   매번 `--profile tunnel` 을 붙이기 싫으면 `.env` 에 `COMPOSE_PROFILES=tunnel` 을 넣는다.

**확인**: Zero Trust 대시보드의 터널 상태가 **HEALTHY**, 브라우저에서
`https://draw.863ad.co.kr` 접속. 공유기·NAS 는 아무것도 건드리지 않았다.

---

## 7. DNS

- **A안**: `draw.863ad.co.kr` 의 **A 레코드**를 집 공인 IP 로 만든다.
  공인 IP 가 바뀌는 회선이면 공유기의 **DDNS** 기능을 쓰고 CNAME 으로 그 주소를 가리킨다.
  (NAS 가 쓰던 DDNS 를 그대로 써도 된다 — 어차피 같은 공인 IP 다.)
- **B안**: Cloudflare 가 CNAME(`<터널ID>.cfargotunnel.com`)을 **자동으로** 만든다.
  직접 만들 필요가 없다.

**확인**

```bash
# 밖에서(휴대폰 LTE 등) 확인하는 것이 가장 확실하다
curl -I https://draw.863ad.co.kr
# HTTP/2 200 (또는 리다이렉트) 이 나오면 성공
```

> 집 안에서 공개 도메인이 안 풀리면(공유기가 헤어핀 NAT 를 지원하지 않는 경우)
> Pi 의 `/etc/hosts` 에 `127.0.0.1 draw.863ad.co.kr` 를 넣으면 Pi 안에서의 접속과
> 9단계의 백업 스크립트가 편해진다.

---

## 8. 최초 로그인과 검증 체크리스트

1. `https://draw.863ad.co.kr` 접속 → `ADMIN_USERNAME`/`ADMIN_PASSWORD` 로 로그인
2. **비밀번호 변경 화면이 강제로 뜬다.** 바꾸기 전에는 다른 화면이 열리지 않는다(서버에서도 막는다).
3. 바꾼 비밀번호를 9단계의 `BACKUP_ADMIN_PASSWORD` 에 넣어야 한다 — 잊지 말 것.

**검증 체크리스트** (하나씩 눌러 본다)

| # | 항목 | 기준 |
|---|---|---|
| 1 | HTTPS 자물쇠 | 경고 없이 열린다 |
| 2 | 로그인 유지 | 브라우저를 껐다 켜도 로그인 상태 (`COOKIE_SECURE`·`PUBLIC_URL` 이 맞아야 한다) |
| 3 | 협업 2명 | 다른 기기/시크릿 창으로 같은 페이지 → 그림이 실시간으로 보인다 |
| 4 | 이미지 | 붙여넣기·업로드 후 새로고침해도 남아 있다 |
| 5 | 댓글 | 오브젝트에 댓글 → 다른 창에서 즉시 보인다 |
| 6 | 시트 | 시트 페이지 생성·수식·xlsx 내보내기 |
| 7 | AI | ✨ 버튼 (키를 넣었을 때만) |
| 8 | 자동 기동 | `sudo reboot` 후 3~4분 뒤 접속 → 세 컨테이너 모두 Up |
| 9 | 메모리 | `docker stats --no-stream` → app 384MB·room 144MB·caddy 128MB 한도 안 |
| 10 | 온도 | `vcgencmd measure_temp` → 평상시 60도 이하, 부하 시 70도 이하 |
| 11 | A안이면 NAS | 옮겨 적은 NAS 호스트명이 **전부** 정상 |
| 12 | B안이면 터널 | Zero Trust 터널 상태 **HEALTHY** |

```bash
docker compose ps           # 재부팅 뒤 세 컨테이너 Up (restart: unless-stopped)
docker stats --no-stream
vcgencmd measure_temp
```

> 9번이 한도에 자꾸 닿으면 `docker-compose.yml` 의 `mem_limit` 과 `NODE_OPTIONS`
> (`--max-old-space-size`)를 **같이** 올린다. 힙 상한은 항상 컨테이너 한도보다 낮게 둔다.

---

## 9. NAS 로 백업 (매일 03:00)

Pi 의 microSD 는 언젠가 죽는다는 전제로 운영한다. **백업은 선택이 아니다.**

`backup-to-nas.sh` 가 하는 일:

1. 관리자 계정으로 로그인해 `POST /api/admin/backup` 을 부른다
   → 앱이 SQLite 를 `VACUUM INTO` 로 떠서 `data/backup/app-<타임스탬프>.db` 를 만든다
   (서비스를 멈추지 않아도 정합성 있는 **한 개의 파일**이 나온다. 앱은 최신 7개만 남긴다)
2. 그 파일 하나와 업로드 이미지(`data/files/`)를 NAS 로 rsync 한다
3. NAS 쪽 DB 스냅샷을 최신 `NAS_KEEP`(기본 30)개만 남기고 정리한다

### 9-1. 백업용 관리자 계정

`.env` 의 `ADMIN_PASSWORD` 는 **최초 1회용**이라 8단계에서 비밀번호를 바꾸고 나면 맞지 않는다.
둘 중 하나를 고른다.

- **간단**: `BACKUP_ADMIN_USERNAME=admin` + `BACKUP_ADMIN_PASSWORD=<8단계에서 바꾼 비밀번호>`
- **권장**: 관리자 화면에서 백업 전용 관리자 계정(예: `backup`)을 하나 더 만든다.
  **새 계정은 최초 1회 웹에서 로그인해 비밀번호를 바꿔야 한다** — 바꾸기 전에는 서버가
  모든 API 를 `403 must_change_password` 로 막기 때문에 스크립트도 실패한다.

### 9-2. NAS 쪽 준비 — 두 방식 중 하나

**ssh 방식(권장)**

1. DSM: **제어판 → 터미널 및 SNMP → SSH 서비스 활성화**
2. DSM: 백업 받을 사용자와 공유 폴더(예: `/volume1/backup/whiteboard`) 준비, 쓰기 권한 부여
3. Pi 에서 전용 키를 만들고 NAS 에 등록:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/nas_backup -N ""
   ssh-copy-id -i ~/.ssh/nas_backup.pub -p 22 <NAS사용자>@192.168.1.100
   ssh -i ~/.ssh/nas_backup <NAS사용자>@192.168.1.100 'echo ok'   # 비밀번호 없이 ok
   ```

   > DSM 은 홈 디렉터리·`~/.ssh` 권한에 민감하다. `ssh-copy-id` 가 안 되면 NAS 에서
   > `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys` 를 해 준다.

4. `.env`:

   ```
   BACKUP_MODE=ssh
   NAS_SSH_HOST=192.168.1.100
   NAS_SSH_USER=<NAS사용자>
   NAS_SSH_KEY=/home/pi/.ssh/nas_backup
   NAS_DEST=/volume1/backup/whiteboard
   ```

**mount 방식(NAS 의 SSH 를 켜고 싶지 않을 때)**

NAS 공유 폴더를 Pi 에 SMB 로 마운트한다(`/etc/fstab` 에 넣어 부팅 시 자동 마운트).

```bash
sudo apt install -y cifs-utils
sudo mkdir -p /mnt/nas
# 자격증명은 파일로 분리한다 (fstab 에 비밀번호를 적지 않는다)
sudo sh -c 'printf "username=NAS계정\npassword=NAS비번\n" > /etc/nas-credentials'
sudo chmod 600 /etc/nas-credentials
echo '//192.168.1.100/backup /mnt/nas cifs credentials=/etc/nas-credentials,uid=1000,gid=1000,vers=3.0,_netdev,nofail 0 0' \
  | sudo tee -a /etc/fstab
sudo mount -a && mountpoint /mnt/nas
```

`.env`: `BACKUP_MODE=mount`, `NAS_MOUNT_DEST=/mnt/nas/whiteboard`

### 9-3. 수동으로 한 번 돌려 본다

```bash
cd ~/whiteboard/deploy/pi
./backup-to-nas.sh --dry-run      # 무엇을 보낼지만 확인
./backup-to-nas.sh                # 실제 백업
```

**확인**: NAS 에서 `backup/whiteboard/db/app-<타임스탬프>.db` 와 `backup/whiteboard/files/` 를 눈으로 본다.

자주 나는 실패:

| 메시지 | 원인 |
|---|---|
| `로그인에 실패했습니다` | `BACKUP_ADMIN_PASSWORD` 가 8단계에서 바꾼 값이 아니다 |
| `403 must_change_password` | 그 계정으로 웹에 한 번 로그인해 비밀번호를 바꿔야 한다 |
| `NAS 에 SSH 로 붙지 못했습니다` | 키 미등록, DSM SSH 꺼짐, 포트 다름 |
| 이름 해석 실패 | 집 안에서 공개 도메인이 안 풀린다 → 7단계의 `/etc/hosts` 메모 참고 |

### 9-4. systemd 타이머로 자동화

```bash
cd ~/whiteboard/deploy/pi
sudo cp whiteboard-backup.service whiteboard-backup.timer /etc/systemd/system/
sudo vi /etc/systemd/system/whiteboard-backup.service
#   User / Group / WorkingDirectory / ExecStart 를 실제 경로로 고친다
#   (기본값은 pi 사용자, /home/pi/whiteboard/deploy/pi)
sudo systemctl daemon-reload
sudo systemctl enable --now whiteboard-backup.timer

systemctl list-timers whiteboard-backup.timer   # 다음 실행 시각
sudo systemctl start whiteboard-backup.service  # 지금 한 번 돌려 보기
journalctl -u whiteboard-backup -n 50 --no-pager
```

**확인**: `list-timers` 에 다음 03:00 이 잡혀 있고, 수동 실행이 성공(`exit 0`)한다.

> 복원 절차는 [OPERATIONS.md](../../OPERATIONS.md) 의 「3-3. 복원」을 본다.
> 백업 파일은 `VACUUM INTO` 산출물이라 WAL 파일 없이 `app.db` 하나만 놓으면 된다.
> **한 번은 실제로 복원해 본다** — 복원해 본 적 없는 백업은 백업이 아니다.

---

## 10. microSD 보호 (선택이지만 권장)

SQLite 는 WAL 모드로 계속 쓴다. microSD 는 쓰기 수명이 짧아 1~3년 안에 죽을 수 있다.

### 10-1. 데이터 디렉터리를 USB SSD 로 옮긴다 (가장 효과가 크다)

```bash
lsblk                                   # 예: sda1
sudo mkdir -p /mnt/ssd
sudo mkfs.ext4 /dev/sda1                # ★ 기존 데이터가 지워진다. 새 디스크일 때만
# UUID 로 fstab 에 넣는다 (장치 이름은 순서가 바뀔 수 있다)
sudo blkid /dev/sda1
echo 'UUID=<위에서 본 UUID> /mnt/ssd ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a

cd ~/whiteboard/deploy/pi
docker compose down                     # ★ 반드시 멈추고 옮긴다
sudo mkdir -p /mnt/ssd/whiteboard
sudo cp -a data /mnt/ssd/whiteboard/data
sudo chown -R 1000:1000 /mnt/ssd/whiteboard/data
# .env 에서 한 줄만 바꾼다
#   DATA_DIR_HOST=/mnt/ssd/whiteboard/data
docker compose up -d
docker compose exec caddy wget -qO- http://app:3001/api/health
```

원래 `data/` 는 정상 확인 뒤에 지운다(당분간 남겨 두는 편이 안전하다).

### 10-2. 그 밖에

- **로그 로테이션**: `docker-compose.yml` 에 이미 `max-size 5m`·`max-file 3` 이 걸려 있다(컨테이너당 최대 15MB).
- **스왑 최소화**: 스왑을 SD 에 쓰면 마모가 빨라진다.
  ```bash
  sudo dphys-swapfile swapoff && sudo systemctl disable dphys-swapfile   # RAM 4GB 이상이면 꺼도 된다
  ```
  RAM 2GB 라면 끄지 말고 그대로 둔다.
- **전원·발열**: 정품 USB-C 전원(5V/3A)을 쓴다. 전압이 모자라면 SD 손상과 알 수 없는
  재부팅으로 이어진다. `vcgencmd get_throttled` 가 `0x0` 이 아니면 전원·발열 문제다.
- **SD 카드는 소모품이다**: 백업(9단계)이 돌고 있으면 카드가 죽어도 새 카드에 OS 를 굽고
  4·5단계 + 복원만 하면 된다.

---

## 문제가 생기면

| 증상 | 먼저 볼 것 |
|---|---|
| 브라우저가 아예 안 열린다 | `docker compose ps`(세 개 Up?), `docker compose logs caddy` |
| 인증서 발급 실패 (A안) | 공유기 **80** 포워딩이 Pi 로 갔는지. Let's Encrypt 는 80 을 쓴다 |
| 인증서 발급을 반복 실패 | Let's Encrypt 발급 한도에 걸릴 수 있다. 원인을 고친 뒤 재시도하고, `caddy/data` 를 지우지 말 것 |
| 로그인 직후 다시 로그인 화면 | HTTP 로 접속 중이거나 `PUBLIC_URL`·`COOKIE_SECURE` 가 틀렸다 |
| 협업이 안 된다 | `docker compose logs room`, `/api/health` 의 `room` 값 |
| A안 후 NAS 서비스가 안 열린다 | Caddyfile 에 그 호스트명 블록이 있는지. 없으면 추가 후 `restart caddy` |
| 백업이 안 돈다 | `journalctl -u whiteboard-backup -n 50` |
| 그 밖에 | [OPERATIONS.md](../../OPERATIONS.md) 7장, [KNOWN_ISSUES.md](../../KNOWN_ISSUES.md) |

로그 한 번에 보기:

```bash
cd ~/whiteboard/deploy/pi
docker compose logs --tail 100 caddy app room
```
