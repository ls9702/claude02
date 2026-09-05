/**
 * AI 질문 프롬프트와 카드 파서 (PLAN §2.6, claude01 `src/ai/prompts.ts` 패턴 이식).
 *
 * 컴포넌트 밖의 **순수 함수**로 두는 이유는 claude01 과 같다: 프롬프트와 파서는 AI 기능에서
 * 답이 갈리는 자리이고, 브라우저 없이 시험할 수 있어야 한다.
 *
 * 역할 나눔
 * - **형식 규약(첫 줄 제목, 3~6개 불릿)** 은 서버가 `systemInstruction` 으로 고정한다
 *   (`backend/src/ai/prompts.ts`) — 브라우저에서 바꿔 보낼 수 없어야 하기 때문이다.
 * - 여기서는 **사용자 질문과 선택 텍스트**만 다듬어 보내고(캡 적용), 돌아온 글을
 *   {@link parseCard} 로 카드 모양(제목 + 불릿)으로 읽는다.
 *
 * 검색 그라운딩과 JSON 스키마는 함께 쓸 수 없어 형식이 강제되지 않는다 —
 * 그래서 파서는 **규약을 지키지 않은 답변도 반드시 카드로 만든다**(폴백).
 */

/** 질문 길이 상한 (서버도 같은 값으로 검사한다) */
export const MAX_USER_TEXT = 500;
/** 선택 텍스트 컨텍스트 상한 (서버도 같은 값으로 검사한다) */
export const MAX_CONTEXT_TEXT = 2000;
/** 카드 제목 길이 상한 (규약은 30자, 넘겨 오면 잘라 쓴다) */
export const MAX_CARD_TITLE = 40;
/** 불릿 하나의 길이 상한 (규약은 80자) */
export const MAX_BULLET_TEXT = 120;
/** 카드에 담는 불릿 수 상한 */
export const MAX_BULLETS = 6;
/** 카드에 담는 출처 수 상한 */
export const MAX_SOURCES = 5;

/** `text` 를 `max` 자로 자르고 잘린 자리에 `…` 를 남긴다. */
export function truncate(text: string, max: number): string {
  const value = text.trim();
  if (max <= 0) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface AskInput {
  /** 서버로 보낼 질문 */
  prompt: string;
  /** 선택한 텍스트 요소에서 온 참고 자료 (없으면 undefined) */
  context?: string;
}

/**
 * 질문 + (선택한 텍스트) → 서버로 보낼 요청 조각.
 *
 * 캡을 **여기서 먼저** 적용한다: 서버도 같은 한도로 검사하지만, 사용자가 긴 글을 선택했다고
 * 400 을 돌려받는 것보다 잘라서 보내는 편이 낫다. 빈 질문은 빈 프롬프트로 돌려주고
 * 호출부가 막는다(네트워크까지 가지 않는다).
 */
export function buildAskPrompt(question: string, selectedText?: string | null): AskInput {
  const prompt = truncate(question ?? "", MAX_USER_TEXT);
  const context = truncate(selectedText ?? "", MAX_CONTEXT_TEXT);
  return context ? { prompt, context } : { prompt };
}

export interface ParsedCard {
  title: string;
  bullets: string[];
  /** 답변이 카드 규약(첫 줄 제목 + '- ' 불릿)을 지켰는지 — 폴백으로 만든 카드면 false */
  conformed: boolean;
}

/** `- `, `• `, `* `, `1. `, `1) ` 같은 불릿 표시 */
const BULLET_RE = /^\s*(?:[-*•·–—]|\d{1,2}[.)])\s+/;

const isBullet = (line: string): boolean => BULLET_RE.test(line);
const stripBullet = (line: string): string => line.replace(BULLET_RE, "").trim();

/** 제목에서 장식(마크다운 머리표·불릿·끝의 콜론)을 뗀다. */
function cleanTitle(line: string): string {
  const bare = stripBullet(line)
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/[:：]\s*$/, "")
    .trim();
  return truncate(bare, MAX_CARD_TITLE);
}

/** 문장 단위로 쪼갠다 (마침표·물음표·느낌표 + 공백, 한국어 종결형 포함). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const cleanBullets = (lines: string[]): string[] =>
  lines
    .map((line) => truncate(stripBullet(line), MAX_BULLET_TEXT))
    .filter(Boolean)
    .slice(0, MAX_BULLETS);

/**
 * 답변 글 → 카드 내용.
 *
 * 1. 규약대로면: 첫 줄이 제목, 이어지는 `- ` 줄이 불릿.
 * 2. 규약을 어기면: 첫 문장을 제목으로, 나머지를 불릿 1~6개로 나눈다.
 *    (줄이 여러 개면 줄 단위로, 한 덩어리면 문장 단위로.)
 * 3. 빈 글이면 빈 카드를 돌려준다 — 호출부가 "만들 것이 없다" 로 처리한다.
 */
export function parseCard(raw: string): ParsedCard {
  const text = (raw ?? "").trim();
  if (!text) return { title: "", bullets: [], conformed: false };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const head = lines[0]!;
  const rest = lines.slice(1);

  // 1. 규약: 제목 줄 + 불릿 줄들
  const bulletLines = rest.filter(isBullet);
  if (!isBullet(head) && bulletLines.length >= 1) {
    return { title: cleanTitle(head), bullets: cleanBullets(bulletLines), conformed: true };
  }

  // 2. 폴백
  if (lines.length > 1) {
    // 여러 줄이지만 불릿이 아니다 — 첫 줄을 제목, 나머지 줄을 불릿으로.
    const bullets = cleanBullets(rest);
    if (bullets.length > 0) {
      return { title: cleanTitle(head), bullets, conformed: false };
    }
  }

  const sentences = splitSentences(stripBullet(head) === head ? text : lines.map(stripBullet).join(" "));
  if (sentences.length > 1) {
    return {
      title: cleanTitle(sentences[0]!),
      bullets: cleanBullets(sentences.slice(1)),
      conformed: false,
    };
  }

  // 3. 문장 하나뿐 — 제목은 앞부분, 본문은 글 전체를 그대로 둔다(잘라서 잃지 않게).
  return {
    title: cleanTitle(text),
    bullets: cleanBullets([text]),
    conformed: false,
  };
}
