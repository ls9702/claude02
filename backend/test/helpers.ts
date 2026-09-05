import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

export interface TestApp {
  app: FastifyInstance;
  dataDir: string;
  close(): Promise<void>;
}

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "admin1234";

export interface TestAppOptions {
  /**
   * 부트스트랩 관리자의 `must_change_password` 플래그를 그대로 둘지 여부.
   * 기본값은 해제 — 대부분의 테스트는 강제 비밀번호 변경 가드와 무관하기 때문이다.
   * (가드 자체는 auth.test.ts 의 "강제 비밀번호 변경" describe 에서 검증한다.)
   */
  keepPasswordChange?: boolean;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "ds118-test-"));
  const base = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    COOKIE_SECURE: "false",
  });
  const app = await buildServer({ config: { ...base, dataDir }, logger: false });
  await app.ready();
  if (!options.keepPasswordChange) {
    app.db
      .prepare("UPDATE users SET must_change_password = 0 WHERE username = ?")
      .run(ADMIN_USERNAME);
  }
  return {
    app,
    dataDir,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Set-Cookie 헤더에서 sid 쿠키 값을 뽑는다. */
export function extractCookie(headers: unknown, name = "sid"): string | null {
  const raw = (headers as Record<string, string | string[] | undefined>)["set-cookie"];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(entry);
    if (match && match[1]) return match[1];
  }
  return null;
}

export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`로그인 실패 (${res.statusCode}): ${res.body}`);
  }
  const sid = extractCookie(res.headers);
  if (!sid) throw new Error("sid 쿠키가 없습니다.");
  return sid;
}

export const authHeaders = (sid: string) => ({ cookie: `sid=${sid}` });
