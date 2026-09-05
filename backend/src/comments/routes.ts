/**
 * 오브젝트 댓글 REST API (PLAN §2.5).
 *
 * 권한 규칙
 * - 읽기: 세션 멤버(+관리자) — `requirePageAccess`
 * - 작성(댓글·답글): 멤버, **잠긴 세션에서는 관리자만** (`assertWritable` → 403 `session_locked`)
 * - 본문 수정·삭제: 작성자 또는 관리자 (잠긴 세션에서는 관리자만)
 * - 해결/해결 취소: 멤버 누구나, **잠긴 세션에서도 허용** (읽기 전용 보드의 정리 작업)
 * - 좌표(x·y) 갱신: 멤버 누구나 — 앵커 요소가 삭제되어 고아로 바뀔 때
 *   클라이언트가 "마지막 알려진 위치" 를 한 번 저장한다 (잠긴 세션에서는 하지 않는다)
 *
 * 변경은 모두 `/ws/comments/:pageId` 구독자에게 브로드캐스트한다(발신자 포함).
 */
import type { FastifyInstance } from "fastify";
import { assertWritable, requirePageAccess } from "../access.js";
import { requireAuth } from "../auth/plugin.js";
import { MAX_COMMENT_BODY } from "../config.js";
import type { Db } from "../db/index.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { CommentReplyRow, CommentRow, PageRow, SessionRow, UserRow } from "../types.js";
import { asObject, optionalBoolean, optionalNumber, optionalString, requireNumber, requireString } from "../validate.js";
import { getComment, getReply, listComments } from "./service.js";

interface IdParams {
  id: string;
}

interface CommentTarget {
  comment: CommentRow;
  page: PageRow;
  session: SessionRow;
}

const isTruthyFlag = (value: unknown): boolean =>
  value === "1" || value === "true" || value === true;

/** 댓글 + 소속 페이지·세션 권한 검사 */
function requireCommentAccess(db: Db, user: UserRow, commentId: string): CommentTarget {
  const comment = db
    .prepare<[string], CommentRow>("SELECT * FROM comments WHERE id = ?")
    .get(commentId);
  if (!comment) throw notFound("댓글을 찾을 수 없습니다.");
  const { page, session } = requirePageAccess(db, user, comment.page_id);
  return { comment, page, session };
}

/** 작성자 본인 또는 관리자만 */
function assertAuthorOrAdmin(user: UserRow, authorId: string | null): void {
  if (user.role === "admin") return;
  if (authorId && authorId === user.id) return;
  throw forbidden("작성자만 수정하거나 삭제할 수 있습니다.");
}

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  const broadcast = app.commentSockets;

  // ---- 목록 -------------------------------------------------------------
  app.get<{ Params: IdParams; Querystring: { includeResolved?: string } }>(
    "/api/pages/:id/comments",
    async (req) => {
      const { page } = requirePageAccess(app.db, req.user!, req.params.id);
      const includeResolved = isTruthyFlag(req.query.includeResolved);
      return { comments: listComments(app.db, page.id, { includeResolved }) };
    },
  );

  // ---- 댓글 작성 --------------------------------------------------------
  app.post<{ Params: IdParams }>("/api/pages/:id/comments", async (req, reply) => {
    const { page, session } = requirePageAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);

    const body = asObject(req.body);
    const text = requireString(body, "body", "댓글 내용", { max: MAX_COMMENT_BODY });
    const elementId = optionalString(body, "elementId", "요소 id", { max: 200 }) ?? null;
    const x = requireNumber(body, "x", "x 좌표");
    const y = requireNumber(body, "y", "y 좌표");

    const id = newId();
    const at = nowIso();
    app.db
      .prepare(
        `INSERT INTO comments (id, page_id, element_id, x, y, author_id, body, resolved, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, page.id, elementId, x, y, req.user!.id, text, at, at);

    const comment = getComment(app.db, id)!;
    broadcast.broadcast(page.id, { type: "comment.created", payload: comment });
    reply.code(201);
    return { comment };
  });

  // ---- 댓글 수정 (본문·해결·좌표) ---------------------------------------
  app.patch<{ Params: IdParams }>("/api/comments/:id", async (req) => {
    const { comment, session } = requireCommentAccess(app.db, req.user!, req.params.id);
    const body = asObject(req.body);

    const text = optionalString(body, "body", "댓글 내용", { max: MAX_COMMENT_BODY });
    const resolved = optionalBoolean(body, "resolved", "해결");
    const x = optionalNumber(body, "x", "x 좌표");
    const y = optionalNumber(body, "y", "y 좌표");
    if (text === undefined && resolved === undefined && x === undefined && y === undefined) {
      throw badRequest("변경할 내용이 없습니다.");
    }
    if ((x === undefined) !== (y === undefined)) {
      throw badRequest("좌표는 x·y 를 함께 보내야 합니다.");
    }

    // 해결 처리만 하는 요청은 잠긴 세션에서도 허용한다.
    if (text !== undefined || x !== undefined) assertWritable(session, req.user!);
    // 본문은 작성자·관리자만. 해결과 좌표(고아 전환)는 멤버 누구나.
    if (text !== undefined) assertAuthorOrAdmin(req.user!, comment.author_id);

    const at = nowIso();
    if (text !== undefined) {
      app.db.prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").run(text, at, comment.id);
    }
    if (resolved !== undefined) {
      app.db
        .prepare("UPDATE comments SET resolved = ?, updated_at = ? WHERE id = ?")
        .run(resolved ? 1 : 0, at, comment.id);
    }
    if (x !== undefined && y !== undefined) {
      app.db
        .prepare("UPDATE comments SET x = ?, y = ?, updated_at = ? WHERE id = ?")
        .run(x, y, at, comment.id);
    }

    const updated = getComment(app.db, comment.id)!;
    broadcast.broadcast(comment.page_id, { type: "comment.updated", payload: updated });
    return { comment: updated };
  });

  // ---- 댓글 삭제 --------------------------------------------------------
  app.delete<{ Params: IdParams }>("/api/comments/:id", async (req) => {
    const { comment, session } = requireCommentAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);
    assertAuthorOrAdmin(req.user!, comment.author_id);

    // 답글은 FK ON DELETE CASCADE 로 함께 사라진다.
    app.db.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);
    broadcast.broadcast(comment.page_id, {
      type: "comment.deleted",
      payload: { id: comment.id, pageId: comment.page_id },
    });
    return { ok: true };
  });

  // ---- 답글 작성 --------------------------------------------------------
  app.post<{ Params: IdParams }>("/api/comments/:id/replies", async (req, reply) => {
    const { comment, session } = requireCommentAccess(app.db, req.user!, req.params.id);
    assertWritable(session, req.user!);

    const body = asObject(req.body);
    const text = requireString(body, "body", "답글 내용", { max: MAX_COMMENT_BODY });

    const id = newId();
    const at = nowIso();
    app.db
      .prepare(
        "INSERT INTO comment_replies (id, comment_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, comment.id, req.user!.id, text, at);
    // 스레드가 갱신되었음을 목록 정렬에도 반영한다.
    app.db.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(at, comment.id);

    const created = getReply(app.db, id)!;
    broadcast.broadcast(comment.page_id, { type: "reply.created", payload: created });
    reply.code(201);
    return { reply: created };
  });

  // ---- 답글 삭제 --------------------------------------------------------
  app.delete<{ Params: IdParams }>("/api/replies/:id", async (req) => {
    const row = app.db
      .prepare<[string], CommentReplyRow>("SELECT * FROM comment_replies WHERE id = ?")
      .get(req.params.id);
    if (!row) throw notFound("답글을 찾을 수 없습니다.");
    const { comment, session } = requireCommentAccess(app.db, req.user!, row.comment_id);
    assertWritable(session, req.user!);
    assertAuthorOrAdmin(req.user!, row.author_id);

    app.db.prepare("DELETE FROM comment_replies WHERE id = ?").run(row.id);
    broadcast.broadcast(comment.page_id, {
      type: "reply.deleted",
      payload: { id: row.id, commentId: comment.id },
    });
    return { ok: true };
  });
}
