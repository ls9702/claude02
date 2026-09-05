import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { MIGRATIONS } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/passwords.js";
import { buildServer } from "../src/server.js";
import { authHeaders, login } from "./helpers.js";

/**
 * 기존(마이그레이션 v1) DB 를 만든다 — files 에 page_id 컬럼이 있던 시절의 스키마.
 */
async function seedLegacyDb(dataDir: string): Promise<{ fileId: string; pageId: string }> {
  const db = new Database(join(dataDir, "app.db"));
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  db.exec(MIGRATIONS[0]!.sql);
  db.prepare("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
    1,
    MIGRATIONS[0]!.name,
    "2026-01-01T00:00:00.000Z",
  );

  const at = "2026-01-01T00:00:00.000Z";
  const hash = await hashPassword("legacyadmin1234");
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, ai_allowed, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 'admin', 1, 0, ?, ?)",
  ).run("u-legacy", "legacyadmin", hash, at, at);
  db.prepare(
    "INSERT INTO sessions (id, name, locked, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)",
  ).run("s-legacy", "옛 세션", "u-legacy", at, at);
  db.prepare(
    `INSERT INTO pages (id, session_id, name, type, position, room_id, room_key, thumbnail, created_at, updated_at)
     VALUES (?, ?, ?, 'canvas', 0, ?, ?, NULL, ?, ?)`,
  ).run("p-legacy", "s-legacy", "옛 페이지", "0".repeat(20), "k".repeat(22), at, at);

  // 예전 경로: files/<pageId>/<fileId>
  const relative = join("files", "p-legacy", "legacyfile1");
  db.prepare(
    "INSERT INTO files (id, page_id, mime, size, path, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("legacyfile1", "p-legacy", "image/png", 4, relative, at, "u-legacy");
  db.close();

  mkdirSync(join(dataDir, "files", "p-legacy"), { recursive: true });
  writeFileSync(join(dataDir, relative), Buffer.from([1, 2, 3, 4]));
  return { fileId: "legacyfile1", pageId: "p-legacy" };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ds118-migrate-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("마이그레이션 v1 → v2 (page_files 링크 테이블)", () => {
  it("기존 files 행을 page_files 링크로 옮기고 path 를 그대로 유지한다", async () => {
    const seeded = await seedLegacyDb(dataDir);

    const db = openDatabase(dataDir);
    try {
      const link = db
        .prepare<[string], { page_id: string; file_id: string }>(
          "SELECT page_id, file_id FROM page_files WHERE file_id = ?",
        )
        .get(seeded.fileId);
      expect(link).toEqual({ page_id: seeded.pageId, file_id: seeded.fileId });

      // files 에서 page_id 컬럼이 사라지고 나머지 값은 그대로다 (파일은 옮기지 않는다).
      const columns = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('files')")
        .all()
        .map((c) => c.name);
      expect(columns).toEqual(["id", "mime", "size", "path", "created_at", "created_by"]);
      const row = db
        .prepare<[string], { path: string; mime: string }>("SELECT path, mime FROM files WHERE id = ?")
        .get(seeded.fileId)!;
      expect(row.path).toBe(join("files", seeded.pageId, seeded.fileId));

      // 외래키 무결성이 깨지지 않았고, FK 강제도 다시 켜져 있다.
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

      // 다시 열어도(이미 적용됨) 문제가 없다.
      db.close();
      const again = openDatabase(dataDir);
      expect(
        again.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM page_files").get()!.c,
      ).toBe(1);
      again.close();
    } catch (err) {
      db.close();
      throw err;
    }
  });

  it("마이그레이션 후에도 예전 경로의 파일을 그대로 서빙한다", async () => {
    const seeded = await seedLegacyDb(dataDir);

    const base = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, COOKIE_SECURE: "false" });
    const app = await buildServer({ config: { ...base, dataDir }, logger: false });
    await app.ready();
    try {
      const sid = await login(app, "legacyadmin", "legacyadmin1234");
      const res = await app.inject({
        method: "GET",
        url: `/files/${seeded.fileId}`,
        headers: authHeaders(sid),
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
