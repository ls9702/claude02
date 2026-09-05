import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import type { FileRow, UserRow } from "../types.js";

/**
 * 파일 소유권 모델
 *
 * `files` 는 내용(= Excalidraw 가 내용 해시로 만든 fileId) 하나당 한 행이고,
 * 어느 페이지에서 쓰이는지는 `page_files` 링크 테이블이 가진다.
 * 같은 이미지를 여러 세션·여러 페이지에 붙여도 파일은 하나만 저장되고,
 * 페이지가 지워지면 링크만 끊긴다. 링크가 0개가 된 파일만 디스크에서 지운다.
 *
 * 링크는 **페이지 삭제 시에만** 끊는다. 씬에서 이미지 요소를 지웠다고 끊으면
 * 스냅샷 복원으로 되살아난 이미지가 깨지기 때문이다.
 */

/** 파일 저장 경로 (페이지와 무관 — 내용 해시라 여러 페이지가 공유한다) */
export const filePathFor = (fileId: string): string => join("files", fileId);

/** 특정 페이지들에 링크된 파일 id 목록 */
export function fileIdsForPages(db: Db, pageIds: readonly string[]): string[] {
  if (pageIds.length === 0) return [];
  const placeholders = pageIds.map(() => "?").join(",");
  return db
    .prepare<string[], { file_id: string }>(
      `SELECT DISTINCT file_id FROM page_files WHERE page_id IN (${placeholders})`,
    )
    .all(...pageIds)
    .map((r) => r.file_id);
}

/** 한 세션에 속한 페이지 id 목록 */
export function pageIdsForSession(db: Db, sessionId: string): string[] {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM pages WHERE session_id = ?")
    .all(sessionId)
    .map((r) => r.id);
}

/** 페이지 링크가 하나도 남지 않은 파일을 DB·디스크에서 지운다. */
export async function pruneOrphanFiles(
  db: Db,
  dataDir: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const fileId of candidateIds) {
    const row = db.prepare<[string], FileRow>("SELECT * FROM files WHERE id = ?").get(fileId);
    if (!row) continue;
    const links = db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM page_files WHERE file_id = ?")
      .get(fileId);
    if ((links?.c ?? 0) > 0) continue;

    db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
    try {
      await unlink(join(dataDir, row.path));
    } catch {
      // 이미 없는 파일은 무시한다 (DB 행 정리는 끝났다).
    }
    removed.push(fileId);
  }
  return removed;
}

/**
 * 파일 접근 권한: 사용자가 접근할 수 있는 페이지 중 **하나라도** 이 파일과 링크되어 있으면 허용.
 * 관리자는 링크가 하나라도 있으면 통과한다. 쿼리 한 번으로 판정한다.
 */
export function canAccessFile(db: Db, user: UserRow, fileId: string): boolean {
  if (user.role === "admin") {
    const any = db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM page_files WHERE file_id = ?")
      .get(fileId);
    return (any?.c ?? 0) > 0;
  }
  const row = db
    .prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c
         FROM page_files pf
         JOIN pages p ON p.id = pf.page_id
         JOIN session_members m ON m.session_id = p.session_id
        WHERE pf.file_id = ? AND m.user_id = ?`,
    )
    .get(fileId, user.id);
  return (row?.c ?? 0) > 0;
}
