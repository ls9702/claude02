import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess, requireSessionMember } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { badRequest, notFound } from "../errors.js";
import { newId, newRoomId, newRoomKey, nowIso } from "../ids.js";
import type { PageRow, PageType, SessionRow } from "../types.js";
import { toPublicPage, toPublicSession } from "../types.js";
import { asObject, optionalString, requireArray, requireString } from "../validate.js";
import { buildSheetDoc, isSheetTemplate } from "../sheets/templates.js";
import { fileIdsForPages, pruneOrphanFiles } from "../files/storage.js";
import { unresolvedCountsBySession } from "../comments/service.js";

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

    // 미해결 댓글 배지 — 세션의 모든 페이지 합계 (한 번의 집계 질의로 모은다).
    const unresolved = unresolvedCountsBySession(app.db);

    return {
      sessions: rows.map((s) => ({
        ...toPublicSession(s),
        pages: listPages(app, s.id).map(toPublicPage),
        unresolvedComments: unresolved.get(s.id) ?? 0,
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

    // 시트 페이지는 템플릿(빈 시트 / 회비 장부)에 따라 초기 데이터를 서버에서 만든다.
    const templateRaw = optionalString(body, "template", "템플릿", { max: 20 }) ?? "blank";
    if (type === "sheet" && !isSheetTemplate(templateRaw)) {
      throw badRequest("템플릿은 blank 또는 ledger 여야 합니다.");
    }

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
      const doc = buildSheetDoc(isSheetTemplate(templateRaw) ? templateRaw : "blank");
      app.db
        .prepare("INSERT INTO sheets (page_id, data, version, updated_at) VALUES (?, ?, 0, ?)")
        .run(id, JSON.stringify(doc), at);
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
    const uniqueIds = new Set(pageIds);
    // 세션의 페이지 집합과 정확한 순열이어야 한다 (중복·누락·외부 id 모두 거부).
    if (
      pageIds.length !== current.length ||
      uniqueIds.size !== pageIds.length ||
      pageIds.some((id) => !currentIds.has(id))
    ) {
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
    // 페이지가 사라지면 page_files 링크도 cascade 로 사라진다.
    // 링크가 하나도 남지 않은 파일은 디스크에서도 지운다.
    const candidates = fileIdsForPages(app.db, [page.id]);
    app.db.prepare("DELETE FROM pages WHERE id = ?").run(page.id);
    await pruneOrphanFiles(app.db, app.config.dataDir, candidates);
    return { ok: true };
  });

  /**
   * 협업 룸 정보 — 세션 멤버에게만 전달한다 (M2에서 사용).
   *
   * 잠긴 세션은 릴레이(룸)를 아예 쓰지 않는다. 보관·읽기 전용 보드에 실시간 협업은
   * 필요 없고, 룸은 무상태 릴레이라 "읽기 전용" 을 강제할 방법이 없기 때문이다
   * (읽기 전용 멤버가 룸으로 편집을 주입하면 다른 사람의 자동저장에 편입된다).
   * 그래서 잠겨 있으면 **관리자를 포함해 모두에게** 키를 주지 않는다.
   * 관리자 편집은 `PUT /api/pages/:id/scene` 으로 그대로 저장된다.
   */
  app.get<{ Params: IdParams }>("/api/pages/:id/room", async (req) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    if (page.type !== "canvas") throw notFound("캔버스 페이지가 아닙니다.");
    if (session.locked === 1) return { locked: true };
    return { roomId: page.room_id, roomKey: page.room_key };
  });
}
