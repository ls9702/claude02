import type { Db } from "./db/index.js";
import { forbidden, notFound } from "./errors.js";
import type { PageRow, SessionRow, UserRow } from "./types.js";

export function isMember(db: Db, sessionId: string, userId: string): boolean {
  const row = db
    .prepare<[string, string], { c: number }>(
      "SELECT COUNT(*) AS c FROM session_members WHERE session_id = ? AND user_id = ?",
    )
    .get(sessionId, userId);
  return (row?.c ?? 0) > 0;
}

/**
 * 세션 조회 + 멤버 권한 검사. 관리자는 모든 세션을 통과한다.
 * 권한이 없으면 403 (존재 여부는 숨기지 않는다 — 프론트가 403 화면을 보여준다).
 */
export function requireSessionMember(db: Db, user: UserRow, sessionId: string): SessionRow {
  const session = db
    .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!session) throw notFound("세션을 찾을 수 없습니다.");
  if (user.role === "admin") return session;
  if (!isMember(db, sessionId, user.id)) {
    throw forbidden("이 세션에 접근할 권한이 없습니다.");
  }
  return session;
}

export interface PageAccess {
  page: PageRow;
  session: SessionRow;
}

/** 페이지 조회 + 소속 세션 권한 검사. */
export function requirePageAccess(db: Db, user: UserRow, pageId: string): PageAccess {
  const page = db.prepare<[string], PageRow>("SELECT * FROM pages WHERE id = ?").get(pageId);
  if (!page) throw notFound("페이지를 찾을 수 없습니다.");
  const session = requireSessionMember(db, user, page.session_id);
  return { page, session };
}

/**
 * 이 세션의 협업 룸에 접근할 수 있는 사용자 id 전부 (멤버 + 관리자).
 * 세션이 잠길 때 열려 있는 협업 소켓을 끊는 대상이다.
 */
export function userIdsWithSessionAccess(db: Db, sessionId: string): string[] {
  const members = db
    .prepare<[string], { user_id: string }>(
      "SELECT user_id FROM session_members WHERE session_id = ?",
    )
    .all(sessionId)
    .map((r) => r.user_id);
  const admins = db
    .prepare<[], { id: string }>("SELECT id FROM users WHERE role = 'admin'")
    .all()
    .map((r) => r.id);
  return [...new Set([...members, ...admins])];
}

/** 잠긴 세션은 관리자만 쓰기 가능. */
export function assertWritable(session: SessionRow, user: UserRow): void {
  if (session.locked === 1 && user.role !== "admin") {
    throw forbidden("잠긴 세션은 읽기 전용입니다.", "session_locked");
  }
}
