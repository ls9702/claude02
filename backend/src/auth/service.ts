import type { Db } from "../db/index.js";
import { SESSION_TOUCH_INTERVAL_MS, SESSION_TTL_MS } from "../config.js";
import { newId, nowIso } from "../ids.js";
import { hashPassword } from "./passwords.js";
import type { AuthSessionRow, Role, UserRow } from "../types.js";

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE username = ?")
    .get(username);
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
}

export async function createUser(
  db: Db,
  input: { username: string; password: string; role?: Role; mustChangePassword?: boolean },
): Promise<UserRow> {
  const id = newId();
  const at = nowIso();
  const hash = await hashPassword(input.password);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, ai_allowed, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, input.username, hash, input.role ?? "user", input.mustChangePassword ? 1 : 0, at, at);
  return findUserById(db, id)!;
}

export function countUsers(db: Db): number {
  return db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users").get()!.c;
}

/**
 * 최초 기동 부트스트랩. users 테이블이 비어 있으면 환경변수의 관리자 계정을 만든다.
 * `must_change_password = 1` 로 만들어 첫 로그인 후 비밀번호 변경을 강제한다.
 */
export async function bootstrapAdmin(
  db: Db,
  opts: { username: string; password: string | null },
): Promise<UserRow | null> {
  if (countUsers(db) > 0) return null;
  if (!opts.password) {
    throw new Error(
      "최초 기동에는 ADMIN_PASSWORD 환경변수가 필요합니다. .env.example 을 참고해 설정해 주세요.",
    );
  }
  return createUser(db, {
    username: opts.username,
    password: opts.password,
    role: "admin",
    mustChangePassword: true,
  });
}

export function createAuthSession(
  db: Db,
  userId: string,
  userAgent: string | null,
  now = new Date(),
): AuthSessionRow {
  const id = newId();
  const at = now.toISOString();
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, at, at, expires, userAgent);
  return db
    .prepare<[string], AuthSessionRow>("SELECT * FROM auth_sessions WHERE id = ?")
    .get(id)!;
}

export function deleteAuthSession(db: Db, id: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
}

export function deleteAuthSessionsForUser(db: Db, userId: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
}

export function getAuthSession(db: Db, id: string): AuthSessionRow | undefined {
  return db
    .prepare<[string], AuthSessionRow>("SELECT * FROM auth_sessions WHERE id = ?")
    .get(id);
}

export interface TouchResult {
  session: AuthSessionRow;
  refreshed: boolean;
}

/**
 * 슬라이딩 만료 갱신. 매 요청마다 DB 쓰기를 하지 않도록
 * 마지막 갱신으로부터 `SESSION_TOUCH_INTERVAL_MS` 이상 지난 경우에만 기록한다.
 */
export function touchAuthSession(
  db: Db,
  session: AuthSessionRow,
  now = new Date(),
): TouchResult {
  const lastSeen = Date.parse(session.last_seen_at);
  if (Number.isFinite(lastSeen) && now.getTime() - lastSeen < SESSION_TOUCH_INTERVAL_MS) {
    return { session, refreshed: false };
  }
  const at = now.toISOString();
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
    at,
    expires,
    session.id,
  );
  return { session: { ...session, last_seen_at: at, expires_at: expires }, refreshed: true };
}

export function isExpired(session: AuthSessionRow, now = new Date()): boolean {
  const expires = Date.parse(session.expires_at);
  return !Number.isFinite(expires) || expires <= now.getTime();
}

export function purgeExpiredSessions(db: Db, now = new Date()): void {
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now.toISOString());
}
