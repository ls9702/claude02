import { describe, expect, it } from "vitest";
import { CARD_WIDTH, buildCardElements, textUnits, wrapText, type CardSkeleton } from "./cardBuilder";

const base = {
  title: "부산 2박 3일",
  bullets: ["광안리 야경", "자갈치 시장"],
  query: "부산 여행 코스",
  by: "alice",
  at: "2026-09-05T03:04:05.000Z",
  center: { x: 0, y: 0 },
  groupId: "g1",
};

const textsOf = (elements: CardSkeleton[]): string[] =>
  elements.filter((el) => el.type === "text").map((el) => el.text ?? "");

describe("wrapText", () => {
  it("한도 안이면 한 줄", () => {
    expect(wrapText("짧은 글", 20)).toEqual(["짧은 글"]);
  });

  it("띄어쓰기에서 줄을 바꾼다", () => {
    expect(wrapText("가나다 라마바 사아자", 7)).toEqual(["가나다 라마바", "사아자"]);
  });

  it("한 낱말이 한 줄보다 길면 글자 단위로 자른다", () => {
    expect(wrapText("가".repeat(10), 4)).toEqual(["가가가가", "가가가가", "가가"]);
  });

  it("빈 글은 빈 배열", () => {
    expect(wrapText("   ", 10)).toEqual([]);
  });

  it("한글은 라틴 문자보다 넓게 센다", () => {
    expect(textUnits("가")).toBeGreaterThan(textUnits("a"));
    expect(textUnits("가나")).toBe(2);
  });
});

describe("buildCardElements", () => {
  it("컨테이너 + 제목 + 본문 + 만든이 줄을 만든다", () => {
    const card = buildCardElements(base);
    expect(card.elements[0]!.type).toBe("rectangle");
    expect(card.width).toBe(CARD_WIDTH);
    expect(card.elements.filter((el) => el.type === "text")).toHaveLength(3);

    const texts = textsOf(card.elements);
    expect(texts[0]).toBe("부산 2박 3일");
    expect(texts[1]).toBe("• 광안리 야경\n• 자갈치 시장");
    expect(texts[2]).toBe("Gemini · alice");
  });

  it("모든 요소가 같은 groupIds 와 customData.aiCard 를 갖는다", () => {
    const card = buildCardElements(base);
    for (const element of card.elements) {
      expect(element.groupIds).toEqual(["g1"]);
      expect(element.customData.aiCard).toEqual({
        query: "부산 여행 코스",
        at: "2026-09-05T03:04:05.000Z",
        by: "alice",
      });
    }
    expect(card.groupId).toBe("g1");
  });

  it("출처는 요소마다 link 를 달고 번호를 붙인다", () => {
    const card = buildCardElements({
      ...base,
      sources: [
        { title: "부산시 공식", url: "https://busan.test" },
        { title: "여행 블로그", url: "https://blog.test" },
      ],
    });
    const links = card.elements.filter((el) => el.link);
    expect(links).toHaveLength(2);
    expect(links[0]!.link).toBe("https://busan.test");
    expect(links[0]!.text).toBe("[1] 부산시 공식");
    expect(links[1]!.text).toBe("[2] 여행 블로그");
    expect(textsOf(card.elements).at(-1)).toBe("Gemini · 검색 2건 · alice");
  });

  it("출처는 최대 5개까지 넣는다", () => {
    const card = buildCardElements({
      ...base,
      sources: Array.from({ length: 8 }, (_, i) => ({ title: `출처 ${i}`, url: `https://${i}.test` })),
    });
    expect(card.elements.filter((el) => el.link)).toHaveLength(5);
  });

  it("카드는 주어진 중심에 놓인다", () => {
    const card = buildCardElements({ ...base, center: { x: 500, y: 300 } });
    expect(card.x).toBe(500 - CARD_WIDTH / 2);
    expect(card.y).toBe(Math.round(300 - card.height / 2));
    const container = card.elements[0]!;
    expect(container.x).toBe(card.x);
    expect(container.y).toBe(card.y);
    expect(container.height).toBe(card.height);
  });

  it("내용이 많을수록 컨테이너가 높아지고 요소가 그 안에 들어간다", () => {
    const short = buildCardElements(base);
    const long = buildCardElements({
      ...base,
      bullets: Array.from({ length: 6 }, (_, i) => `${"가".repeat(60)} ${i}`),
      sources: [{ title: "출처", url: "https://a.test" }],
    });
    expect(long.height).toBeGreaterThan(short.height);

    for (const element of long.elements.slice(1)) {
      expect(element.y).toBeGreaterThanOrEqual(long.y);
      expect(element.y).toBeLessThan(long.y + long.height);
      expect(element.x).toBeGreaterThanOrEqual(long.x);
    }
  });

  it("불릿이 없어도(빈 답변 폴백) 카드가 만들어진다", () => {
    const card = buildCardElements({ ...base, bullets: [] });
    expect(card.elements.filter((el) => el.type === "text")).toHaveLength(2);
    expect(card.height).toBeGreaterThan(0);
  });

  it("제목이 비어 있으면 기본 제목을 쓴다", () => {
    expect(textsOf(buildCardElements({ ...base, title: "  " }).elements)[0]).toBe("AI 답변");
  });

  it("긴 제목·불릿은 카드 폭에 맞춰 줄바꿈된다", () => {
    const card = buildCardElements({ ...base, title: "가".repeat(40), bullets: ["나".repeat(60)] });
    const texts = textsOf(card.elements);
    expect(texts[0]!.split("\n").length).toBeGreaterThan(1);
    // 이어지는 줄은 두 칸 들여쓴다.
    expect(texts[1]!.split("\n")[1]!.startsWith("  ")).toBe(true);
  });

  it("groupId 를 주지 않으면 매번 새로 만든다", () => {
    const { groupId } = buildCardElements({ ...base, groupId: undefined });
    const other = buildCardElements({ ...base, groupId: undefined });
    expect(groupId).not.toBe(other.groupId);
    expect(groupId.startsWith("ai-")).toBe(true);
  });
});
