import { describe, expect, it } from "vitest";
import {
  anchorScenePoint,
  elementAnchor,
  hitTestTopmost,
  indexElements,
  needsOrphanCoordUpdate,
  type AnchorElement,
} from "./anchor";
import { colorOf, displayName, formatTime, initialOf, previewOf } from "./format";

const el = (over: Partial<AnchorElement> & { id: string }): AnchorElement => ({
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...over,
});

describe("anchorScenePoint", () => {
  it("좌표 앵커는 저장된 좌표를 그대로 쓴다", () => {
    const point = anchorScenePoint({ elementId: null, x: 12, y: 34 }, new Map());
    expect(point).toEqual({ sceneX: 12, sceneY: 34, orphaned: false });
  });

  it("요소 앵커는 요소의 우상단을 따라간다", () => {
    const elements = indexElements([el({ id: "a", x: 10, y: 20, width: 100, height: 50 })]);
    expect(anchorScenePoint({ elementId: "a", x: 0, y: 0 }, elements)).toEqual({
      sceneX: 110,
      sceneY: 20,
      orphaned: false,
    });
  });

  it("요소가 움직이면 핀도 움직인다", () => {
    const before = indexElements([el({ id: "a", x: 0, y: 0 })]);
    const after = indexElements([el({ id: "a", x: 300, y: 150 })]);
    expect(anchorScenePoint({ elementId: "a", x: 0, y: 0 }, before).sceneX).toBe(100);
    expect(anchorScenePoint({ elementId: "a", x: 0, y: 0 }, after).sceneX).toBe(400);
    expect(anchorScenePoint({ elementId: "a", x: 0, y: 0 }, after).sceneY).toBe(150);
  });

  it("요소가 삭제되면 고아가 되고 마지막 위치를 유지한다", () => {
    const elements = indexElements([el({ id: "a", x: 300, y: 150, isDeleted: true })]);
    expect(anchorScenePoint({ elementId: "a", x: 0, y: 0 }, elements)).toEqual({
      sceneX: 400,
      sceneY: 150,
      orphaned: true,
    });
  });

  it("씬에 없는 요소를 가리키면 저장된 좌표로 되돌아가고 고아가 된다", () => {
    expect(anchorScenePoint({ elementId: "gone", x: 7, y: 8 }, new Map())).toEqual({
      sceneX: 7,
      sceneY: 8,
      orphaned: true,
    });
  });

  it("elementAnchor 는 우상단이다", () => {
    expect(elementAnchor(el({ id: "a", x: 5, y: 6, width: 20, height: 30 }))).toEqual({
      sceneX: 25,
      sceneY: 6,
    });
  });
});

describe("needsOrphanCoordUpdate", () => {
  it("고아가 되었고 저장 좌표가 다르면 갱신이 필요하다", () => {
    expect(
      needsOrphanCoordUpdate({ elementId: "a", x: 0, y: 0 }, { sceneX: 400, sceneY: 150, orphaned: true }),
    ).toBe(true);
  });

  it("좌표가 이미 같으면 갱신하지 않는다 (재요청 루프 방지)", () => {
    expect(
      needsOrphanCoordUpdate({ elementId: "a", x: 400, y: 150 }, { sceneX: 400, sceneY: 150, orphaned: true }),
    ).toBe(false);
  });

  it("살아 있는 요소나 좌표 앵커는 갱신하지 않는다", () => {
    expect(
      needsOrphanCoordUpdate({ elementId: "a", x: 0, y: 0 }, { sceneX: 400, sceneY: 150, orphaned: false }),
    ).toBe(false);
    expect(
      needsOrphanCoordUpdate({ elementId: null, x: 0, y: 0 }, { sceneX: 400, sceneY: 150, orphaned: true }),
    ).toBe(false);
  });
});

describe("hitTestTopmost", () => {
  const elements = [
    el({ id: "bottom", x: 0, y: 0, width: 200, height: 200 }),
    el({ id: "top", x: 50, y: 50, width: 50, height: 50 }),
    el({ id: "deleted", x: 50, y: 50, width: 50, height: 50, isDeleted: true }),
  ];

  it("겹치면 가장 위(마지막) 요소를 고른다", () => {
    expect(hitTestTopmost(elements, 60, 60)?.id).toBe("top");
  });

  it("삭제된 요소는 고르지 않는다", () => {
    expect(hitTestTopmost([elements[2]!], 60, 60)).toBeNull();
  });

  it("겹치지 않는 지점은 아래 요소를 고른다", () => {
    expect(hitTestTopmost(elements, 150, 150)?.id).toBe("bottom");
  });

  it("빈 공간이면 null", () => {
    expect(hitTestTopmost(elements, 500, 500)).toBeNull();
  });

  it("음수 폭(뒤집힌 요소)도 처리한다", () => {
    const flipped = [el({ id: "flip", x: 100, y: 100, width: -50, height: -50 })];
    expect(hitTestTopmost(flipped, 75, 75)?.id).toBe("flip");
  });
});

describe("표시 helper", () => {
  it("이니셜은 첫 글자 대문자", () => {
    expect(initialOf("alice")).toBe("A");
    expect(initialOf("홍길동")).toBe("홍");
    expect(initialOf("")).toBe("?");
    expect(initialOf(null)).toBe("?");
  });

  it("같은 이름은 항상 같은 색", () => {
    expect(colorOf("alice")).toBe(colorOf("alice"));
    expect(colorOf("alice")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("삭제된 사용자 이름 표시", () => {
    expect(displayName(null)).toBe("(삭제된 사용자)");
    expect(displayName("bob")).toBe("bob");
  });

  it("미리보기는 공백을 접고 길이를 자른다", () => {
    expect(previewOf("  여러  줄\n내용  ")).toBe("여러 줄 내용");
    expect(previewOf("가".repeat(100))).toHaveLength(61);
  });

  it("잘못된 시각 문자열은 빈 문자열", () => {
    expect(formatTime("nope")).toBe("");
    expect(formatTime(new Date("2026-09-05T03:04:00Z").toISOString())).not.toBe("");
  });
});
