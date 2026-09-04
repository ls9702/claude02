import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess, requireSessionMember } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { badRequest, notFound } from "../errors.js";
import { newId, newRoomId, newRoomKey, nowIso } from "../ids.js";
import type { PageRow, PageType, SessionRow } from "../types.js";
import { toPublicPage, toPublicSession } from "../types.js";
import { asObject, requireArray, requireString } from "../validate.js";

interface IdParams {
  id: string;
}

function listPages(app: FastifyInstance, sessionId: string): PageRow[] {
  return app.db
    .prepare<[string], PageRow>(
      "SELECT * FROM pages WHERE session_id = ? ORDER BY position ASC, created_at ASC",
    )
    .all(sessionId);
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /** 내게 할당된 세션 목록 (관리자는 전체) */
  app.get("/api/sessions", async (req) => {
    const user = req.user!;
    const rows =
      user.role === "admin"
        ? app.db.prepare<[], SessionRow>("SELECT * FROM sessions ORDER BY created_at ASC").all()
        : app.db
            .prepare<[string], SessionRow>(
              `SELECT s.* FROM sessions s
                 JOIN session_members m ON m.session_id = s.id
                WHERE m.user_id = ?
                ORDER BY s.created_at ASC`,
            )
            .all(user.id);

    return {
      sessions: rows.map((s) => ({
        ...toPublicSession(s),
        pages: listPages(app, s.id).map(toPublicPage),
        // M3에서 실제 집계로 대체한다.
        unresolvedComments: 0,
      })),
    };
  });

  app.get<{ Params: IdParams }>("/api/sessions/:id", async (req) => {
    const session = requireSessionMember(app.db, req.user!, req.params.id);
    return {
      session: toPublicSession(session),
      pages: listPages(app, session.id).map(toPublicPage),
    };
  });

  app.post<{ Params: IdParams }>("/api/sessions/:id/pages", async (req, reply) => {
    const session = requireSessionMember(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);

    const body = asObject(req.body);
    const name = requireString(body, "name", "페이지 이름", { max: 100 });
    const typeRaw = requireString(body, "type", "페이지 종류", { max: 10 });
    if (typeRaw !== "canvas" && typeRaw !== "sheet") {
      throw badRequest("페이지 종류는 canvas 또는 sheet 여야 합니다.");
    }
    const type: PageType = typeRaw;

    const maxRow = app.db
      .prepare<[string], { m: number | null }>(
        "SELECT MAX(position) AS m FROM pages WHERE session_id = ?",
      )
      .get(session.id);
    const position = (maxRow?.m ?? -1) + 1;

    const id = newId();
    const at = nowIso();
    app.db
      .prepare(
        `INSERT INTO pages (id, session_id, name, type, position, room_id, room_key, thumbnail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, session.id, name, type, position, newRoomId(), newRoomKey(), at, at);

    if (type === "canvas") {
      app.db
        .prepare(
          "INSERT INTO scenes (page_id, elements, app_state, version, updated_at, updated_by) VALUES (?, '[]', '{}', 0, ?, ?)",
        )
        .run(id, at, req.user!.id);
    } else {
      app.db
        .prepare("INSERT INTO sheets (page_id, data, version, updated_at) VALUES (?, '{}', 0, ?)")
        .run(id, at);
    }

    reply.code(201);
    const page = app.db.prepare<[string], PageRow>("SELECT * FROM pages WHERE id = ?").get(id)!;
    return { page: toPublicPage(page) };
  });

  app.put<{ Params: IdParams }>("/api/sessions/:id/pages/order", async (req) => {
    const session = requireSessionMember(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);

    const body = asObject(req.body);
    const raw = requireArray(body, "pageIds", "페이지");
    const pageIds = raw.map((v) => {
      if (typeof v !== "string") throw badRequest("페이지 목록이 올바르지 않습니다.");
      return v;
    });

    const current = listPages(app, session.id);
    const currentIds = new Set(current.map((p) => p.id));
    if (pageIds.length !== current.length || pageIds.some((id) => !currentIds.has(id))) {
      throw badRequest("페이지 목록이 현재 세션과 일치하지 않습니다.");
    }

    const at = nowIso();
    const update = app.db.prepare("UPDATE pages SET position = ?, updated_at = ? WHERE id = ?");
    app.db.transaction(() => {
      pageIds.forEach((id, index) => update.run(index, at, id));
    })();

    return { pages: listPages(app, session.id).map(toPublicPage) };
  });

  app.patch<{ Params: IdParams }>("/api/pages/:id", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);
    const body = asObject(req.body);
    const name = requireString(body, "name", "페이지 이름", { max: 100 });
    app.db
      .prepare("UPDATE pages SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, nowIso(), page.id);
    const row = app.db.prepare<[string], PageRow>("SELECT * FROM pages WHERE id = ?").get(page.id)!;
    return { page: toPublicPage(row) };
  });

  app.delete<{ Params: IdParams }>("/api/pages/:id", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);
    app.db.prepare("DELETE FROM pages WHERE id = ?").run(page.id);
    return { ok: true };
  });

  /** 협업 룸 정보 — 세션 멤버에게만 전달한다 (M2에서 사용). */
  app.get<{ Params: IdParams }>("/api/pages/:id/room", async (req) => {
    const { page } = requirePageAccess(app.db, req.user!, req.params.id);
    if (page.type !== "canvas") throw notFound("캔버스 페이지가 아닙니다.");
    return { roomId: page.room_id, roomKey: page.room_key };
  });
}
