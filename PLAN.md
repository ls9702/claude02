# 셀프호스팅 실시간 화이트보드 프로젝트 계획

개인 NAS에서 소규모로 운영하는 웹 기반 실시간 화이트보드(Figma/Excalidraw 스타일).

## 1. 요구사항 정리

- 웹 기반으로 사진, 그림(손그림), 개념도/다이어그램 작성
- 관리자가 세션(보드)을 개설하면, 사용자는 아이디/비밀번호로 로그인 후 접속
- 실시간 동시 편집 (여러 명이 같은 보드를 동시에 그림)
- 개인 NAS(Docker)에서 운영, 동시 사용자 5~10명 수준의 소규모
- 가능하면 오픈소스 활용

## 2. 오픈소스 후보 비교 (2026-09 기준)

| 후보 | 라이선스 | 실시간 협업 | 로그인/계정 | 서버 저장 | NAS 부담 | 비고 |
|---|---|---|---|---|---|---|
| **ExcaliDash** | LGPL-3.0 | O (WebSocket) | O (로컬 계정 + OIDC, 관리자 부트스트랩) | O (버전 히스토리 포함) | 낮음 (~1GB 미만) | Excalidraw 기반 대시보드. 요구사항과 거의 정확히 일치. 단 베타 상태 |
| **Excalidraw 단독** | MIT | 조건부 | X | X (브라우저 localStorage) | 매우 낮음 | 협업하려면 excalidraw-room 서버 + 프론트 재빌드 필요(WS 주소가 빌드 타임에 박힘). 인증은 리버스 프록시로 별도 처리 |
| **AFFiNE** | 대부분 오픈 | O | O (계정/워크스페이스) | O (Postgres) | 높음 (2~3GB RAM + Postgres + Redis, 4코어 권장) | 화이트보드+문서 통합 워크스페이스. 기능은 가장 많지만 무겁고 "화이트보드만" 원하면 과함 |
| tldraw | 유료화 | - | - | - | - | 2025년 9월 라이선스 변경으로 프로덕션 사용 시 유료 → 제외 |
| WBO / OurBoard | 오픈 | O | X | 일부 | 매우 낮음 | 기능이 빈약하고 인증 없음 → 제외 |

## 3. 권장안

### 1안 (권장): ExcaliDash 도입
- 관리자 계정 부트스트랩 → 사용자 계정 발급 → 보드(세션) 생성/공유 → 실시간 협업까지 요구 흐름이 그대로 내장됨.
- docker-compose 한 벌로 배포. 개발량은 사실상 설치/설정 1~2일.
- 리스크: 베타 소프트웨어. 정기 백업 필수(.excalidraw 내보내기 + 볼륨 백업). LGPL-3.0은 사용/자가 호스팅에는 문제 없음.

### 2안: Excalidraw + excalidraw-room + 자체 래퍼 개발
- MIT 코어에 얇은 백엔드(로그인, 세션 개설/입장 관리, 보드 저장)를 직접 개발.
- 원하는 인증 흐름("관리자가 세션을 열어주면 ID/PW로 입장")을 정확히 구현 가능.
- 개발량: 파트타임 기준 2~4주 (인증, 세션 관리, 저장/복원, WS 프록시, UI).
- 완전한 통제권이 필요하거나 1안이 안 맞을 때의 대안.

### 3안: AFFiNE
- NAS RAM이 8GB 이상 여유라면 고려. 문서+화이트보드 통합이 필요할 때만.

**결론: 1안으로 시작 → 부족하면 2안으로 전환.** (ExcaliDash도 결국 Excalidraw 포맷이라 데이터 이전이 쉬움)

## 4. NAS 구현 가능성 체크

- **리소스**: ExcaliDash 스택은 RAM 수백 MB~1GB, CPU 부담 미미. Docker 지원 x86 NAS(Synology plus 계열, QNAP 등)면 충분. AFFiNE만 예외적으로 무거움.
- **실시간성**: WebSocket 릴레이 방식이라 5~10명 동시 접속은 NAS급 하드웨어로 여유.
- **필요 인프라**:
  - Docker / Container Manager
  - 리버스 프록시 + **HTTPS 필수** — 협업용 WebSocket(wss), 클립보드 이미지 붙여넣기 등 브라우저 기능이 HTTPS를 요구함. Let's Encrypt 또는 기존 NAS 인증서 활용.
  - 외부 접속 방식 결정: 포트포워딩 / Cloudflare Tunnel / VPN(Tailscale 등). 소규모 개인용이면 VPN·터널 방식이 보안상 유리.

## 5. 추가로 필요한/고려할 기능

- [ ] **백업**: Docker 볼륨 정기 백업 + .excalidraw 파일 내보내기 자동화 (베타 소프트웨어라 특히 중요)
- [ ] **버전 히스토리**: ExcaliDash 내장 — 실수로 지웠을 때 복구
- [ ] **이미지 업로드 용량 제한**: 사진을 많이 붙이는 용도라면 업로드 한도/저장 공간 정책 필요
- [ ] **게스트 공유 링크**: 로그인 없이 보기 전용 공유 (ExcaliDash 내·외부 공유 범위 설정 지원)
- [ ] **내보내기**: PNG / SVG / .excalidraw (Excalidraw 기본 지원)
- [ ] **태블릿·펜 입력**: Excalidraw 계열은 지원됨 — 실제 쓸 기기로 초기 테스트 권장
- [ ] **로그인 보안**: 외부 노출 시 로그인 시도 제한(fail2ban), 또는 프록시 앞단 인증(Authelia 등) 추가 검토
- [ ] **업데이트 정책**: 베타이므로 업데이트 전 백업 → 적용 → 검증 순서 습관화

## 6. 하드웨어 확정에 따른 계획 수정 (2026-09)

**확정된 환경: Synology DS118 — Realtek RTD1296(ARMv8, 쿼드 A53 1.4GHz), RAM 1GB, DSM 7.0.1-42218 Update 6. 동시 사용자 5명 이하.**

### 제약 분석
- **DS118은 Container Manager(도커) 공식 지원 목록에 없음.** 단, 동일 CPU(RTD1296)의 지원 모델용 패키지를 설치해주는 검증된 커뮤니티 스크립트([007revad/ContainerManager_for_all_armv8](https://github.com/007revad/ContainerManager_for_all_armv8))가 있고 DS118이 지원 모델로 명시돼 있음. DSM 7.2 이상 필요.
- **현재 DSM 7.0.1 → 7.2+로 업데이트 선행 필요** (DS118은 DSM 7.2 지원 모델).
- **RAM 1GB**: DSM이 300~400MB를 쓰므로 컨테이너 여유는 500~600MB. 경량 스택은 안정적으로 가능하나 ExcaliDash(Node 백엔드+SQLite)는 부담 → **경량 스택으로 확정**.
- **arm64 이미지 필요**: Excalidraw 프론트는 자체 크로스 빌드, excalidraw-room·nginx는 arm64 이미지 존재.
- **QuickConnect는 사용 불가** (커스텀 포트/WebSocket 미지원) → 외부 접속은 DDNS+포트포워딩+Let's Encrypt 또는 Tailscale로.

### 사전 작업 (도커 활성화)
1. DSM 7.0.1 → 7.2+ 업데이트 (제어판 → 업데이트 및 복원. 업데이트 전 설정 백업 권장)
2. 007revad 스크립트 실행(SSH)으로 Container Manager 설치
3. 패키지 센터에서 Container Manager 자동 업데이트 제외 설정 (자동 업데이트 시 되돌아갈 수 있음)
- 비고: 공식 미지원 경로이므로 리스크가 0은 아니나, 동일 CPU 지원 모델의 패키지를 그대로 쓰는 방식이라 커뮤니티에서 다수 검증됨. DSM 메이저 업데이트 시 재실행 필요할 수 있음.
- 대안(도커 회피): Web Station 정적 호스팅 + Node.js 패키지로 excalidraw-room 직접 실행 — 가능하지만 ID/PW 인증을 붙일 방법이 마땅치 않아 비권장.

### 수정된 권장 아키텍처 (경량 스택, RAM 약 150~250MB)
```
[브라우저] ──HTTPS──> [nginx: Basic Auth + 정적 Excalidraw 프론트 + wss 프록시]
                              │
                              └──> [excalidraw-room: WebSocket 실시간 릴레이 (Node, ~50-100MB)]
```
- **Excalidraw 프론트엔드**: arm64로 빌드된 정적 파일 (커뮤니티 arm64 이미지 활용 또는 PC에서 크로스 빌드. `VITE_APP_WS_SERVER_URL`이 빌드 타임에 박히므로 자체 빌드 필요)
- **excalidraw-room**: 실시간 협업 릴레이 서버. 무상태라 메모리 부담 최소
- **nginx**: HTTPS 종단 + **Basic Auth(htpasswd)로 ID/PW 로그인** + 프론트 서빙 + wss 프록시. 시놀로지 내장 리버스 프록시는 인증 기능이 없어 nginx 컨테이너로 대체
- **세션 개설 흐름**: 관리자가 보드(룸) URL 생성 → 사용자에게 공유 → 사용자는 Basic Auth ID/PW 입력 후 해당 룸 접속. 사용자별 계정은 htpasswd에 추가하는 방식

### 이 구성의 트레이드오프
- (+) 5명 이하 실시간 협업, ID/PW 접근 제어, 1GB RAM에서 안정 동작
- (−) **서버 측 보드 저장이 없음**: 그림은 참가자 브라우저(localStorage)에 저장됨. 협업 룸은 참가자가 모두 나가면 서버에는 남지 않음
  - 보완책 1: 작업 종료 시 .excalidraw 파일로 내보내기(수동, 간단)
  - 보완책 2: `excalidraw-storage-backend`(kiliandeca) 추가로 공유 링크/씬 서버 저장 — RAM 여유 확인 후 선택 적용 (DS124라면 가능, DS120j는 비권장)
- (−) 계정 관리 UI 없음(htpasswd 파일 편집) — 5명 이하 소규모라 수용 가능

## 7. 다음 단계 (DS118 확정)

1. **[사용자]** DSM 7.0.1 → 7.2+ 업데이트
2. **[사용자]** SSH 활성화 후 007revad 스크립트로 Container Manager 설치, 자동 업데이트 제외 설정
3. 접속 방식 결정: 내부망 전용 / Tailscale / DDNS+포트포워딩+Let's Encrypt (QuickConnect는 불가)
4. Excalidraw 프론트 arm64 빌드 (PC에서 `docker buildx`로 크로스 빌드, WS 주소 주입)
5. docker-compose 작성: nginx(Basic Auth+HTTPS) + excalidraw-room
6. 5명 동시 접속 실사용 테스트 (이미지 붙여넣기, 펜 입력 포함)
7. 내보내기 습관/백업 절차 정리 (서버 저장 없으므로 특히 중요)
8. (선택, RAM 여유 확인 후) excalidraw-storage-backend 추가로 서버 측 저장 도입 검토
