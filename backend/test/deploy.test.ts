import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_DIR_NAME, KEEP_BACKUPS, backupTimestamp, createBackup, listBackups } from "../src/backup.js";
import { checkDb, createRoomProbe, probeRoom } from "../src/health.js";
import { buildCsp, inlineScriptBodies, sha256Source, staticCacheControl, websocketOrigin } from "../src/security.js";
import { authHeaders, createTestApp, login, ADMIN_PASSWORD, ADMIN_USERNAME, type TestApp } from "./helpers.js";

/** M6 배포 준비: 백업 · 헬스 · CSP · 캐시 헤더 */
describe("M6 배포", () => {
  let ctx: TestApp;
  let adminSid: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    adminSid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
  });

  afterEach(async () => {
    await ctx.close();
  });

  // ---- POST /api/admin/backup -------------------------------------------
  describe("POST /api/admin/backup", () => {
    it("VACUUM INTO 로 열 수 있는 백업 파일을 만든다", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/admin/backup",
        headers: authHeaders(adminSid),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.file).toMatch(/^app-\d{8}T\d{6}(-\d+)?\.db$/);
      expect(body.bytes).toBeGreaterThan(0);
      expect(body.kept).toContain(body.file);

      const path = join(ctx.dataDir, BACKUP_DIR_NAME, body.file);
      expect(existsSync(path)).toBe(true);

      // 백업본이 실제로 열리고 원본 데이터(부트스트랩 관리자)가 들어 있어야 한다.
      const copy = new Database(path, { readonly: true });
      try {
        const row = copy
          .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM users WHERE username = ?")
          .get(ADMIN_USERNAME);
        expect(row?.c).toBe(1);
      } finally {
        copy.close();
      }
    });

    it("WAL 에만 있던 최신 변경도 백업본에 들어간다", async () => {
      const created = await ctx.app.inject({
        method: "POST",
        url: "/api/admin/sessions",
        headers: authHeaders(adminSid),
        payload: { name: "백업직전세션" },
      });
      expect(created.statusCode).toBe(201);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/admin/backup",
        headers: authHeaders(adminSid),
      });
      const path = join(ctx.dataDir, BACKUP_DIR_NAME, res.json().file);
      const copy = new Database(path, { readonly: true });
      try {
        const row = copy
          .prepare<[], { name: string }>("SELECT name FROM sessions ORDER BY created_at DESC LIMIT 1")
          .get();
        expect(row?.name).toBe("백업직전세션");
      } finally {
        copy.close();
      }
    });

    it("관리자가 아니면 403 이다", async () => {
      const userRes = await ctx.app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: authHeaders(adminSid),
        payload: { username: "backupuser", password: "userpass1234" },
      });
      expect(userRes.statusCode).toBe(201);

      const sid = await login(ctx.app, "backupuser", "userpass1234");
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/admin/backup",
        headers: authHeaders(sid),
      });
      expect(res.statusCode).toBe(403);
    });

    it("로그인하지 않으면 401 이다", async () => {
      const res = await ctx.app.inject({ method: "POST", url: "/api/admin/backup" });
      expect(res.statusCode).toBe(401);
    });

    it("최신 7개만 남기고 오래된 것을 지운다", () => {
      const dir = join(ctx.dataDir, BACKUP_DIR_NAME);
      mkdirSync(dir, { recursive: true });
      // 이미 10개가 쌓여 있다고 두고 한 번 더 만든다.
      for (let i = 0; i < 10; i += 1) {
        writeFileSync(join(dir, `app-2026010${i}T000000.db`), "old");
      }
      expect(listBackups(ctx.dataDir)).toHaveLength(10);

      const result = createBackup(ctx.app.db, ctx.dataDir, KEEP_BACKUPS);
      const kept = listBackups(ctx.dataDir);
      expect(kept).toHaveLength(KEEP_BACKUPS);
      expect(kept[0]).toBe(result.file);
      // 가장 오래된 것부터 사라진다.
      expect(kept).not.toContain("app-20260100T000000.db");
      expect(readdirSync(dir)).toHaveLength(KEEP_BACKUPS);
    });

    it("같은 초에 두 번 불러도 파일이 겹치지 않는다", () => {
      const first = createBackup(ctx.app.db, ctx.dataDir);
      const second = createBackup(ctx.app.db, ctx.dataDir);
      expect(second.file).not.toBe(first.file);
      expect(listBackups(ctx.dataDir)).toEqual(expect.arrayContaining([first.file, second.file]));
    });

    it("GET /api/admin/backup 은 목록을 최신 순으로 돌려준다", async () => {
      createBackup(ctx.app.db, ctx.dataDir);
      createBackup(ctx.app.db, ctx.dataDir);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/admin/backup",
        headers: authHeaders(adminSid),
      });
      expect(res.statusCode).toBe(200);
      const { backups, keep } = res.json();
      expect(keep).toBe(KEEP_BACKUPS);
      expect(backups).toHaveLength(2);
      expect([...backups].sort().reverse()).toEqual(backups);
    });

    it("backupTimestamp 는 정렬 가능한 UTC 초 단위 문자열이다", () => {
      const a = backupTimestamp(new Date("2026-01-02T03:04:05.678Z"));
      const b = backupTimestamp(new Date("2026-01-02T03:04:06.000Z"));
      expect(a).toBe("20260102T030405");
      expect(a < b).toBe(true);
    });
  });

  // ---- GET /api/health ---------------------------------------------------
  describe("GET /api/health", () => {
    it("db·room·uptime 을 담아 200 으로 답한다", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.db).toBe("ok");
      // 테스트에서는 릴레이가 떠 있지 않다 — 그래도 ok 는 true 여야 한다.
      expect(["ok", "down"]).toContain(body.room);
      expect(typeof body.uptime).toBe("number");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("릴레이가 죽어도 ok 는 true 다 (도커가 app 을 재시작하지 않게)", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
      expect(res.json().room).toBe("down");
      expect(res.json().ok).toBe(true);
    });

    it("checkDb 는 닫힌 DB 에서 error 를 돌려준다", () => {
      const db = new Database(":memory:");
      expect(checkDb(db)).toBe("ok");
      db.close();
      expect(checkDb(db)).toBe("error");
    });

    it("probeRoom 은 닿지 않는 주소에서 down 이다", async () => {
      // 사용하지 않는 포트 — 즉시 ECONNREFUSED.
      expect(await probeRoom("http://127.0.0.1:1", 500)).toBe("down");
    });

    it("createRoomProbe 는 결과를 캐시한다 (헬스체크가 부하가 되지 않게)", async () => {
      let hits = 0;
      const stub = createServer((_req, res) => {
        hits += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Excalidraw collaboration server is up :)");
      });
      await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
      const { port } = stub.address() as AddressInfo;
      try {
        const probe = createRoomProbe(`http://127.0.0.1:${port}`, { cacheMs: 10_000, timeoutMs: 1_000 });
        expect(await probe()).toBe("ok");
        expect(await probe()).toBe("ok");
        expect(await probe()).toBe("ok");
        // 3번 물어봐도 실제 요청은 1번이다.
        expect(hits).toBe(1);
      } finally {
        await new Promise<void>((done) => stub.close(() => done()));
      }
    });
  });

  // ---- CSP ---------------------------------------------------------------
  describe("CSP (프로덕션 전용)", () => {
    it("개발/테스트 모드에는 붙지 않는다", async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });

    it("업로드 파일 라우트의 엄격한 CSP 는 그대로다", async () => {
      // 파일 라우트 자체는 files.test.ts 가 본다 — 여기서는 헤더가 겹치지 않는지만 확인한다.
      const csp = buildCsp();
      expect(csp).not.toContain("sandbox");
    });

    it("Excalidraw 가 요구하는 것만 열려 있다", () => {
      const csp = buildCsp({ publicUrl: "https://draw.863ad.co.kr" });
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("wss://draw.863ad.co.kr");
      // eval 은 열지 않는다 (wasm 은 별개 키워드다).
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    });

    it("인라인 스크립트는 해시로 허용한다", () => {
      const html = `<script>window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";</script>
        <script type="module" src="/assets/index-abc.js"></script>`;
      const bodies = inlineScriptBodies(html);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain("EXCALIDRAW_ASSET_PATH");

      const csp = buildCsp({ scriptHashes: bodies.map(sha256Source) });
      expect(csp).toMatch(/script-src [^;]*'sha256-[A-Za-z0-9+/=]+'/);
    });

    it("websocketOrigin 은 스킴을 맞춰 바꾼다", () => {
      expect(websocketOrigin("https://draw.863ad.co.kr")).toBe("wss://draw.863ad.co.kr");
      expect(websocketOrigin("http://localhost:3001")).toBe("ws://localhost:3001");
      expect(websocketOrigin("보통문자열")).toBeNull();
    });
  });

  // ---- 정적 캐시 헤더 -----------------------------------------------------
  describe("정적 자산 Cache-Control", () => {
    it("해시 파일명 자산은 1년 immutable 이다", () => {
      expect(staticCacheControl("/app/frontend/dist/assets/index-BE6GJL8D.js")).toBe(
        "public, max-age=31536000, immutable",
      );
      // 사전 압축본도 원본 확장자로 판단한다.
      expect(staticCacheControl("/app/frontend/dist/assets/index-BE6GJL8D.js.br")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(staticCacheControl("/app/frontend/dist/excalidraw-assets/fonts/Excalifont.woff2")).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    it("index.html 은 no-cache 다 (새 배포가 바로 보이게)", () => {
      expect(staticCacheControl("/app/frontend/dist/index.html")).toBe("no-cache");
      expect(staticCacheControl("/app/frontend/dist/index.html.br")).toBe("no-cache");
    });
  });
});
