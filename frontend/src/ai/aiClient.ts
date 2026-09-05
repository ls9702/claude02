/**
 * `/api/ai/*` 클라이언트 (claude01 `src/ai/aiClient.ts` 이식).
 *
 * 이 앱에서 브라우저가 Gemini 를 부르는 길은 여기 하나뿐이고, 그 길은 항상 우리 서버를 거친다 —
 * **API 키는 서버에만** 있다(브라우저에는 토글만 있다). 인증은 로그인 세션 쿠키다.
 *
 * claude01 에서 그대로 가져온 규칙
 * - 실패는 **타입드 에러 6종**(`unavailable|network|auth|rate|server|parse`)과 고정 한국어 메시지.
 *   AI 실패는 사고가 아니라 어깨를 으쓱할 일이라, 전역 상태를 건드리지도 재시도를 걸지도 않는다.
 * - 응답 파싱(`extractText`/`extractCitations`)은 **여기 한 곳**에서만 한다. 서버는 업스트림
 *   JSON 을 그대로 넘기므로 Gemini 응답 모양을 좇는 코드가 두 곳에 생기지 않는다.
 * - 타임아웃 35초(서버는 30초) — 서버가 먼저 포기하고 502 를 돌려줄 여유를 둔다.
 */

/** 한 번의 AI 요청에 허용하는 시간 (서버 30초 + 여유) */
export const AI_TIMEOUT_MS = 35_000;
/** 능력 확인 ping 의 시간 제한 */
export const PING_TIMEOUT_MS = 8_000;

export type AiErrorKind =
  /** 토글이 꺼져 있거나 서버에 키가 없다 */
  | "unavailable"
  /** 전송 실패: 오프라인·DNS·타임아웃 */
  | "network"
  /** 인증 문제 (로그인 만료, 업스트림 키 거부) */
  | "auth"
  /** 분당 퓨즈 */
  | "rate"
  /** 그 밖의 비-2xx (업스트림 오류 502 포함) */
  | "server"
  /** 2xx 인데 답을 읽어낼 수 없었다 */
  | "parse";

/** 사용자에게 보여 주는 고정 문구 */
export const AI_MESSAGES: Record<AiErrorKind, string> = {
  unavailable: "AI 기능을 쓸 수 없습니다.",
  network: "AI 서버에 연결할 수 없습니다.",
  auth: "AI 요청 인증에 실패했습니다.",
  rate: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  server: "AI 서버가 오류를 돌려줬습니다.",
  parse: "AI 응답을 이해하지 못했습니다.",
};

export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** HTTP 상태. 응답을 받지 못했으면 `0`. */
  readonly status: number;

  constructor(kind: AiErrorKind, message: string = AI_MESSAGES[kind], status = 0) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = status;
  }
}

/** 그라운딩이 켜졌을 때 Gemini 가 참고했다고 밝힌 출처 하나 */
export interface AiCitation {
  title: string;
  url: string;
}

export interface AiResult {
  /** 첫 후보의 모든 text 파트를 이은 글 */
  text: string;
  /** 출처 (그라운딩이 아니면 `[]`) */
  citations: AiCitation[];
}

export interface AskOptions {
  pageId: string;
  prompt: string;
  grounding: boolean;
  context?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout?.(ms);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 응답 읽기
 * ------------------------------------------------------------------ */

/**
 * 첫 후보의 모든 `text` 파트를 이어 붙인다.
 * (그라운딩 답변은 파트가 여러 개로 오는 일이 흔해서 `parts[0]` 만 보면 잘린다.)
 */
export function extractText(body: unknown): string {
  if (!isRecord(body)) return "";
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const content = isRecord(candidates[0]) ? candidates[0].content : null;
  const parts = isRecord(content) ? content.parts : null;
  if (!Array.isArray(parts)) return "";

  return parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text !== "")
    .join("")
    .trim();
}

/** `groundingMetadata.groundingChunks[].web` → `{title, url}` (url 로 중복 제거, 최대 5개) */
export function extractCitations(body: unknown, max = 5): AiCitation[] {
  if (!isRecord(body)) return [];
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const meta = isRecord(candidates[0]) ? candidates[0].groundingMetadata : null;
  const chunks = isRecord(meta) ? meta.groundingChunks : null;
  if (!Array.isArray(chunks)) return [];

  const seen = new Set<string>();
  const citations: AiCitation[] = [];
  for (const chunk of chunks) {
    if (citations.length >= max) break;
    const web = isRecord(chunk) ? chunk.web : null;
    if (!isRecord(web)) continue;
    const url = typeof web.uri === "string" ? web.uri : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, title: typeof web.title === "string" && web.title ? web.title : url });
  }
  return citations;
}

/* ------------------------------------------------------------------ *
 * 호출
 * ------------------------------------------------------------------ */

/**
 * 이 서버에 Gemini 키가 있고 내 계정이 AI 를 쓸 수 있는지 한 번 묻는다.
 *
 * **절대 던지지 않는다** — 실패는 전부 "여기에는 AI 가 없다" 와 같은 답이라,
 * 앱 시작 때 부담 없이 부를 수 있다.
 */
export async function pingAi(): Promise<boolean> {
  try {
    const response = await fetch("/api/ai/ping", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: timeoutSignal(PING_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isRecord(body) && body.ai === true;
  } catch {
    return false;
  }
}

/** 서버 오류 본문에서 코드·메시지·detail 을 꺼낸다 (읽을 수 없으면 빈 값). */
async function readError(response: Response): Promise<{ code: string; message: string; detail: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown; detail?: unknown } };
    const error = body?.error;
    return {
      code: typeof error?.code === "string" ? error.code : "",
      message: typeof error?.message === "string" ? error.message : "",
      detail: typeof error?.detail === "string" ? error.detail.slice(0, 200) : "",
    };
  } catch {
    return { code: "", message: "", detail: "" };
  }
}

/** 서버 코드 → 에러 종류 (없으면 상태 코드로 정한다) */
function kindOf(status: number, code: string): AiErrorKind {
  if (code === "rate" || status === 429) return "rate";
  if (code === "auth" || status === 401 || status === 403) return "auth";
  if (code === "ai_disabled" || code === "ai_forbidden" || status === 503) return "unavailable";
  return "server";
}

/**
 * 질문 한 번. 성공하면 답변 글과 출처를 돌려준다.
 *
 * 답변은 **어디에도 저장하지 않는다** — 시트를 닫으면 사라지고, 카드로 만든 것만 씬에 남는다.
 */
export async function askAi(options: AskOptions): Promise<AiResult> {
  let response: Response;
  try {
    response = await fetch("/api/ai/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: timeoutSignal(AI_TIMEOUT_MS),
      body: JSON.stringify({
        pageId: options.pageId,
        prompt: options.prompt,
        grounding: options.grounding,
        ...(options.context ? { context: options.context } : {}),
      }),
    });
  } catch (err) {
    const error = new AiError("network");
    error.cause = err;
    throw error;
  }

  if (!response.ok) {
    const { code, message, detail } = await readError(response);
    const kind = kindOf(response.status, code);
    // 서버가 준 한국어 메시지를 우선 쓰고, detail 은 원인을 알려 주는 만큼만 덧붙인다.
    const base = message || AI_MESSAGES[kind];
    throw new AiError(kind, detail ? `${base} (${detail})` : base, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AiError("parse", AI_MESSAGES.parse, response.status);
  }

  const text = extractText(payload);
  if (!text) throw new AiError("parse", AI_MESSAGES.parse, response.status);
  return { text, citations: extractCitations(payload) };
}
