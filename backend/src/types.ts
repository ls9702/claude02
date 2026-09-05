export type Role = "admin" | "user";
export type PageType = "canvas" | "sheet";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  ai_allowed: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

export interface AuthSessionRow {
  id: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
}

export interface SessionRow {
  id: string;
  name: string;
  locked: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: string;
  session_id: string;
  name: string;
  type: PageType;
  position: number;
  room_id: string;
  room_key: string;
  created_at: string;
  updated_at: string;
}

export interface SceneRow {
  page_id: string;
  elements: string;
  app_state: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

/** 파일은 페이지에 직접 속하지 않고 `page_files` 링크로 여러 페이지와 연결된다. */
export interface FileRow {
  id: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
  created_by: string | null;
}

/** 클라이언트에 내려주는 사용자 표현 (해시 제외) */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  ai_allowed: boolean;
  must_change_password: boolean;
  created_at: string;
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  ai_allowed: row.ai_allowed === 1,
  must_change_password: row.must_change_password === 1,
  created_at: row.created_at,
});

export interface PageFileRow {
  page_id: string;
  file_id: string;
  created_at: string;
}

export interface PublicPage {
  id: string;
  name: string;
  type: PageType;
  position: number;
  updated_at: string;
}

export const toPublicPage = (row: PageRow): PublicPage => ({
  id: row.id,
  name: row.name,
  type: row.type,
  position: row.position,
  updated_at: row.updated_at,
});

export interface PublicSession {
  id: string;
  name: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

export const toPublicSession = (row: SessionRow): PublicSession => ({
  id: row.id,
  name: row.name,
  locked: row.locked === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

// ---- 댓글 ---------------------------------------------------------------

export interface CommentRow {
  id: string;
  page_id: string;
  /** 요소 앵커. NULL 이면 좌표 앵커다. */
  element_id: string | null;
  /** 마지막으로 알려진 씬 좌표 (요소가 삭제되면 이 값으로 고정된다) */
  x: number;
  y: number;
  author_id: string | null;
  body: string;
  resolved: number;
  created_at: string;
  updated_at: string;
}

export interface CommentReplyRow {
  id: string;
  comment_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

/** 작성자 표시 (사용자가 삭제되었으면 null 이 내려간다) */
export interface CommentAuthor {
  id: string;
  username: string;
}

export interface PublicCommentReply {
  id: string;
  commentId: string;
  author: CommentAuthor | null;
  body: string;
  createdAt: string;
}

export interface PublicComment {
  id: string;
  pageId: string;
  elementId: string | null;
  x: number;
  y: number;
  author: CommentAuthor | null;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  replies: PublicCommentReply[];
}
