import type { FastifyInstance } from "fastify";
import { userIdsWithSessionAccess } from "../access.js";
import { requireAdmin } from "../auth/plugin.js";
import { checkPasswordPolicy, hashPassword } from "../auth/passwords.js";
import { createUser, deleteAuthSessionsForUser, findUserById, findUserByUsername } from "../auth/service.js";
import { fileIdsForPages, pageIdsForSession, pruneOrphanFiles } from "../files/storage.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { PageRow, SessionRow, UserRow } from "../types.js";
import { toPublicPage, toPublicSession, toPublicUser } from "../types.js";
import { asObject, optionalBoolean, optionalString, requireString, requireUsername } from "../validate.js";

interface IdParams {
  id: string;
}
interface MemberParams {
  id: string;
  userId: string;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  // ---- 사용자 ----------------------------------------------------------
  app.get("/api/admin/users", async () => {
    const rows = app.db
      .prepare<[], UserRow>("SELECT * FROM users ORDER BY created_at ASC")
      .all();
    return { users: rows.map(toPublicUser) };
  });

  app.post("/api/admin/users", async (req, reply) => {
    const body = asObject(req.body);
    const username = requireUsername(body);
    const password = requireString(body, "password", "비밀번호", { max: 200 });
    const roleRaw = optionalString(body, "role", "역할", { max: 10 });
    if (roleRaw && roleRaw !== "admin" && roleRaw !== "user") {
      throw badRequest("역할은 admin 또는 user 여야 합니다.");
    }
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) throw badRequest(policy.message!);
    if (findUserByUsername(app.db, username)) {
      throw conflict("이미 사용 중인 아이디입니다.", "username_taken");
    }

    const user = await createUser(app.db, {
      username,
      password,
      role: (roleRaw as "admin" | "user" | undefined) ?? "user",
      mustChangePassword: false,
    });
    reply.code(201);
    return { user: toPublicUser(user) };
  });

  app.patch<{ Params: IdParams }>("/api/admin/users/:id", async (req) => {
    const target = findUserById(app.db, req.params.id);
    if (!target) throw notFound("사용자를 찾을 수 없습니다.");

    const body = asObject(req.body);
    const roleRaw = optionalString(body, "role", "역할", { max: 10 });
    const aiAllowed = optionalBoolean(body, "ai_allowed", "AI 허용");
    const password = optionalString(body, "password", "비밀번호", { max: 200 });

    if (roleRaw && roleRaw !== "admin" && roleRaw !== "user") {
      throw badRequest("역할은 admin 또는 user 여야 합니다.");
    }
    if (roleRaw === "user" && target.role === "admin" && countAdmins(app) <= 1) {
      throw badRequest("마지막 관리자의 역할은 변경할 수 없습니다.");
    }

    const at = nowIso();
    if (roleRaw) {
      app.db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(roleRaw, at, target.id);
    }
    if (aiAllowed !== undefined) {
      app.db
        .prepare("UPDATE users SET ai_allowed = ?, updated_at = ? WHERE id = ?")
        .run(aiAllowed ? 1 : 0, at, target.id);
    }
    if (password !== undefined) {
      const policy = checkPasswordPolicy(password);
      if (!policy.ok) throw badRequest(policy.message!);
      const hash = await hashPassword(password);
      app.db
        .prepare(
          "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?",
        )
        .run(hash, at, target.id);
      // 비밀번호 재설정 시 기존 로그인 세션과 열린 협업·댓글 소켓을 모두 끊는다.
      deleteAuthSessionsForUser(app.db, target.id);
      app.collabSockets.closeForUser(target.id);
      app.commentSockets.closeForUser(target.id);
    }

    return { user: toPublicUser(findUserById(app.db, target.id)!) };
  });

  app.delete<{ Params: IdParams }>("/api/admin/users/:id", async (req) => {
    const target = findUserById(app.db, req.params.id);
    if (!target) throw notFound("사용자를 찾을 수 없습니다.");
    if (target.id === req.user!.id) throw badRequest("자기 자신은 삭제할 수 없습니다.");
    if (target.role === "admin" && countAdmins(app) <= 1) {
      throw badRequest("마지막 관리자는 삭제할 수 없습니다.");
    }
    app.db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    // 삭제된 사용자의 열린 협업·댓글 소켓도 끊는다 (핸드셰이크 이후에는 재검증되지 않는다).
    app.collabSockets.closeForUser(target.id);
    app.commentSockets.closeForUser(target.id);
    return { ok: true };
  });

  // ---- 세션 ------------------------------------------------------------
  app.get("/api/admin/sessions", async () => {
    const sessions = app.db
      .prepare<[], SessionRow>("SELECT * FROM sessions ORDER BY created_at ASC")
      .all();
    const members = app.db
      .prepare<[], { session_id: string; user_id: string }>(
        "SELECT session_id, user_id FROM session_members",
      )
      .all();
    const pages = app.db
      .prepare<[], PageRow>("SELECT * FROM pages ORDER BY position ASC, created_at ASC")
      .all();

    return {
      sessions: sessions.map((s) => ({
        ...toPublicSession(s),
        memberIds: members.filter((m) => m.session_id === s.id).map((m) => m.user_id),
        pages: pages.filter((p) => p.session_id === s.id).map(toPublicPage),
      })),
    };
  });

  app.post("/api/admin/sessions", async (req, reply) => {
    const body = asObject(req.body);
    const name = requireString(body, "name", "세션 이름", { max: 100 });
    const id = newId();
    const at = nowIso();
    app.db
      .prepare(
        "INSERT INTO sessions (id, name, locked, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)",
      )
      .run(id, name, req.user!.id, at, at);
    reply.code(201);
    const row = app.db.prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?").get(id)!;
    return { session: { ...toPublicSession(row), memberIds: [], pages: [] } };
  });

  app.patch<{ Params: IdParams }>("/api/admin/sessions/:id", async (req) => {
    const session = app.db
      .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?")
      .get(req.params.id);
    if (!session) throw notFound("세션을 찾을 수 없습니다.");

    const body = asObject(req.body);
    const name = optionalString(body, "name", "세션 이름", { max: 100 });
    const locked = optionalBoolean(body, "locked", "잠금");
    const at = nowIso();

    if (name !== undefined) {
      app.db.prepare("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?").run(name, at, session.id);
    }
    if (locked !== undefined) {
      app.db
        .prepare("UPDATE sessions SET locked = ?, updated_at = ? WHERE id = ?")
        .run(locked ? 1 : 0, at, session.id);
      // 잠긴 세션은 릴레이를 쓰지 않는다 — 이 세션에 접근 가능한 사용자의 열린
      // 협업 소켓을 끊는다. 재접속하면 `/room` 이 `{locked:true}` 로 막는다.
      if (locked) app.collabSockets.closeForUsers(userIdsWithSessionAccess(app.db, session.id));
    }
    const row = app.db
      .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?")
      .get(session.id)!;
    return { session: toPublicSession(row) };
  });

  app.delete<{ Params: IdParams }>("/api/admin/sessions/:id", async (req) => {
    // 세션이 지워지면 페이지와 page_files 링크가 cascade 로 사라진다.
    // 링크가 하나도 남지 않은 파일은 디스크에서도 지운다.
    const candidates = fileIdsForPages(app.db, pageIdsForSession(app.db, req.params.id));
    const result = app.db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw notFound("세션을 찾을 수 없습니다.");
    await pruneOrphanFiles(app.db, app.config.dataDir, candidates);
    return { ok: true };
  });

  // ---- 세션 멤버 -------------------------------------------------------
  app.put<{ Params: MemberParams }>("/api/admin/sessions/:id/members/:userId", async (req) => {
    const session = app.db
      .prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?")
      .get(req.params.id);
    if (!session) throw notFound("세션을 찾을 수 없습니다.");
    const user = findUserById(app.db, req.params.userId);
    if (!user) throw notFound("사용자를 찾을 수 없습니다.");

    app.db
      .prepare(
        "INSERT OR IGNORE INTO session_members (session_id, user_id, added_at) VALUES (?, ?, ?)",
      )
      .run(session.id, user.id, nowIso());
    return { ok: true };
  });

  app.delete<{ Params: MemberParams }>("/api/admin/sessions/:id/members/:userId", async (req) => {
    app.db
      .prepare("DELETE FROM session_members WHERE session_id = ? AND user_id = ?")
      .run(req.params.id, req.params.userId);
    // 할당이 풀린 사용자가 이미 열어 둔 협업·댓글 소켓도 끊는다 (즉시 차단 요구사항).
    app.collabSockets.closeForUser(req.params.userId);
    app.commentSockets.closeForUser(req.params.userId);
    return { ok: true };
  });
}

function countAdmins(app: FastifyInstance): number {
  return app.db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
    .get()!.c;
}

