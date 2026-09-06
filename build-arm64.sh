#!/usr/bin/env bash
#
# arm64 이미지 크로스 빌드 — **사용자 PC 에서** 실행한다.
# 배포 대상 두 곳(라즈베리파이4·DS118 NAS)이 모두 linux/arm64 라 같은 이미지를 쓴다.
#
#   ./build-arm64.sh              # 두 이미지 모두 빌드 + tar 로 저장
#   ./build-arm64.sh app          # app 만
#   ./build-arm64.sh room         # room 만
#   TAG=2026-09-05 ./build-arm64.sh
#
# 산출물: dist-images/whiteboard-app-<TAG>.tar, dist-images/whiteboard-room-<TAG>.tar
#   - Pi  : scp 로 Pi 에 옮기고 `docker load -i <tar>` (deploy/pi/SETUP-PI.md 4단계)
#   - NAS : File Station 으로 올리고 Container Manager 의
#           「이미지 → 추가 → 파일에서 추가」로 불러온다 (SETUP.md 3~4단계)
#
# 이미지 이름은 `whiteboard-app` / `whiteboard-room` 이다.
# 예전 NAS 문서·프로젝트가 쓰던 `ds118-whiteboard-*` 태그도 **같이** 찍어 두므로
# 기존 NAS 배포는 그대로 동작한다.
#
# ---- Pi 에서 직접 빌드하기 (이 스크립트가 필요 없는 경우) -------------------
# Pi 의 RAM 이 4GB 이상이면 크로스 빌드 대신 Pi 에서 그냥 빌드하는 편이 간단하다
# (네이티브라 QEMU 가 필요 없고 10~20분쯤 걸린다):
#
#   git clone <저장소> ~/whiteboard && cd ~/whiteboard/deploy/pi
#   cp .env.example .env && vi .env
#   docker compose -f docker-compose.yml -f docker-compose.build.yml build
#   docker compose up -d
#
# RAM 2GB Pi 에서는 better-sqlite3 컴파일에서 메모리가 모자랄 수 있으므로
# 이 스크립트로 PC 에서 크로스 빌드하는 쪽을 권한다.
#
# NAS(DS118)는 1GB RAM 이라 거기서는 빌드하지 않는다 — 반드시 PC 크로스 빌드.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

PLATFORM="linux/arm64"
OUT_DIR="${OUT_DIR:-dist-images}"
BUILDER_NAME="${BUILDER_NAME:-ds118-arm64}"

APP_IMAGE="whiteboard-app"
ROOM_IMAGE="whiteboard-room"

# 예전 이름 — NAS 용 docker-compose.yml 과 SETUP.md 가 이 이름을 참조한다.
# 같은 이미지에 태그만 하나 더 붙이는 것이라 용량은 늘지 않는다.
LEGACY_APP_IMAGE="ds118-whiteboard-app"
LEGACY_ROOM_IMAGE="ds118-whiteboard-room"

# 태그: <git short sha>-<YYYYMMDD>. 저장소가 아니면 날짜만 쓴다.
default_tag() {
  local sha date
  date="$(date +%Y%m%d)"
  if sha="$(git rev-parse --short HEAD 2>/dev/null)"; then
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      echo "${sha}-dirty-${date}"
    else
      echo "${sha}-${date}"
    fi
  else
    echo "$date"
  fi
}
TAG="${TAG:-$(default_tag)}"

TARGETS=("${@:-app room}")
# "app room" 한 덩어리로 들어온 기본값을 낱개로 편다.
read -r -a TARGETS <<<"${TARGETS[*]}"

info() { printf '\033[36m[build]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[build]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[build]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 사전 점검 -------------------------------------------------------------

command -v docker >/dev/null 2>&1 || fail "docker 를 찾을 수 없습니다. Docker Desktop(또는 docker engine)을 먼저 설치하세요."

if ! docker info >/dev/null 2>&1; then
  fail "docker 데몬에 연결할 수 없습니다. Docker Desktop 이 실행 중인지 확인하세요."
fi

if ! docker buildx version >/dev/null 2>&1; then
  fail "docker buildx 가 없습니다. Docker 를 24.x 이상으로 올리거나 buildx 플러그인을 설치하세요."
fi

# QEMU(binfmt) — x86_64 PC 에서 arm64 이미지를 빌드하려면 필요하다.
# Docker Desktop 에는 기본 포함이지만 리눅스 docker engine 에는 없을 수 있다.
ensure_qemu() {
  if docker buildx inspect --bootstrap "$BUILDER_NAME" 2>/dev/null | grep -q "linux/arm64"; then
    return 0
  fi
  warn "빌더가 linux/arm64 를 지원하지 않습니다. QEMU 를 설치합니다..."
  docker run --privileged --rm tonistiigi/binfmt --install arm64 \
    || fail "QEMU 설치에 실패했습니다. 수동으로 실행해 보세요:
    docker run --privileged --rm tonistiigi/binfmt --install arm64"
}

# ---- 빌더 --------------------------------------------------------------------

if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  info "buildx 빌더 '$BUILDER_NAME' 를 사용합니다."
  docker buildx use "$BUILDER_NAME"
else
  info "buildx 빌더 '$BUILDER_NAME' 를 만듭니다."
  docker buildx create --name "$BUILDER_NAME" --use >/dev/null
fi
ensure_qemu

mkdir -p "$OUT_DIR"

# ---- 빌드 --------------------------------------------------------------------

build_one() {
  local name="$1" image="$2" dockerfile="$3" legacy="$4"
  local ref="${image}:${TAG}"
  info "빌드 시작: ${ref}  (${PLATFORM}, -f ${dockerfile})"

  # --load 는 결과를 로컬 도커에 넣는다. 크로스 빌드라 캐시가 없으면 10~30분 걸릴 수 있다.
  # -t 를 네 번 준다 — 새 이름(whiteboard-*)과 예전 이름(ds118-whiteboard-*) 각각의
  # <TAG> 와 latest. 이미지는 하나고 이름표만 넷이다.
  if ! docker buildx build \
        --platform "$PLATFORM" \
        -t "$ref" \
        -t "${image}:latest" \
        -t "${legacy}:${TAG}" \
        -t "${legacy}:latest" \
        -f "$dockerfile" \
        --load \
        . ; then
    warn "빌드 실패: ${ref}"
    cat >&2 <<'HINT'
자주 나는 원인:
  1) "exec format error" / "no match for platform"
     → QEMU 미설치. 아래를 실행하고 다시 시도하세요:
         docker run --privileged --rm tonistiigi/binfmt --install arm64
  2) better-sqlite3 컴파일 실패 (node-gyp)
     → 네트워크가 npm registry 에 닿는지 확인하세요. Dockerfile 의 deps 스테이지에
       python3/make/g++ 를 이미 설치하므로 도구 부족은 원인이 아닙니다.
  3) "no space left on device"
     → docker system prune -af 로 정리한 뒤 다시 시도하세요 (이미지 2개에 약 2GB 필요).
  4) 아주 느림
     → QEMU 에뮬레이션이라 정상입니다. 두 번째 빌드부터는 캐시가 듣습니다.
HINT
    return 1
  fi

  local tar="${OUT_DIR}/${image}-${TAG}.tar"
  info "저장: ${tar}"
  # 네 이름표를 모두 담는다 — 같은 이미지 하나라 tar 크기는 늘지 않고,
  # Pi 든 NAS 든 `docker load` 한 번으로 새 이름·예전 이름이 모두 생긴다.
  docker save -o "$tar" "$ref" "${image}:latest" "${legacy}:${TAG}" "${legacy}:latest"

  local size
  size="$(du -h "$tar" | cut -f1)"
  info "완료: ${name} → ${tar} (${size})"
}

built=()
for target in "${TARGETS[@]}"; do
  case "$target" in
    app)  build_one app  "$APP_IMAGE"  backend/Dockerfile "$LEGACY_APP_IMAGE"
          built+=("$APP_IMAGE:$TAG" "$LEGACY_APP_IMAGE:$TAG") ;;
    room) build_one room "$ROOM_IMAGE" room/Dockerfile "$LEGACY_ROOM_IMAGE"
          built+=("$ROOM_IMAGE:$TAG" "$LEGACY_ROOM_IMAGE:$TAG") ;;
    *)    fail "알 수 없는 대상: ${target} (app 또는 room)" ;;
  esac
done

echo
info "빌드한 이미지:"
for ref in "${built[@]}"; do
  printf '  %s\n' "$ref"
done
docker image ls --filter "reference=*whiteboard-*:${TAG}" \
  --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' || true

cat <<EOF

다음 단계 — 라즈베리파이4 (deploy/pi/SETUP-PI.md 4단계):
  1. tar 두 개를 Pi 로 옮긴다:
       scp ${OUT_DIR}/whiteboard-*-${TAG}.tar pi@<Pi주소>:~/
  2. Pi 에서 불러온다:
       docker load -i ~/whiteboard-app-${TAG}.tar
       docker load -i ~/whiteboard-room-${TAG}.tar
  3. deploy/pi/.env 에서 태그를 맞춘다:
       APP_TAG=${TAG}
       ROOM_TAG=${TAG}
  4. docker compose up -d

다음 단계 — DS118 NAS (SETUP.md 3~4단계):
  1. ${OUT_DIR}/ 의 tar 파일을 File Station 으로 NAS 에 올린다.
  2. Container Manager → 이미지 → 추가 → 「파일에서 추가」로 두 tar 를 불러온다.
     (tar 안에는 ds118-whiteboard-* 태그도 함께 들어 있다.)
  3. NAS 의 프로젝트 폴더 .env 에서 태그를 맞춘다:
       APP_TAG=${TAG}
       ROOM_TAG=${TAG}
  4. Container Manager → 프로젝트 → 빌드/시작.
EOF
