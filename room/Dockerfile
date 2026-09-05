# syntax=docker/dockerfile:1
#
# room 컨테이너 — excalidraw-room 릴레이 (무상태, 업스트림 프로토콜 그대로).
#
# 빌드 컨텍스트는 **저장소 루트**다:
#   docker buildx build --platform linux/arm64 -f room/Dockerfile -t ds118-whiteboard-room:<tag> .
#
# app 과 같은 베이스(node:22-alpine)를 쓴다 — NAS 에서 레이어를 공유해 디스크를 아낀다.
# 네이티브 의존성이 없어서 컴파일러가 필요 없다.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY room/package.json room/
COPY e2e/package.json e2e/
RUN npm ci --workspace @ds118/room --include-workspace-root

# --------------------------------------------------------------- build
FROM deps AS build
COPY room/ room/
RUN npm run build -w room

# ----------------------------------------------------------- prod-deps
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY room/package.json room/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --workspace @ds118/room --include-workspace-root

# ------------------------------------------------------------- runtime
FROM base AS runtime

# 업스트림 기본 포트는 80(비-root 가 바인드할 수 없다) — 여기서 3002 로 못 박는다.
ENV NODE_ENV=production \
    PORT=3002 \
    HOST=0.0.0.0

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/room/package.json ./room/package.json
COPY --from=build --chown=node:node /app/room/dist ./room/dist

USER node
WORKDIR /app/room
EXPOSE 3002

# 릴레이는 상태가 없으므로 루트 응답(업스트림이 그대로 갖고 있는 라우트)으로 확인한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
