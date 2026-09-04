import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS } from "./schema.js";
import { nowIso } from "../ids.js";

export type Db = Database.Database;

export function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "app.db");
  mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare<[], { version: number }>("SELECT version FROM migrations").all();
  const applied = new Set(appliedRows.map((r) => r.version));

  const insert = db.prepare(
    "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, nowIso());
    });
    run();
  }
}
