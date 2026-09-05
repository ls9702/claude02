import { describe, expect, it } from "vitest";
import {
  anchorScenePoint,
  elementAnchor,
  hitTestElement,
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

describe("회전한 요소", () => {
  /** 중심 (200,200), 한 변 200 인 정사각형을 45° 돌린 것 */
  const square45 = el({
    id: "rot",
    x: 100,
    y: 100,
    width: 200,
    height: 200,
    angle: Math.PI / 4,
  });

  it("앵커(우상단)도 중심을 기준으로 함께 돈다", () => {
    // 우상단 (300,100) 은 중심에서 (100,-100) → 45° 회전 후 (141.42, 0) → 씬 좌표 (341.42, 200)
    const anchor = elementAnchor(square45);
    expect(anchor.sceneX).toBeCloseTo(200 + Math.sqrt(2) * 100, 6);
    expect(anchor.sceneY).toBeCloseTo(200, 6);
  });

  it("회전이 없으면 예전과 같은 우상단이다", () => {
    expect(elementAnchor(el({ id: "a", x: 5, y: 6, width: 20, height: 30, angle: 0 }))).toEqual({
      sceneX: 25,
      sceneY: 6,
    });
  });

  it("45° 회전한 사각형의 실제 꼭짓점 근처는 히트한다 (예전에는 빗나갔다)", () => {
    // 회전 후 위쪽 꼭짓점: 중심에서 위로 반대각선(141.42) → y ≈ 58.58 (예전 bbox 는 y>=100 만 인정)
    const apexY = 200 - Math.sqrt(2) * 100;
    expect(hitTestElement(square45, 200, apexY + 1)).toBe(true);
    expect(hitTestTopmost([square45], 200, apexY + 1)?.id).toBe("rot");
  });

  it("45° 회전한 사각형 바깥(축 정렬 bbox 의 모서리)은 히트하지 않는다", () => {
    // (105,105) 는 비회전 bbox 안이지만 회전한 다이아몬드 바깥이다.
    expect(hitTestElement(square45, 105, 105)).toBe(false);
    expect(hitTestTopmost([square45], 105, 105)).toBeNull();
  });

  it("중심은 회전과 무관하게 항상 히트한다", () => {
    expect(hitTestElement(square45, 200, 200)).toBe(true);
  });

  it("회전한 직사각형은 짧은 축 방향으로도 정확히 판정한다", () => {
    // 200×40 을 90° 돌리면 화면상 40×200 이 된다.
    const rotated = el({ id: "r90", x: 0, y: 0, width: 200, height: 40, angle: Math.PI / 2 });
    // 세로로 길어진 자리(중심 위 80px)는 히트, 가로로 멀어진 자리(중심 오른쪽 80px)는 미스
    expect(hitTestElement(rotated, 100, 20 - 80)).toBe(true);
    expect(hitTestElement(rotated, 100 + 80, 20)).toBe(false);
  });
});
