import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const backendDir = resolve(repoRoot, "backend");
const roomDir = resolve(repoRoot, "room");

/** E2E 전용 임시 DATA_DIR — 매 실행마다 비운다. */
const DATA_DIR = resolve(here, ".tmp/data");

export const BASE_URL = "http://localhost:5173";
/** E2E 용 가짜 Gemini (`e2e/mock-gemini.mjs`) — 진짜 Google 을 부르지 않는다. */
export const MOCK_GEMINI_URL = "http://127.0.0.1:3003";
export const STATE_DIR = resolve(here, ".state");

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  // Excalidraw 첫 로딩이 느려서 넉넉하게 잡는다.
  timeout: 90_000,
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
      testMatch: /setup\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "main",
      testIgnore: /setup\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // 매 실행마다 새 DB 로 시작해야 관리자 부트스트랩(ADMIN_PASSWORD)이 동작한다.
      command: `rm -rf "${DATA_DIR}" && mkdir -p "${DATA_DIR}" && node --import tsx src/index.ts`,
      cwd: backendDir,
      url: "http://localhost:3001/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "development",
        PORT: "3001",
        HOST: "127.0.0.1",
        DATA_DIR,
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "admin1234",
        COOKIE_SECURE: "false",
        PUBLIC_URL: BASE_URL,
        ROOM_URL: "http://127.0.0.1:3002",
        // AI 프록시는 켜 두되 업스트림만 가짜로 바꾼다 (키는 서버에만 있다는 구조 그대로).
        GEMINI_API_KEY: "e2e-test-key",
        GEMINI_BASE_URL: MOCK_GEMINI_URL,
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
      env: { PORT: "3003", HOST: "127.0.0.1" },
    },
    {
      // 실시간 협업 릴레이. 브라우저는 여기에 직접 붙지 않고 app 의 /socket.io 프록시를 거친다.
      command: "node --import tsx src/index.ts",
      cwd: roomDir,
      url: "http://127.0.0.1:3002/",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "development",
        PORT: "3002",
        HOST: "127.0.0.1",
      },
    },
    {
      command: "npm run dev -w frontend -- --host 127.0.0.1",
      cwd: repoRoot,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      // 저장되지 않은 변경이 있어도 이탈 확인 대화상자를 띄우지 않는다 (자동화 중 reload/close 를 막지 않게).
      // 룸 재검증·씬 폴링 주기는 테스트에서 기다릴 수 있게 줄인다 (기본 30초/15초).
      env: {
        VITE_E2E: "1",
        VITE_DISABLE_PREVENT_UNLOAD: "1",
        VITE_ROOM_RECHECK_MS: "2000",
        VITE_SCENE_POLL_MS: "2000",
      },
    },
  ],
});
