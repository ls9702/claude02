# syntax=docker/dockerfile:1
#
# app 컨테이너 — Fastify + SQLite + 사전 압축된 SPA 정적 서빙.
#
# 빌드 컨텍스트는 **저장소 루트**다:
#   docker buildx build --platform linux/arm64 -f backend/Dockerfile -t ds118-whiteboard-app:<tag> .
# (build-arm64.sh 가 이 명령을 감싼다)
#
# 4단계로 나눈다:
#   base      공통 설정
#   deps      전체 워크스페이스 의존성 (빌드에 필요한 devDependencies 포함)
#   build     프론트(vite + 폰트 복사 + 사전 압축) · 백엔드(tsc) 산출물
#   prod-deps 백엔드 워크스페이스의 **런타임 의존성만** 다시 설치
#   runtime   산출물 + 런타임 의존성만 담은 최종 이미지 (non-root)
#
# 최종 이미지에는 컴파일러도, 소스도, 프론트엔드 의존성(react·excalidraw…)도 들어가지 않는다.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: e2e 워크스페이스의 @playwright/test 가
# 이미지 안에서 브라우저를 내려받지 않게 한다 (빌드에 필요 없다).
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---------------------------------------------------------------- deps
FROM base AS deps
# better-sqlite3 는 prebuilt 바이너리를 **glibc** 기준으로 배포한다.
# alpine 은 musl 이라 arm64 prebuilt 를 못 받는 경우가 있고, 그때는 소스에서 컴파일한다
# (better-sqlite3 는 SQLite amalgamation 을 함께 배포하므로 인터넷 없이도 컴파일된다).
# 조건 분기 대신 빌드 스테이지에 도구를 항상 넣는다 — prebuilt 를 받으면 그냥 쓰이고,
# 못 받으면 자동으로 컴파일된다. 이 도구들은 최종 이미지에 남지 않는다.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY room/package.json room/
COPY e2e/package.json e2e/
# frontend 의 postinstall(폰트 복사 스크립트)이 install 중에 실행되므로 미리 넣어 둔다.
COPY frontend/scripts/ frontend/scripts/

RUN npm ci --workspaces --include-workspace-root \
 && node -e "require('better-sqlite3'); console.log('[deps] better-sqlite3 로드 확인 OK')"

# --------------------------------------------------------------- build
FROM deps AS build
COPY . .
# 프론트: prebuild(폰트 복사) → vite build → postbuild(brotli/gzip 사전 압축)
# 백엔드: tsc
RUN npm run build -w frontend \
 && npm run build -w backend

# ----------------------------------------------------------- prod-deps
FROM deps AS prod-deps
# 백엔드 워크스페이스의 런타임 의존성만 남긴다 (react·excalidraw·vite 등은 들어오지 않는다).
RUN npm ci --omit=dev --workspace @ds118/backend --include-workspace-root

# ------------------------------------------------------------- runtime
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    FRONTEND_DIST=/app/frontend/dist

# 데이터 볼륨 — SQLite(app.db)·업로드 파일(files/)·백업(backup/) 이 모두 여기 있다.
# 컨테이너는 uid 1000(node)으로 돌기 때문에 호스트 쪽 디렉터리도 그 uid 가 쓸 수 있어야 한다
# (SETUP.md 4단계의 chown 안내 참고).
RUN mkdir -p /data && chown -R node:node /data

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist

USER node
WORKDIR /app/backend
EXPOSE 3001
VOLUME ["/data"]

# 헬스체크는 `/api/health` 를 본다 (DB 질의까지 확인한다).
# 릴레이(room)가 죽어도 unhealthy 로 떨어뜨리지 않는다 — health.ts 의 주석 참고.
# curl/wget 을 설치하지 않으려고 node 의 fetch 를 쓴다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

# exec 형식 — node 가 PID 1 이 되어 SIGTERM 을 직접 받는다 (index.ts 의 정상 종료).
CMD ["node", "dist/index.js"]
