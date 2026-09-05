import { describe, expect, it } from "vitest";
import {
  MAX_BULLETS,
  MAX_CONTEXT_TEXT,
  MAX_USER_TEXT,
  buildAskPrompt,
  parseCard,
  truncate,
} from "./prompts";

describe("truncate", () => {
  it("한도 안이면 그대로 (앞뒤 공백만 정리)", () => {
    expect(truncate("  안녕  ", 10)).toBe("안녕");
  });

  it("넘치면 자르고 … 를 붙인다", () => {
    expect(truncate("가".repeat(10), 5)).toBe("가가가가…");
    expect(truncate("가".repeat(10), 5)).toHaveLength(5);
  });

  it("0 이하면 빈 문자열", () => {
    expect(truncate("무엇이든", 0)).toBe("");
  });
});

describe("buildAskPrompt", () => {
  it("질문만 있으면 컨텍스트가 없다", () => {
    expect(buildAskPrompt("부산 맛집?")).toEqual({ prompt: "부산 맛집?" });
  });

  it("선택 텍스트는 컨텍스트로 붙는다", () => {
    expect(buildAskPrompt("요약해 줘", "긴 회의록")).toEqual({
      prompt: "요약해 줘",
      context: "긴 회의록",
    });
  });

  it("질문 500자·컨텍스트 2000자에서 잘린다", () => {
    const built = buildAskPrompt("가".repeat(600), "나".repeat(3000));
    expect(built.prompt).toHaveLength(MAX_USER_TEXT);
    expect(built.context).toHaveLength(MAX_CONTEXT_TEXT);
  });

  it("빈 선택 텍스트는 컨텍스트를 만들지 않는다", () => {
    expect(buildAskPrompt("질문", "   ")).toEqual({ prompt: "질문" });
    expect(buildAskPrompt("질문", null)).toEqual({ prompt: "질문" });
  });
});

describe("parseCard — 규약을 지킨 답변", () => {
  it("첫 줄 제목 + '- ' 불릿을 읽는다", () => {
    const card = parseCard("부산 2박 3일\n- 광안리 야경 산책\n- 자갈치 시장 아침 식사\n- 감천문화마을");
    expect(card).toEqual({
      title: "부산 2박 3일",
      bullets: ["광안리 야경 산책", "자갈치 시장 아침 식사", "감천문화마을"],
      conformed: true,
    });
  });

  it("• 나 숫자 불릿도 받는다", () => {
    const card = parseCard("제목\n• 하나\n2. 둘\n3) 셋");
    expect(card.bullets).toEqual(["하나", "둘", "셋"]);
    expect(card.conformed).toBe(true);
  });

  it("불릿이 6개를 넘으면 6개까지만 쓴다", () => {
    const card = parseCard(["제목", ...Array.from({ length: 9 }, (_, i) => `- 항목 ${i}`)].join("\n"));
    expect(card.bullets).toHaveLength(MAX_BULLETS);
  });

  it("제목의 마크다운 장식과 끝 콜론을 뗀다", () => {
    expect(parseCard("**정리:**\n- 하나").title).toBe("정리");
    expect(parseCard("## 제목\n- 하나").title).toBe("제목");
  });

  it("제목이 아주 길면 잘라 쓴다", () => {
    const card = parseCard(`${"가".repeat(100)}\n- 하나`);
    expect(card.title.length).toBeLessThanOrEqual(40);
    expect(card.title.endsWith("…")).toBe(true);
  });

  it("빈 줄이 섞여 있어도 읽는다", () => {
    const card = parseCard("제목\n\n- 하나\n\n- 둘\n");
    expect(card.bullets).toEqual(["하나", "둘"]);
  });
});

describe("parseCard — 규약을 어긴 답변 (폴백)", () => {
  it("불릿 없이 여러 줄이면 첫 줄이 제목, 나머지가 불릿", () => {
    const card = parseCard("서울 근교 워크숍\n가평 펜션이 접근성이 좋습니다\n양평은 조용합니다");
    expect(card).toEqual({
      title: "서울 근교 워크숍",
      bullets: ["가평 펜션이 접근성이 좋습니다", "양평은 조용합니다"],
      conformed: false,
    });
  });

  it("한 문단이면 첫 문장이 제목, 나머지 문장이 불릿", () => {
    const card = parseCard("부산은 항구 도시입니다. 해운대가 유명합니다. 겨울에도 따뜻합니다.");
    expect(card.title).toBe("부산은 항구 도시입니다.");
    expect(card.bullets).toEqual(["해운대가 유명합니다.", "겨울에도 따뜻합니다."]);
    expect(card.conformed).toBe(false);
  });

  it("문장 하나뿐이어도 카드가 만들어진다", () => {
    const card = parseCard("아직 정보가 없습니다");
    expect(card.title).toBe("아직 정보가 없습니다");
    expect(card.bullets).toEqual(["아직 정보가 없습니다"]);
    expect(card.conformed).toBe(false);
  });

  it("모든 줄이 불릿이면 첫 불릿이 제목이 된다", () => {
    const card = parseCard("- 하나입니다. 둘입니다.");
    expect(card.title).toBe("하나입니다.");
    expect(card.bullets).toEqual(["둘입니다."]);
    expect(card.conformed).toBe(false);
  });

  it("긴 불릿은 잘린다", () => {
    const card = parseCard(`제목\n- ${"가".repeat(300)}`);
    expect(card.bullets[0]!.length).toBeLessThanOrEqual(120);
  });

  it("빈 응답은 빈 카드다", () => {
    expect(parseCard("")).toEqual({ title: "", bullets: [], conformed: false });
    expect(parseCard("   \n  ")).toEqual({ title: "", bullets: [], conformed: false });
  });
});
