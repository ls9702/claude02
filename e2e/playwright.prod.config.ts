import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * 프로덕션 모드 스모크 (`npm run e2e:prod`).
 *
 * dev e2e(`playwright.config.ts`)와 다른 점:
 *  - 백엔드를 **빌드 산출물**(`backend/dist/index.js`)로, `NODE_ENV=production` 으로 띄운다.
 *  - Vite dev 서버가 없다. SPA 는 app 이 `frontend/dist` 에서 직접 서빙한다
 *    (사전 압축본 `*.br`/`*.gz` + 장기 캐시 헤더 + 프로덕션 CSP).
 *  - 포트를 3901/3902/3903 으로 옮긴다 — 같은 머신에서 다른 사람이 dev e2e
 *    (3001/3002/3003/5173)를 돌리고 있어도 부딪히지 않는다.
 *  - 상태 디렉터리도 `.state-prod` 로 나눈다.
 *
 * 먼저 `npm run build` 가 되어 있어야 한다 (루트 스크립트가 순서를 잡는다).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const backendDir = resolve(repoRoot, "backend");
const roomDir = resolve(repoRoot, "room");

export const APP_PORT = 3901;
export const ROOM_PORT = 3902;
export const MOCK_GEMINI_PORT = 3903;

export const BASE_URL = `http://localhost:${APP_PORT}`;
export const MOCK_GEMINI_URL = `http://127.0.0.1:${MOCK_GEMINI_PORT}`;

/** 프로덕션 스모크 전용 임시 DATA_DIR — 매 실행마다 비운다. */
const DATA_DIR = resolve(here, ".tmp/data-prod");

// 테스트 워커도 이 설정 파일을 읽는다 — fixtures.ts 가 여기서 오리진·상태 경로를 가져간다.
process.env.E2E_STATE_DIR = ".state-prod";
process.env.E2E_BASE_URL = BASE_URL;

export default defineConfig({
  outputDir: "./test-results-prod",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "setup",
      testDir: "./tests",
      testMatch: /setup\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "prod",
      testDir: "./prod-tests",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // tsx 로더가 아니라 `node dist/index.js` — NAS 에서 도는 것과 같은 형태다.
      command: `rm -rf "${DATA_DIR}" && mkdir -p "${DATA_DIR}" && node dist/index.js`,
      cwd: backendDir,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "production",
        PORT: String(APP_PORT),
        HOST: "127.0.0.1",
        DATA_DIR,
        FRONTEND_DIST: resolve(repoRoot, "frontend/dist"),
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "admin1234",
        // 로컬 스모크는 HTTP 라 Secure 쿠키를 켤 수 없다.
        // (Secure·TRUST_PROXY 동작은 backend/test/deploy.test.ts + auth.test.ts 가 본다.)
        COOKIE_SECURE: "false",
        TRUST_PROXY: "1",
        PUBLIC_URL: BASE_URL,
        ROOM_URL: `http://127.0.0.1:${ROOM_PORT}`,
        GEMINI_API_KEY: "e2e-test-key",
        GEMINI_BASE_URL: MOCK_GEMINI_URL,
        APP_VERSION: "e2e-prod",
      },
    },
    {
      command: "node mock-gemini.mjs",
      cwd: here,
      url: `${MOCK_GEMINI_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { PORT: String(MOCK_GEMINI_PORT), HOST: "127.0.0.1" },
    },
    {
      command: "node dist/index.js",
      cwd: roomDir,
      url: `http://127.0.0.1:${ROOM_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "production",
        PORT: String(ROOM_PORT),
        HOST: "127.0.0.1",
      },
    },
  ],
});
