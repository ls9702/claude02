import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const backendDir = resolve(repoRoot, "backend");

/** E2E 전용 임시 DATA_DIR — 매 실행마다 비운다. */
const DATA_DIR = resolve(here, ".tmp/data");

export const BASE_URL = "http://localhost:5173";
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
      env: { VITE_E2E: "1" },
    },
  ],
});
