#!/usr/bin/env bash
#
# DS118(arm64) 용 이미지 크로스 빌드 — **사용자 PC 에서** 실행한다.
#
#   ./build-arm64.sh              # 두 이미지 모두 빌드 + tar 로 저장
#   ./build-arm64.sh app          # app 만
#   ./build-arm64.sh room         # room 만
#   TAG=2026-09-05 ./build-arm64.sh
#
# 산출물: dist-images/ds118-whiteboard-app-<TAG>.tar, ...-room-<TAG>.tar
# 이 tar 를 File Station 으로 NAS 에 올리고 Container Manager 의
# 「이미지 → 추가 → 파일에서 추가」로 불러온다 (SETUP.md 3~4단계).
#
# NAS 는 1GB RAM 짜리 ARM 장비라 거기서 빌드하지 않는다. PC 에서 QEMU 로 크로스 빌드한다.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

PLATFORM="linux/arm64"
OUT_DIR="${OUT_DIR:-dist-images}"
BUILDER_NAME="${BUILDER_NAME:-ds118-arm64}"

APP_IMAGE="ds118-whiteboard-app"
ROOM_IMAGE="ds118-whiteboard-room"

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
  local name="$1" image="$2" dockerfile="$3"
  local ref="${image}:${TAG}"
  info "빌드 시작: ${ref}  (${PLATFORM}, -f ${dockerfile})"

  # --load 는 결과를 로컬 도커에 넣는다. 크로스 빌드라 캐시가 없으면 10~30분 걸릴 수 있다.
  if ! docker buildx build \
        --platform "$PLATFORM" \
        -t "$ref" \
        -t "${image}:latest" \
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
  docker save -o "$tar" "$ref"

  local size
  size="$(du -h "$tar" | cut -f1)"
  info "완료: ${name} → ${tar} (${size})"
}

built=()
for target in "${TARGETS[@]}"; do
  case "$target" in
    app)  build_one app  "$APP_IMAGE"  backend/Dockerfile; built+=("$APP_IMAGE:$TAG") ;;
    room) build_one room "$ROOM_IMAGE" room/Dockerfile;    built+=("$ROOM_IMAGE:$TAG") ;;
    *)    fail "알 수 없는 대상: ${target} (app 또는 room)" ;;
  esac
done

echo
info "빌드한 이미지:"
for ref in "${built[@]}"; do
  printf '  %s\n' "$ref"
done
docker image ls --filter "reference=ds118-whiteboard-*:${TAG}" \
  --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' || true

cat <<EOF

다음 단계 (SETUP.md 3~4단계):
  1. ${OUT_DIR}/ 의 tar 파일을 File Station 으로 NAS 에 올린다.
  2. Container Manager → 이미지 → 추가 → 「파일에서 추가」로 두 tar 를 불러온다.
  3. NAS 의 프로젝트 폴더 .env 에서 태그를 맞춘다:
       APP_TAG=${TAG}
       ROOM_TAG=${TAG}
  4. Container Manager → 프로젝트 → 빌드/시작.
EOF
