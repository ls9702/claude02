#!/usr/bin/env bash
#
# 라즈베리파이4 → NAS 백업 (deploy/pi).
#
# 하는 일:
#   1) 앱의 관리자 API 로 로그인해 `POST /api/admin/backup` 을 부른다
#      → 앱이 SQLite 를 `VACUUM INTO` 로 떠서 data/backup/app-<타임스탬프>.db 를 만든다
#        (서비스를 멈추지 않고도 정합성 있는 한 개의 파일이 나온다. 앱은 최신 7개만 남긴다)
#   2) 방금 만들어진 DB 스냅샷 한 개와 업로드 이미지(data/files/)를 NAS 로 보낸다
#      - BACKUP_MODE=ssh   : rsync -e ssh (NAS 의 SSH 를 켜고 키를 등록해 둔 경우)
#      - BACKUP_MODE=mount : 이미 마운트된 경로로 rsync (SMB/NFS)
#   3) NAS 쪽 DB 스냅샷을 최신 NAS_KEEP 개만 남기고 정리한다
#
# 설정은 옆의 `.env` 에서 읽는다 (.env.example 의 「3. NAS 백업」 절).
# 수동 실행:
#   ./backup-to-nas.sh              # 실제 백업
#   ./backup-to-nas.sh --dry-run    # 전송 없이 무엇을 보낼지만 확인
# 자동 실행: whiteboard-backup.timer (매일 03:00) — SETUP-PI.md 9단계
#
# 종료 코드가 0 이 아니면 systemd 가 실패로 기록한다: journalctl -u whiteboard-backup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log()  { printf '[backup] %s\n' "$*"; }
warn() { printf '[backup] %s\n' "$*" >&2; }
fail() { printf '[backup] 실패: %s\n' "$*" >&2; exit 1; }

# ---- .env 읽기 -------------------------------------------------------------
# `source` 를 쓰지 않는다 — 비밀번호에 $ ` " 같은 문자가 들어 있어도 그대로 읽기 위해서다
# (docker compose 의 env_file 과 같은 규칙: 값을 셸로 해석하지 않는다).
load_env() {
  local file="$1" line key value
  [ -r "$file" ] || fail "설정 파일을 읽을 수 없습니다: $file  (.env.example 을 복사해 만드세요)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    # 앞뒤 공백과 감싼 따옴표만 벗긴다.
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then value="${value:1:${#value}-2}"
    fi
    # 이미 환경에 있는 값이 우선한다 (systemd 유닛이나 셸에서 덮어쓸 수 있게).
    [ -n "${!key-}" ] || printf -v "$key" '%s' "$value"
    export "${key?}"
  done < "$file"
}
load_env "$ENV_FILE"

BASE_URL="${BACKUP_BASE_URL:-${PUBLIC_URL:-}}"
ADMIN_USER="${BACKUP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${BACKUP_ADMIN_PASSWORD:-}"
MODE="${BACKUP_MODE:-ssh}"
KEEP="${NAS_KEEP:-30}"
DATA_HOST="${DATA_DIR_HOST:-./data}"
case "$DATA_HOST" in
  /*) DATA_PATH="$DATA_HOST" ;;
  *)  DATA_PATH="$SCRIPT_DIR/${DATA_HOST#./}" ;;
esac

[ -n "$BASE_URL" ] || fail "BACKUP_BASE_URL 이 비어 있습니다."
[ -n "$ADMIN_PASS" ] || fail "BACKUP_ADMIN_PASSWORD 가 비어 있습니다. (.env 의 「3. NAS 백업」 절)"
[ -d "$DATA_PATH" ] || fail "데이터 디렉터리가 없습니다: $DATA_PATH"
command -v curl  >/dev/null 2>&1 || fail "curl 이 없습니다: sudo apt install -y curl"
command -v rsync >/dev/null 2>&1 || fail "rsync 가 없습니다: sudo apt install -y rsync"

CURL_OPTS=(--silent --show-error --max-time 120)
# --fail-with-body 는 curl 7.76+ (Bookworm 은 7.88). 없으면 --fail 로 물러선다
# (그 경우 오류 응답 본문이 보이지 않아 원인 파악이 조금 불편할 뿐이다).
if curl --help all 2>/dev/null | grep -q -- '--fail-with-body'; then
  CURL_OPTS+=(--fail-with-body)
else
  CURL_OPTS+=(--fail)
fi
[ "${BACKUP_INSECURE:-0}" = "1" ] && CURL_OPTS+=(--insecure)

JAR="$(mktemp)"
cleanup() { rm -f "$JAR"; }
trap cleanup EXIT

# ---- 1) 로그인 → 세션 쿠키 --------------------------------------------------
# 인증은 httpOnly 세션 쿠키(`sid`) 하나다. CSRF 토큰은 없다.
log "로그인: ${BASE_URL} (${ADMIN_USER})"
login_body="$(printf '{"username":%s,"password":%s}' \
  "$(printf '%s' "$ADMIN_USER" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" \
  "$(printf '%s' "$ADMIN_PASS" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")"

if ! login_out="$(curl "${CURL_OPTS[@]}" -c "$JAR" \
      -H 'content-type: application/json' \
      --data-binary "$login_body" \
      "${BASE_URL}/api/auth/login" 2>&1)"; then
  warn "$login_out"
  fail "로그인에 실패했습니다. 아이디·비밀번호와 주소를 확인하세요.
      (429 면 로그인 시도 제한입니다 — 잠시 뒤 다시 시도하세요)"
fi

# ---- 2) DB 스냅샷 만들기 ----------------------------------------------------
log "DB 스냅샷 요청: POST /api/admin/backup"
if ! backup_out="$(curl "${CURL_OPTS[@]}" -b "$JAR" -X POST "${BASE_URL}/api/admin/backup" 2>&1)"; then
  warn "$backup_out"
  fail "백업 API 호출에 실패했습니다.
      403 must_change_password → 이 계정으로 웹에 한 번 로그인해 비밀번호를 바꿔야 합니다.
      403 관리자만 사용할 수 있습니다 → 관리자 역할이 아닙니다."
fi

# jq 없이 파일 이름만 뽑는다: {"ok":true,"file":"app-20260906T030000.db",...}
BACKUP_FILE="$(printf '%s' "$backup_out" | tr -d '\n' | sed -n 's/.*"file"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$BACKUP_FILE" ] || { warn "$backup_out"; fail "응답에서 백업 파일 이름을 찾지 못했습니다."; }
log "생성됨: ${BACKUP_FILE}"

SRC_DB="${DATA_PATH}/backup/${BACKUP_FILE}"
if [ ! -f "$SRC_DB" ]; then
  # 컨테이너가 방금 쓴 파일이 호스트에 보이기까지의 경합은 사실상 없지만,
  # 그래도 못 찾으면 가장 최근 스냅샷으로 대신한다.
  warn "방금 만든 파일을 찾지 못했습니다: $SRC_DB — 가장 최근 스냅샷을 대신 보냅니다."
  SRC_DB="$(ls -1t "${DATA_PATH}/backup/"app-*.db 2>/dev/null | head -1 || true)"
  [ -n "$SRC_DB" ] || fail "보낼 백업 파일이 없습니다: ${DATA_PATH}/backup/"
fi
log "보낼 DB: $SRC_DB ($(du -h "$SRC_DB" | cut -f1))"

RSYNC_OPTS=(-a --human-readable)
[ "$DRY_RUN" = "1" ] && RSYNC_OPTS+=(--dry-run --verbose)

# ---- 3) NAS 로 전송 ---------------------------------------------------------
case "$MODE" in
  ssh)
    NAS_SSH_HOST="${NAS_SSH_HOST:?NAS_SSH_HOST 가 필요합니다}"
    NAS_SSH_USER="${NAS_SSH_USER:?NAS_SSH_USER 가 필요합니다}"
    NAS_DEST="${NAS_DEST:?NAS_DEST 가 필요합니다}"
    SSH_CMD=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p "${NAS_SSH_PORT:-22}")
    [ -n "${NAS_SSH_KEY:-}" ] && SSH_CMD+=(-i "$NAS_SSH_KEY")
    REMOTE="${NAS_SSH_USER}@${NAS_SSH_HOST}"
    # rsync 의 -e 는 문자열을 공백으로만 쪼갠다(따옴표를 해석하지 않는다).
    # 그래서 키 경로 등에 공백이 없어야 한다 — 있으면 공백 없는 경로로 옮길 것.
    SSH_RSH="${SSH_CMD[*]}"

    log "NAS(ssh) 준비: ${REMOTE}:${NAS_DEST}"
    "${SSH_CMD[@]}" "$REMOTE" "mkdir -p '${NAS_DEST}/db' '${NAS_DEST}/files'" \
      || fail "NAS 에 SSH 로 붙지 못했습니다. 키 등록과 NAS 의 SSH 서비스를 확인하세요."

    # DB 스냅샷: 한 개만 보낸다(--delete 없음 — NAS 에는 더 오래 쌓아 둔다).
    rsync "${RSYNC_OPTS[@]}" -e "$SSH_RSH" \
      "$SRC_DB" "${REMOTE}:${NAS_DEST}/db/"
    # 업로드 이미지: 증분 미러(앱에서 지운 파일은 NAS 에서도 지운다).
    rsync "${RSYNC_OPTS[@]}" --delete -e "$SSH_RSH" \
      "${DATA_PATH}/files/" "${REMOTE}:${NAS_DEST}/files/"

    if [ "$DRY_RUN" = "0" ] && [ "${KEEP}" -gt 0 ] 2>/dev/null; then
      log "NAS 의 DB 스냅샷을 최신 ${KEEP} 개만 남깁니다."
      "${SSH_CMD[@]}" "$REMOTE" \
        "cd '${NAS_DEST}/db' && ls -1t app-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do rm -f -- \"\$f\"; done" \
        || warn "NAS 쪽 정리에 실패했습니다(백업 자체는 끝났습니다)."
    fi
    DEST_SHOWN="${REMOTE}:${NAS_DEST}"
    ;;

  mount)
    DEST="${NAS_MOUNT_DEST:?NAS_MOUNT_DEST 가 필요합니다}"
    mountpoint -q "$DEST" 2>/dev/null || \
      warn "주의: ${DEST} 가 마운트포인트가 아닙니다. NAS 가 마운트돼 있는지 확인하세요(마운트가 풀린 채로 SD 카드에 쌓일 수 있습니다)."
    mkdir -p "${DEST}/db" "${DEST}/files" || fail "목적지를 만들 수 없습니다: $DEST"

    rsync "${RSYNC_OPTS[@]}" "$SRC_DB" "${DEST}/db/"
    rsync "${RSYNC_OPTS[@]}" --delete "${DATA_PATH}/files/" "${DEST}/files/"

    if [ "$DRY_RUN" = "0" ] && [ "${KEEP}" -gt 0 ] 2>/dev/null; then
      log "NAS 의 DB 스냅샷을 최신 ${KEEP} 개만 남깁니다."
      ls -1t "${DEST}/db/"app-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
        rm -f -- "$f"
      done
    fi
    DEST_SHOWN="$DEST"
    ;;

  *)
    fail "알 수 없는 BACKUP_MODE: ${MODE} (ssh 또는 mount)"
    ;;
esac

if [ "$DRY_RUN" = "1" ]; then
  log "--dry-run 이라 실제로 보내지 않았습니다."
else
  log "완료: ${BACKUP_FILE} + files/ → ${DEST_SHOWN}"
fi
