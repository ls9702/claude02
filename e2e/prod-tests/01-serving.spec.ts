import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ADMIN_STATE, ALICE_STATE, APP_BASE_URL } from "../tests/fixtures";
import { openPage } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 프로덕션 서빙 계약 — 사전 압축 · 캐시 헤더 · CSP · 헬스.
 * (dev 모드에서는 Vite 가 서빙하므로 이 성질들이 아예 존재하지 않는다.)
 */

test("index.html 은 프로덕션 CSP 와 no-cache 로 내려온다", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);

  const csp = res.headers()["content-security-policy"];
  expect(csp, "프로덕션에는 CSP 가 있어야 한다").toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("worker-src 'self' blob:");
  // 인라인 스크립트는 'unsafe-inline' 이 아니라 해시로 허용한다.
  expect(csp).toMatch(/script-src [^;]*'sha256-/);
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");

  expect(res.headers()["cache-control"]).toBe("no-cache");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
});

test("해시 자산은 사전 압축본으로, 1년 immutable 로 내려온다", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(asset, "index.html 에서 진입 스크립트를 찾지 못했다").toBeTruthy();

  const br = await request.get(asset!, { headers: { "accept-encoding": "br" } });
  expect(br.status()).toBe(200);
  // Playwright 는 content-encoding 을 풀어서 주지만 헤더는 그대로 보여 준다.
  expect(br.headers()["content-encoding"]).toBe("br");
  expect(br.headers()["content-type"]).toContain("javascript");
  expect(br.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(br.headers()["vary"]).toContain("accept-encoding");

  const gz = await request.get(asset!, { headers: { "accept-encoding": "gzip" } });
  expect(gz.headers()["content-encoding"]).toBe("gzip");

  // 압축을 못 받는 클라이언트에게는 원본을 준다.
  const raw = await request.get(asset!, { headers: { "accept-encoding": "identity" } });
  expect(raw.status()).toBe(200);
  expect(raw.headers()["content-encoding"]).toBeUndefined();
});

test("자체 호스팅 폰트도 immutable 로 내려온다 (외부 CDN 을 부르지 않는다)", async ({ request }) => {
  const fontsRoot = resolve(here, "../../frontend/dist/excalidraw-assets/fonts");
  const family = readdirSync(fontsRoot)[0]!;
  const file = readdirSync(join(fontsRoot, family)).find((n) => n.endsWith(".woff2"))!;
  expect(file, "복사된 Excalidraw 폰트를 찾지 못했다").toBeTruthy();

  const res = await request.get(`/excalidraw-assets/fonts/${family}/${file}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
});

test("SPA 폴백은 index.html 을 주고 API 경로는 404 JSON 이다", async ({ request }) => {
  const spa = await request.get("/s/none/p/none");
  expect(spa.status()).toBe(200);
  expect(await spa.text()).toContain("<div id=\"root\">");
  expect(spa.headers()["cache-control"]).toBe("no-cache");

  const api = await request.get("/api/없는것");
  expect(api.status()).toBe(404);
  expect((await api.json()).error.code).toBe("not_found");
});

test("헬스는 DB 와 릴레이 상태를 함께 알린다", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.db).toBe("ok");
  expect(body.room).toBe("ok"); // room 컨테이너가 떠 있다
  expect(body.version).toBe("e2e-prod");
  expect(res.headers()["cache-control"]).toBe("no-store");
});

test("관리자 백업 엔드포인트가 프로덕션 빌드에서 동작한다", async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: APP_BASE_URL, storageState: ADMIN_STATE });
  const res = await api.post("/api/admin/backup");
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.bytes).toBeGreaterThan(0);
  expect(body.kept.length).toBeGreaterThanOrEqual(1);
  expect(body.keep).toBe(7);

  const list = await api.get("/api/admin/backup");
  expect((await list.json()).backups).toContain(body.file);
  await api.dispose();
});

test("로그인 화면이 CSP 아래에서 그대로 뜬다", async ({ browser }) => {
  const { page, close } = await openPage(browser, ALICE_STATE, "/");
  await expect(page.getByRole("heading", { name: "내 세션" })).toBeVisible();
  await close();
});
