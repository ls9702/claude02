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

export interface SceneData {
  elements: unknown[];
  appState: Record<string, unknown>;
  version: number;
}

export interface SceneSaveResult extends SceneData {
  changed: boolean;
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
  getRoom: (pageId: string) =>
    request<{ roomId: string; roomKey: string }>(`/api/pages/${pageId}/room`),

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

  // 관리자
  adminListUsers: () => request<{ users: User[] }>("/api/admin/users"),
  adminCreateUser: (username: string, password: string, role: Role) =>
    request<{ user: User }>("/api/admin/users", { method: "POST", body: { username, password, role } }),
  adminUpdateUser: (id: string, patch: { role?: Role; ai_allowed?: boolean; password?: string }) =>
    request<{ user: User }>(`/api/admin/users/${id}`, { method: "PATCH", body: patch }),
  adminDeleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),

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
