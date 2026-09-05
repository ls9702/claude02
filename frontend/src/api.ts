/**
 * 백엔드 API 클라이언트 — fetch 는 이 파일 한 곳에서만 쓴다.
 * 401 을 받으면 등록된 핸들러(보통 `/login` 이동)를 호출한다.
 */

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

type PasswordChangeRequiredHandler = () => void;

let onPasswordChangeRequired: PasswordChangeRequiredHandler | null = null;

/**
 * 서버가 `must_change_password` 코드로 403 을 주면(비밀번호 변경 전에는 다른 API 를 못 쓴다)
 * 호출되는 핸들러. 보통 비밀번호 변경 화면(`/password`)으로 보낸다.
 */
export function setPasswordChangeRequiredHandler(
  handler: PasswordChangeRequiredHandler | null,
): void {
  onPasswordChangeRequired = handler;
}

/** 강제 비밀번호 변경을 알리는 서버 오류 코드 */
export const MUST_CHANGE_PASSWORD_CODE = "must_change_password";

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** 401 을 받아도 전역 핸들러를 호출하지 않는다 (로그인/me 조회용) */
  silentUnauthorized?: boolean;
  /** 페이지 이탈 중에도 요청을 보낸다 */
  keepalive?: boolean;
  /** 이미 인코딩된 본문 (multipart/raw) */
  rawBody?: BodyInit;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, rawBody, silentUnauthorized, headers, ...rest } = options;

  const finalHeaders = new Headers(headers);
  let payload: BodyInit | undefined;
  if (rawBody !== undefined) {
    payload = rawBody;
  } else if (body !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...rest,
      headers: finalHeaders,
      body: payload,
    });
  } catch {
    throw new ApiError(0, "network", "서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.");
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const data: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errBody = data as ApiErrorBody | null;
    const code = errBody?.error?.code ?? String(response.status);
    const message = errBody?.error?.message ?? "요청을 처리하지 못했습니다.";
    if (response.status === 401 && !silentUnauthorized) onUnauthorized?.();
    if (response.status === 403 && code === MUST_CHANGE_PASSWORD_CODE) {
      if (onPasswordChangeRequired) onPasswordChangeRequired();
      else if (typeof window !== "undefined" && window.location.pathname !== "/password") {
        window.location.assign("/password");
      }
    }
    throw new ApiError(response.status, code, message);
  }

  return data as T;
}

// ---- 타입 ---------------------------------------------------------------

export type Role = "admin" | "user";
export type PageType = "canvas" | "sheet";

export interface User {
  id: string;
  username: string;
  role: Role;
  ai_allowed: boolean;
  must_change_password: boolean;
  created_at: string;
}

export interface Page {
  id: string;
  name: string;
  type: PageType;
  position: number;
  updated_at: string;
}

export interface Session {
  id: string;
  name: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary extends Session {
  pages: Page[];
  unresolvedComments: number;
}

export interface AdminSession extends Session {
  memberIds: string[];
  pages: Page[];
}

/**
 * `GET /api/pages/:id/room` 응답.
 * 잠긴 세션은 릴레이를 쓰지 않으므로 룸 키 대신 `{ locked: true }` 가 온다.
 */
export type RoomInfo = { locked: true } | { locked?: false; roomId: string; roomKey: string };

export interface SceneData {
  elements: unknown[];
  appState: Record<string, unknown>;
  version: number;
}

export interface SceneSaveResult extends SceneData {
  changed: boolean;
}

// ---- 댓글 ---------------------------------------------------------------

/** 작성자 표시 (사용자가 삭제되었으면 null) */
export interface CommentAuthor {
  id: string;
  username: string;
}

export interface CommentReply {
  id: string;
  commentId: string;
  author: CommentAuthor | null;
  body: string;
  createdAt: string;
}

export interface Comment {
  id: string;
  pageId: string;
  /** 요소 앵커. null 이면 좌표 앵커다. */
  elementId: string | null;
  /** 마지막으로 알려진 씬 좌표 (요소가 삭제되면 이 값으로 고정된다) */
  x: number;
  y: number;
  author: CommentAuthor | null;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  replies: CommentReply[];
}

export interface NewCommentInput {
  elementId?: string | null;
  x: number;
  y: number;
  body: string;
}

/** `GET /api/admin/ai/stats` — 관리자 화면의 AI 상태·일별 호출 수 */
export interface AiStats {
  /** 서버에 Gemini 키가 있는가 */
  configured: boolean;
  model: string;
  rateLimitPerMin: number;
  daily: Array<{ day: string; count: number }>;
}

export interface CommentPatch {
  body?: string;
  resolved?: boolean;
  x?: number;
  y?: number;
}

// ---- 엔드포인트 ---------------------------------------------------------

export const api = {
  // 인증
  login: (username: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
      silentUnauthorized: true,
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: User }>("/api/auth/me", { silentUnauthorized: true }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ user: User }>("/api/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),

  // 세션 / 페이지
  listSessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions"),
  getSession: (id: string) => request<{ session: Session; pages: Page[] }>(`/api/sessions/${id}`),
  createPage: (sessionId: string, name: string, type: PageType) =>
    request<{ page: Page }>(`/api/sessions/${sessionId}/pages`, {
      method: "POST",
      body: { name, type },
    }),
  renamePage: (pageId: string, name: string) =>
    request<{ page: Page }>(`/api/pages/${pageId}`, { method: "PATCH", body: { name } }),
  deletePage: (pageId: string) => request<{ ok: true }>(`/api/pages/${pageId}`, { method: "DELETE" }),
  reorderPages: (sessionId: string, pageIds: string[]) =>
    request<{ pages: Page[] }>(`/api/sessions/${sessionId}/pages/order`, {
      method: "PUT",
      body: { pageIds },
    }),
  getRoom: (pageId: string) => request<RoomInfo>(`/api/pages/${pageId}/room`),

  // 씬
  getScene: (pageId: string) => request<SceneData>(`/api/pages/${pageId}/scene`),
  saveScene: (
    pageId: string,
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    opts: { keepalive?: boolean } = {},
  ) =>
    request<SceneSaveResult>(`/api/pages/${pageId}/scene`, {
      method: "PUT",
      body: { elements, appState },
      keepalive: opts.keepalive,
    }),
  listSnapshots: (pageId: string) =>
    request<{ snapshots: Array<{ id: string; created_at: string }> }>(`/api/pages/${pageId}/snapshots`),
  restoreSnapshot: (pageId: string, snapshotId: string) =>
    request<SceneData>(`/api/pages/${pageId}/snapshots/${snapshotId}/restore`, { method: "POST" }),
  putThumbnail: (pageId: string, blob: Blob) =>
    request<{ ok: true }>(`/api/pages/${pageId}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      rawBody: blob,
    }),

  // 파일
  uploadFile: (pageId: string, fileId: string, mime: string, blob: Blob) => {
    const form = new FormData();
    form.append("fileId", fileId);
    form.append("mime", mime);
    form.append("file", blob, fileId);
    return request<{ id: string; deduplicated: boolean }>(`/api/pages/${pageId}/files`, {
      method: "POST",
      rawBody: form,
    });
  },
  /** 서버에 이미 저장된 fileId 만 골라 준다 (협업 중 재업로드 방지). */
  filesExist: (pageId: string, ids: readonly string[]) =>
    request<{ existing: string[] }>(`/api/pages/${pageId}/files/exists`, {
      method: "POST",
      body: { ids },
    }),

  // 댓글
  listComments: (pageId: string, opts: { includeResolved?: boolean } = {}) =>
    request<{ comments: Comment[] }>(
      `/api/pages/${pageId}/comments${opts.includeResolved ? "?includeResolved=1" : ""}`,
    ),
  createComment: (pageId: string, input: NewCommentInput) =>
    request<{ comment: Comment }>(`/api/pages/${pageId}/comments`, { method: "POST", body: input }),
  updateComment: (commentId: string, patch: CommentPatch) =>
    request<{ comment: Comment }>(`/api/comments/${commentId}`, { method: "PATCH", body: patch }),
  deleteComment: (commentId: string) =>
    request<{ ok: true }>(`/api/comments/${commentId}`, { method: "DELETE" }),
  createReply: (commentId: string, body: string) =>
    request<{ reply: CommentReply }>(`/api/comments/${commentId}/replies`, {
      method: "POST",
      body: { body },
    }),
  deleteReply: (replyId: string) =>
    request<{ ok: true }>(`/api/replies/${replyId}`, { method: "DELETE" }),

  // 관리자
  adminListUsers: () => request<{ users: User[] }>("/api/admin/users"),
  adminCreateUser: (username: string, password: string, role: Role) =>
    request<{ user: User }>("/api/admin/users", { method: "POST", body: { username, password, role } }),
  adminUpdateUser: (id: string, patch: { role?: Role; ai_allowed?: boolean; password?: string }) =>
    request<{ user: User }>(`/api/admin/users/${id}`, { method: "PATCH", body: patch }),
  adminDeleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),

  adminAiStats: () => request<AiStats>("/api/admin/ai/stats"),

  adminListSessions: () => request<{ sessions: AdminSession[] }>("/api/admin/sessions"),
  adminCreateSession: (name: string) =>
    request<{ session: AdminSession }>("/api/admin/sessions", { method: "POST", body: { name } }),
  adminUpdateSession: (id: string, patch: { name?: string; locked?: boolean }) =>
    request<{ session: Session }>(`/api/admin/sessions/${id}`, { method: "PATCH", body: patch }),
  adminDeleteSession: (id: string) =>
    request<{ ok: true }>(`/api/admin/sessions/${id}`, { method: "DELETE" }),
  adminAddMember: (sessionId: string, userId: string) =>
    request<{ ok: true }>(`/api/admin/sessions/${sessionId}/members/${userId}`, { method: "PUT" }),
  adminRemoveMember: (sessionId: string, userId: string) =>
    request<{ ok: true }>(`/api/admin/sessions/${sessionId}/members/${userId}`, { method: "DELETE" }),
};
