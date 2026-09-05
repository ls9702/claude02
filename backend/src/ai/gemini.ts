/**
 * Gemini `generateContent` 업스트림 호출 (claude01 `server/ai.php` 의 curl 부분 이식).
 *
 * SDK 를 쓰지 않고 `fetch` 하나로 끝낸다 — 이 프록시가 하는 일은 "키를 붙여 그대로 전달" 이고,
 * 응답도 **파싱하지 않고 그대로** 클라이언트에 넘긴다(파싱은 프론트 한 곳, `ai/aiClient.ts`).
 *
 * 주소는 `GEMINI_BASE_URL` 로 바꿀 수 있다 — E2E 는 여기에 모킹 서버를 물린다.
 */
import { AI_UPSTREAM_TIMEOUT_MS } from "../config.js";

export interface UpstreamResponse {
  /** HTTP 상태. `0` 이면 응답 자체를 받지 못했다(DNS·TLS·타임아웃). */
  status: number;
  /** 원문 본문 (200 이면 그대로 클라이언트에 흘려보낸다) */
  body: string;
}

export interface GeminiTarget {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * `<base>/v1beta/models/<model>:generateContent`
 * API 키는 URL 이 아니라 `x-goog-api-key` 헤더로 보낸다 — 쿼리스트링은 프록시·APM 로그에 남기 쉽다.
 */
export function geminiUrl(target: Pick<GeminiTarget, "baseUrl" | "model">): string {
  const base = target.baseUrl.replace(/\/+$/, "");
  return `${base}/v1beta/models/${encodeURIComponent(target.model)}:generateContent`;
}

/** 한 번의 `generateContent` 왕복. 던지지 않는다 — 실패도 `{status:0}` 으로 돌려준다. */
export async function callGemini(
  target: GeminiTarget,
  payload: unknown,
  timeoutMs: number = AI_UPSTREAM_TIMEOUT_MS,
): Promise<UpstreamResponse> {
  try {
    const response = await fetch(geminiUrl(target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-goog-api-key": target.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : "연결 실패" };
  }
}
