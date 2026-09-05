/**
 * 댓글 조회·직렬화.
 *
 * 응답 형태는 작업지시서(PLAN §2.5)를 따라 **camelCase** 다
 * (`elementId`, `createdAt` …). 다른 API 는 DB 컬럼 이름을 그대로 쓰지만,
 * 댓글은 오버레이가 그대로 소비하는 뷰 모델이라 지시서 형태를 우선한다.
 */
import type { Db } from "../db/index.js";
import type { CommentReplyRow, CommentRow, PublicComment, PublicCommentReply } from "../types.js";

interface CommentJoinRow extends CommentRow {
  author_username: string | null;
}

interface ReplyJoinRow extends CommentReplyRow {
  author_username: string | null;
}

const toAuthor = (id: string | null, username: string | null) =>
  id && username ? { id, username } : null;

const toReply = (row: ReplyJoinRow): PublicCommentReply => ({
  id: row.id,
  commentId: row.comment_id,
  author: toAuthor(row.author_id, row.author_username),
  body: row.body,
  createdAt: row.created_at,
});

const toComment = (row: CommentJoinRow, replies: PublicCommentReply[]): PublicComment => ({
  id: row.id,
  pageId: row.page_id,
  elementId: row.element_id,
  x: row.x,
  y: row.y,
  author: toAuthor(row.author_id, row.author_username),
  body: row.body,
  resolved: row.resolved === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  replies,
});

/** 페이지의 댓글 목록 (기본은 미해결만). 답글은 한 번의 질의로 모아 붙인다. */
export function listComments(
  db: Db,
  pageId: string,
  opts: { includeResolved?: boolean } = {},
): PublicComment[] {
  const rows = db
    .prepare<[string], CommentJoinRow>(
      `SELECT c.*, u.username AS author_username
         FROM comments c
         LEFT JOIN users u ON u.id = c.author_id
        WHERE c.page_id = ?${opts.includeResolved ? "" : " AND c.resolved = 0"}
        ORDER BY c.created_at ASC, c.id ASC`,
    )
    .all(pageId);
  if (rows.length === 0) return [];

  const replyRows = db
    .prepare<[string], ReplyJoinRow>(
      `SELECT r.*, u.username AS author_username
         FROM comment_replies r
         JOIN comments c ON c.id = r.comment_id
         LEFT JOIN users u ON u.id = r.author_id
        WHERE c.page_id = ?
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(pageId);

  const byComment = new Map<string, PublicCommentReply[]>();
  for (const row of replyRows) {
    const list = byComment.get(row.comment_id);
    if (list) list.push(toReply(row));
    else byComment.set(row.comment_id, [toReply(row)]);
  }

  return rows.map((row) => toComment(row, byComment.get(row.id) ?? []));
}

/** 댓글 하나 (브로드캐스트 payload 용). 없으면 null. */
export function getComment(db: Db, commentId: string): PublicComment | null {
  const row = db
    .prepare<[string], CommentJoinRow>(
      `SELECT c.*, u.username AS author_username
         FROM comments c
         LEFT JOIN users u ON u.id = c.author_id
        WHERE c.id = ?`,
    )
    .get(commentId);
  if (!row) return null;

  const replyRows = db
    .prepare<[string], ReplyJoinRow>(
      `SELECT r.*, u.username AS author_username
         FROM comment_replies r
         LEFT JOIN users u ON u.id = r.author_id
        WHERE r.comment_id = ?
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(commentId);

  return toComment(row, replyRows.map(toReply));
}

/** 답글 하나 (브로드캐스트 payload 용). */
export function getReply(db: Db, replyId: string): PublicCommentReply | null {
  const row = db
    .prepare<[string], ReplyJoinRow>(
      `SELECT r.*, u.username AS author_username
         FROM comment_replies r
         LEFT JOIN users u ON u.id = r.author_id
        WHERE r.id = ?`,
    )
    .get(replyId);
  return row ? toReply(row) : null;
}

/** 세션별 미해결 댓글 수 (세션 목록 배지). */
export function unresolvedCountsBySession(db: Db): Map<string, number> {
  const rows = db
    .prepare<[], { session_id: string; c: number }>(
      `SELECT p.session_id AS session_id, COUNT(*) AS c
         FROM comments cm
         JOIN pages p ON p.id = cm.page_id
        WHERE cm.resolved = 0
        GROUP BY p.session_id`,
    )
    .all();
  return new Map(rows.map((r) => [r.session_id, r.c]));
}
