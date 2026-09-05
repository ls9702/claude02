/**
 * 서버가 고정으로 붙이는 Gemini 지시문 (PLAN §2.6).
 *
 * **카드 규약이 여기 있는 이유**: 답변의 모양(제목 한 줄 + 불릿 몇 개)은 카드로 그릴 수 있는지를
 * 좌우하는 계약이다. 클라이언트가 보내는 값으로 두면 브라우저에서 바꿔 보낼 수 있고,
 * 프론트 파서(`frontend/src/ai/prompts.ts` 의 `parseCard`)와 짝이 어긋난다.
 * 사용자 질문과 선택 텍스트만 클라이언트가 만들고(캡도 그쪽에서 먼저 적용), 규약은 서버가 붙인다.
 *
 * 검색 그라운딩(`google_search`)과 JSON 스키마(`responseSchema`)는 함께 쓸 수 없어서
 * 형식 강제는 스키마가 아니라 **이 지시문**으로 한다. 그래서 파서는 규약을 지키지 않은
 * 답변도 카드로 만들 수 있게 관대해야 한다.
 */

/** 카드 규약 — 첫 줄 제목, 이어서 3~6개 불릿 */
export const AI_CARD_SYSTEM = [
  "당신은 화이트보드에 붙일 요약 카드를 만드는 조수입니다.",
  "답변은 반드시 한국어로 씁니다.",
  "첫 줄은 30자 이내의 제목만 씁니다. 제목에는 불릿 기호나 마침표를 넣지 않습니다.",
  "그 다음 줄부터 '- ' 로 시작하는 불릿을 3~6개 씁니다. 불릿은 각각 80자 이내입니다.",
  "확실하지 않은 내용은 쓰지 않고, 아는 범위에서 사실만 간결하게 적습니다.",
  "표·코드블록·머리말·맺음말은 쓰지 않습니다.",
].join(" ");

/** 선택 텍스트가 붙을 때 사용자 프롬프트 앞에 서버가 덧붙이는 라벨 */
export const AI_CONTEXT_LABEL = "참고 자료(캔버스에서 선택한 텍스트)";

export interface GeminiPayload {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction: { parts: Array<{ text: string }> };
  tools?: Array<Record<string, Record<string, never>>>;
}

/**
 * `generateContent` 요청 본문.
 *
 * `grounding` 이면 `google_search` 도구를 붙인다. 도구와 `responseSchema` 는 업스트림에서
 * 상호 배타라 이 프록시는 **스키마를 아예 쓰지 않는다**(카드 형식은 지시문으로 얻는다).
 */
export function buildGeminiPayload(input: {
  prompt: string;
  context?: string | null;
  grounding: boolean;
}): GeminiPayload {
  const text = input.context
    ? `${input.prompt}\n\n${AI_CONTEXT_LABEL}:\n${input.context}`
    : input.prompt;

  const payload: GeminiPayload = {
    contents: [{ role: "user", parts: [{ text }] }],
    systemInstruction: { parts: [{ text: AI_CARD_SYSTEM }] },
  };
  if (input.grounding) payload.tools = [{ google_search: {} }];
  return payload;
}
