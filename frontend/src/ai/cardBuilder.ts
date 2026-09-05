/**
 * AI 답변 → 캔버스 카드 (PLAN §2.6).
 *
 * 카드는 **특별한 요소가 아니다**: 둥근 사각형 하나 + 텍스트 몇 개를 같은 `groupIds` 로 묶은
 * 평범한 Excalidraw 요소 묶음이다. 그래서 이동·편집·협업 동기화·저장·내보내기가 전부
 * 기존 경로로 그냥 동작한다 — AI 전용 저장 로직이 없다. 출처는 요소의 `link` 속성으로 달아
 * Excalidraw 가 그리는 링크 아이콘으로 열린다. `customData.aiCard` 는 "이건 AI 카드였다" 는 표시다.
 *
 * 이 파일은 **순수 계산만** 한다(단위 테스트 대상). `convertToExcalidrawElements` 호출과
 * 씬 반영은 `insertCard.ts` 에 있다 — Excalidraw 를 import 하지 않아야 노드에서 시험할 수 있다.
 *
 * 줄바꿈은 우리가 직접 넣는다: Excalidraw 텍스트는 컨테이너에 묶이지 않으면 자동 줄바꿈이 없고,
 * 컨테이너에 묶으면(라벨) 요소가 하나로 합쳐져 출처마다 링크를 달 수 없기 때문이다.
 */
import { MAX_BULLETS, MAX_SOURCES, truncate } from "./prompts";

/** 카드 폭 (고정) */
export const CARD_WIDTH = 360;
/** 안쪽 여백 */
export const CARD_PADDING = 16;

const TITLE_FONT_SIZE = 20;
const TITLE_LINE_HEIGHT = 25;
const BODY_FONT_SIZE = 16;
const BODY_LINE_HEIGHT = 20;
const SMALL_FONT_SIZE = 12;
const SMALL_LINE_HEIGHT = 15;
const SECTION_GAP = 10;

/** Excalidraw 폰트 번호 2 = Helvetica(일반체) — 한국어 가독성 때문에 손글씨체를 쓰지 않는다. */
const FONT_FAMILY_NORMAL = 2;

const CARD_BACKGROUND = "#fff9db";
const CARD_STROKE = "#e9b949";
const TITLE_COLOR = "#1b1f24";
const BODY_COLOR = "#343a40";
const LINK_COLOR = "#1971c2";
const MUTED_COLOR = "#868e96";

export interface AiCardMeta {
  /** 사용자가 물어본 질문 (답변 본문은 저장하지 않는다 — 카드에 그려진 것이 전부다) */
  query: string;
  /** 만든 시각 (ISO) */
  at: string;
  /** 만든 사람 (사용자 이름) */
  by: string;
}

export interface CardSource {
  title: string;
  url: string;
}

export interface BuildCardInput {
  title: string;
  bullets: string[];
  sources?: CardSource[];
  query: string;
  by: string;
  /** 기본값은 지금 시각 */
  at?: string;
  /** 카드 중심이 놓일 씬 좌표 */
  center: { x: number; y: number };
  /** 묶음 id (기본값은 새로 만든다 — 테스트에서 고정할 수 있다) */
  groupId?: string;
}

/** 우리가 만들어 `convertToExcalidrawElements` 에 넘기는 스켈레톤의 최소 형태 */
export interface CardSkeleton {
  type: "rectangle" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeWidth?: number;
  roughness?: number;
  roundness?: { type: number };
  link?: string;
  groupIds: string[];
  customData: { aiCard: AiCardMeta };
}

export interface BuiltCard {
  elements: CardSkeleton[];
  groupId: string;
  width: number;
  height: number;
  /** 카드 좌상단 (씬 좌표) */
  x: number;
  y: number;
}

/** 새 묶음 id */
function newGroupId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `ai-${crypto.randomUUID()}`;
    }
  } catch {
    /* 안 되면 아래로 */
  }
  return `ai-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** 글자 하나의 대략적인 폭 (글자 크기 대비 비율). 한글·한자·가나는 정사각형에 가깝다. */
function charUnits(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x11ff) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // 한중일 부수·가나·한자
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60);
  return wide ? 1 : 0.55;
}

/** 글자 폭의 합 (글자 크기 = 1 단위) */
export function textUnits(text: string): number {
  let total = 0;
  for (const ch of text) total += charUnits(ch);
  return total;
}

/**
 * `maxUnits` 폭에 맞춰 줄을 나눈다 (띄어쓰기 우선, 한 낱말이 넘치면 글자 단위로 자른다).
 * 반환값은 줄 배열이며, 빈 문자열이면 `[]`.
 */
export function wrapText(text: string, maxUnits: number): string[] {
  const source = text.trim();
  if (!source) return [];
  if (maxUnits <= 0) return [source];

  const lines: string[] = [];
  let line = "";
  let lineUnits = 0;

  const pushLine = () => {
    if (line) lines.push(line);
    line = "";
    lineUnits = 0;
  };

  const pushWord = (word: string) => {
    for (const ch of word) {
      const units = charUnits(ch);
      if (lineUnits + units > maxUnits && line) pushLine();
      line += ch;
      lineUnits += units;
    }
  };

  for (const word of source.split(/\s+/)) {
    const wordUnits = textUnits(word);
    if (!line) {
      if (wordUnits <= maxUnits) {
        line = word;
        lineUnits = wordUnits;
      } else {
        pushWord(word);
      }
      continue;
    }
    if (lineUnits + charUnits(" ") + wordUnits <= maxUnits) {
      line += ` ${word}`;
      lineUnits += charUnits(" ") + wordUnits;
      continue;
    }
    pushLine();
    if (wordUnits <= maxUnits) {
      line = word;
      lineUnits = wordUnits;
    } else {
      pushWord(word);
    }
  }
  pushLine();
  return lines;
}

/** 불릿 하나를 `• ` 로 시작하는 여러 줄로 (이어지는 줄은 두 칸 들여쓴다) */
function bulletLines(bullet: string, maxUnits: number): string[] {
  const wrapped = wrapText(bullet, maxUnits - 1.5);
  return wrapped.map((line, index) => (index === 0 ? `• ${line}` : `  ${line}`));
}

/** 한 줄에 들어가게 자른 출처 표시 */
function sourceLabel(index: number, source: CardSource, maxUnits: number): string {
  const label = `[${index + 1}] ${source.title || source.url}`;
  const lines = wrapText(label, maxUnits);
  return lines.length <= 1 ? label : `${lines[0]!.trimEnd()}…`;
}

/**
 * 카드 요소들을 만든다.
 *
 * 세로 배치: 제목 → 불릿 본문 → (출처들) → 만든 이·시각. 컨테이너 높이는 그 합에서 나온다.
 * 컨테이너를 **맨 앞**에 두어 텍스트가 위에 그려지게 한다.
 */
export function buildCardElements(input: BuildCardInput): BuiltCard {
  const groupIds = [input.groupId ?? newGroupId()];
  const at = input.at ?? new Date().toISOString();
  const meta: AiCardMeta = { query: truncate(input.query, 500), at, by: input.by };
  const innerWidth = CARD_WIDTH - CARD_PADDING * 2;

  const title = input.title.trim() || "AI 답변";
  const bullets = input.bullets.filter((b) => b.trim() !== "").slice(0, MAX_BULLETS);
  const sources = (input.sources ?? []).slice(0, MAX_SOURCES);

  const titleLines = wrapText(title, innerWidth / TITLE_FONT_SIZE);
  const bodyLines = bullets.flatMap((bullet) => bulletLines(bullet, innerWidth / BODY_FONT_SIZE));
  const footer = `Gemini · ${sources.length > 0 ? `검색 ${sources.length}건 · ` : ""}${input.by}`;

  const titleHeight = Math.max(1, titleLines.length) * TITLE_LINE_HEIGHT;
  const bodyHeight = bodyLines.length * BODY_LINE_HEIGHT;
  const sourcesHeight = sources.length * SMALL_LINE_HEIGHT;

  let height = CARD_PADDING * 2 + titleHeight;
  if (bodyLines.length > 0) height += SECTION_GAP + bodyHeight;
  if (sources.length > 0) height += SECTION_GAP + sourcesHeight;
  height += SECTION_GAP + SMALL_LINE_HEIGHT;

  const x = Math.round(input.center.x - CARD_WIDTH / 2);
  const y = Math.round(input.center.y - height / 2);
  const textX = x + CARD_PADDING;

  const elements: CardSkeleton[] = [
    {
      type: "rectangle",
      x,
      y,
      width: CARD_WIDTH,
      height,
      backgroundColor: CARD_BACKGROUND,
      strokeColor: CARD_STROKE,
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3 },
      groupIds,
      customData: { aiCard: meta },
    },
  ];

  let cursor = y + CARD_PADDING;
  elements.push({
    type: "text",
    x: textX,
    y: cursor,
    width: innerWidth,
    text: titleLines.join("\n") || title,
    fontSize: TITLE_FONT_SIZE,
    fontFamily: FONT_FAMILY_NORMAL,
    strokeColor: TITLE_COLOR,
    textAlign: "left",
    verticalAlign: "top",
    groupIds,
    customData: { aiCard: meta },
  });
  cursor += titleHeight;

  if (bodyLines.length > 0) {
    cursor += SECTION_GAP;
    elements.push({
      type: "text",
      x: textX,
      y: cursor,
      width: innerWidth,
      text: bodyLines.join("\n"),
      fontSize: BODY_FONT_SIZE,
      fontFamily: FONT_FAMILY_NORMAL,
      strokeColor: BODY_COLOR,
      textAlign: "left",
      verticalAlign: "top",
      groupIds,
      customData: { aiCard: meta },
    });
    cursor += bodyHeight;
  }

  if (sources.length > 0) {
    cursor += SECTION_GAP;
    sources.forEach((source, index) => {
      elements.push({
        type: "text",
        x: textX,
        y: cursor + index * SMALL_LINE_HEIGHT,
        width: innerWidth,
        text: sourceLabel(index, source, innerWidth / SMALL_FONT_SIZE),
        fontSize: SMALL_FONT_SIZE,
        fontFamily: FONT_FAMILY_NORMAL,
        strokeColor: LINK_COLOR,
        textAlign: "left",
        verticalAlign: "top",
        // 링크는 요소 속성이다 — Excalidraw 가 링크 아이콘을 그리고 클릭하면 새 탭에서 연다.
        link: source.url,
        groupIds,
        customData: { aiCard: meta },
      });
    });
    cursor += sourcesHeight;
  }

  cursor += SECTION_GAP;
  elements.push({
    type: "text",
    x: textX,
    y: cursor,
    width: innerWidth,
    text: footer,
    fontSize: SMALL_FONT_SIZE,
    fontFamily: FONT_FAMILY_NORMAL,
    strokeColor: MUTED_COLOR,
    textAlign: "left",
    verticalAlign: "top",
    groupIds,
    customData: { aiCard: meta },
  });

  return { elements, groupId: groupIds[0]!, width: CARD_WIDTH, height, x, y };
}
