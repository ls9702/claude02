import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db/index.js";

/**
 * SQLite 백업 — `VACUUM INTO` (PLAN §6, OPERATIONS.md).
 *
 * `VACUUM INTO` 는 열려 있는 DB 를 잠그지 않고 **정합성 있는 단일 파일**을 만든다.
 * WAL 모드에서 `app.db`/`app.db-wal`/`app.db-shm` 세 파일을 그냥 복사하면
 * 복사 중 체크포인트가 끼어 깨질 수 있어서, 파일 복사 대신 이 방법을 쓴다.
 *
 * 업로드된 이미지(`DATA_DIR/files`)는 여기서 다루지 않는다 — 볼륨 그대로 두고
 * NAS 의 Task Scheduler 에서 rsync 한다 (OPERATIONS.md 참고).
 */

/** 백업 파일을 두는 하위 디렉터리 */
export const BACKUP_DIR_NAME = "backup";
/** 보관 개수 */
export const KEEP_BACKUPS = 7;
/** 백업 파일 이름 규칙 */
const BACKUP_FILE_RE = /^app-\d{8}T\d{6}(?:-\d+)?\.db$/;

export interface BackupResult {
  /** 만들어진 백업 파일 이름 (`app-20260905T063000.db`) */
  file: string;
  /** 파일 크기 (바이트) */
  bytes: number;
  /** 정리 후 남아 있는 백업 파일 이름 (최신 순) */
  kept: string[];
  /** 이번에 지운 파일 이름 */
  removed: string[];
}

/** `2026-09-05T06:30:00.123Z` → `20260905T063000` */
export function backupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

export function backupDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIR_NAME);
}

/** 백업 디렉터리의 백업 파일을 최신 순으로 나열한다. */
export function listBackups(dataDir: string): string[] {
  const dir = backupDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => BACKUP_FILE_RE.test(name)).sort().reverse();
}

/**
 * 백업을 만들고 최신 `keep` 개만 남긴다.
 *
 * 이름은 UTC 초 단위라 같은 초에 두 번 부르면 충돌한다 — 그때는 `-1`, `-2` 를 붙인다.
 */
export function createBackup(db: Db, dataDir: string, keep = KEEP_BACKUPS): BackupResult {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });

  const base = `app-${backupTimestamp()}`;
  let file = `${base}.db`;
  for (let n = 1; existsQuiet(join(dir, file)); n += 1) file = `${base}-${n}.db`;

  const target = join(dir, file);
  // 경로를 SQL 리터럴로 넣지 않는다 — 바인딩 파라미터를 쓴다(따옴표 이스케이프 사고 방지).
  // VACUUM 은 트랜잭션 안에서 돌 수 없으므로 db.transaction 으로 감싸지 않는다.
  db.prepare("VACUUM INTO ?").run(target);

  const bytes = statSync(target).size;

  const all = listBackups(dataDir);
  const kept = all.slice(0, Math.max(1, keep));
  const removed = all.slice(Math.max(1, keep));
  for (const name of removed) rmSync(join(dir, name), { force: true });

  return { file, bytes, kept, removed };
}

function existsQuiet(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
