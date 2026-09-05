/**
 * AI 검색 카드 프록시 (PLAN §2.6, claude01 `server/ai.php` 이식).
 *
 * 브라우저는 Gemini 를 직접 부르지 않는다 — **API 키는 서버에만** 있고, 브라우저는 로그인 쿠키로
 * 이 라우트를 부른다. 여기서 페이지 접근 권한(`requirePageAccess`)과 사용자별 허용
 * (`users.ai_allowed`)을 확인한 뒤 키를 붙여 업스트림에 넘기고, **응답은 그대로 전달**한다.
 *
 *   GET  /api/ai/ping  → `{ai: boolean}`  (로그인 필수. 키 유무 + 그 사용자의 허용 여부)
 *   POST /api/ai/ask   → 업스트림 `generateContent` 응답 그대로 (200)
 *   GET  /api/admin/ai/stats → 관리자용 일별 호출 수
 *
 * 안전 장치 (claude01 그대로)
 * - 본문 64KB 초과 413, 질문 500자·컨텍스트 2000자 초과 400
 * - 분당 퓨즈 `AI_RATE_LIMIT_PER_MIN`회(사용자 무관 전체) → 429 `{error:{code:'rate'}}`
 * - 업스트림 타임아웃 30초, 오류 본문은 400자로 잘라 전달, 401/403 은 `auth` 로 구분
 * - 질문·답변은 **저장하지 않는다** (일별 호출 수만 센다)
 */
import type { FastifyInstance } from "fastify";
import { requirePageAccess } from "../access.js";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import {
  AI_DETAIL_CHARS,
  MAX_AI_BODY_BYTES,
  MAX_AI_CONTEXT,
  MAX_AI_PROMPT,
} from "../config.js";
import { forbidden } from "../errors.js";
import { asObject, optionalBoolean, optionalString, requireString } from "../validate.js";
import { callGemini } from "./gemini.js";
import { buildGeminiPayload } from "./prompts.js";
import { RateFuse } from "./rate.js";

/** 업스트림 오류 본문을 한 줄로 접고 400자로 자른다 (키가 섞여 나갈 여지를 줄인다). */
export function trimDetail(raw: string, max: number = AI_DETAIL_CHARS): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

/** 하루 호출 수 집계 (질문 내용은 남기지 않는다). */
function countCall(app: FastifyInstance, day: string): void {
  try {
    app.db
      .prepare(
        `INSERT INTO ai_calls_daily (day, count) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1`,
      )
      .run(day);
  } catch {
    // 집계는 부가 기능이다 — 실패해도 호출을 막지 않는다 (fail-open).
  }
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const fuse = new RateFuse(app.config.aiRateLimitPerMin);

  // ---- 능력 확인 --------------------------------------------------------
  app.get("/api/ai/ping", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    // "여기에는 AI 가 없다" 도 오류가 아니라 답이다 — 항상 200.
    return { ai: app.config.geminiApiKey !== null && user.ai_allowed === 1 };
  });

  // ---- 질문 -------------------------------------------------------------
  app.post(
    "/api/ai/ask",
    { preHandler: requireAuth, bodyLimit: MAX_AI_BODY_BYTES },
    async (req, reply) => {
      const user = req.user!;
      const body = asObject(req.body);
      const pageId = requireString(body, "pageId", "페이지 id", { max: 200 });
      const prompt = requireString(body, "prompt", "질문", { max: MAX_AI_PROMPT });
      const context = optionalString(body, "context", "선택한 텍스트", { max: MAX_AI_CONTEXT });
      const grounding = optionalBoolean(body, "grounding", "검색 기반") ?? false;

      // 이 페이지를 볼 수 있는 사람만 (잠긴 세션에서도 질문은 읽기에 가깝다 — 카드는 씬 저장에서 막힌다).
      requirePageAccess(app.db, user, pageId);
      if (user.ai_allowed !== 1) {
        throw forbidden("이 계정은 AI 기능을 쓸 수 없습니다.", "ai_forbidden");
      }

      const apiKey = app.config.geminiApiKey;
      if (!apiKey) {
        return reply.code(503).send({
          error: { code: "ai_disabled", message: "이 서버에는 AI 기능이 설정되어 있지 않습니다." },
        });
      }

      if (!fuse.allow()) {
        return reply.code(429).send({
          error: { code: "rate", message: "AI 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
        });
      }

      countCall(app, new Date().toISOString().slice(0, 10));

      const upstream = await callGemini(
        { baseUrl: app.config.geminiBaseUrl, model: app.config.geminiModel, apiKey },
        buildGeminiPayload({ prompt, context, grounding }),
      );

      if (upstream.status === 200) {
        // 그대로 전달한다 — candidates·groundingMetadata 의 모양을 두 곳에서 좇지 않는다.
        return reply
          .code(200)
          .header("content-type", "application/json; charset=utf-8")
          .header("cache-control", "no-store")
          .send(upstream.body);
      }

      const detail = trimDetail(upstream.body);
      if (upstream.status === 401 || upstream.status === 403) {
        return reply.code(502).send({
          error: {
            code: "auth",
            message: "AI 서버 인증에 실패했습니다. 관리자에게 문의해 주세요.",
            detail,
          },
        });
      }
      return reply.code(502).send({
        error: {
          code: "server",
          message: "AI 서버가 오류를 돌려줬습니다.",
          detail: upstream.status === 0 ? `연결 실패 — ${detail}` : `HTTP ${upstream.status} — ${detail}`,
        },
      });
    },
  );

  // ---- 관리자: 상태·일별 호출 수 ---------------------------------------
  app.get("/api/admin/ai/stats", { preHandler: requireAdmin }, async () => {
    const daily = app.db
      .prepare<[], { day: string; count: number }>(
        "SELECT day, count FROM ai_calls_daily ORDER BY day DESC LIMIT 30",
      )
      .all();
    return {
      configured: app.config.geminiApiKey !== null,
      model: app.config.geminiModel,
      rateLimitPerMin: app.config.aiRateLimitPerMin,
      daily,
    };
  });
}
