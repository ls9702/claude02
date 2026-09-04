import { describe, expect, it } from "vitest";
import {
  differsFromIncoming,
  pickSharedAppState,
  pickWinner,
  reconcileElements,
  type ReconcilableElement,
} from "../src/scenes/reconcile.js";

const el = (
  id: string,
  version: number,
  versionNonce: number,
  extra: Partial<ReconcilableElement> = {},
): ReconcilableElement => ({ id, version, versionNonce, ...extra });

describe("pickWinner", () => {
  it("version 이 큰 쪽을 채택한다", () => {
    expect(pickWinner(el("a", 1, 100), el("a", 2, 900))).toMatchObject({ version: 2 });
    expect(pickWinner(el("a", 5, 100), el("a", 2, 900))).toMatchObject({ version: 5 });
  });

  it("version 이 같으면 versionNonce 가 작은 쪽을 채택한다", () => {
    expect(pickWinner(el("a", 3, 900), el("a", 3, 100))).toMatchObject({ versionNonce: 100 });
    expect(pickWinner(el("a", 3, 100), el("a", 3, 900))).toMatchObject({ versionNonce: 100 });
  });

  it("완전히 같으면 저장된 쪽을 유지한다 (결과가 흔들리지 않게)", () => {
    const stored = el("a", 3, 100);
    const incoming = el("a", 3, 100);
    expect(pickWinner(stored, incoming)).toBe(stored);
  });

  it("version 이 없으면 0으로 본다", () => {
    expect(pickWinner({ id: "a" }, el("a", 1, 5))).toMatchObject({ version: 1 });
  });
});

describe("reconcileElements", () => {
  it("한쪽에만 있는 요소는 그대로 포함한다", () => {
    const stored = [el("a", 1, 10)];
    const incoming = [el("b", 1, 20)];
    const merged = reconcileElements(stored, incoming);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("들어온 씬의 순서를 유지하고, 저장에만 있는 요소는 뒤에 덧붙인다", () => {
    const stored = [el("a", 1, 10), el("z", 1, 10)];
    const incoming = [el("c", 1, 10), el("a", 1, 10), el("b", 1, 10)];
    const merged = reconcileElements(stored, incoming);
    expect(merged.map((e) => e.id)).toEqual(["c", "a", "b", "z"]);
  });

  it("같은 id 는 버전 규칙으로 승자를 고른다", () => {
    const stored = [el("a", 5, 10, { text: "저장됨" })];
    const incoming = [el("a", 2, 1, { text: "들어옴" })];
    const merged = reconcileElements(stored, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ version: 5, text: "저장됨" });
  });

  it("isDeleted 요소도 버전 비교 대상이다 — 새 삭제가 이긴다", () => {
    const stored = [el("a", 4, 10, { isDeleted: false })];
    const incoming = [el("a", 5, 10, { isDeleted: true })];
    const merged = reconcileElements(stored, incoming);
    expect(merged[0]).toMatchObject({ isDeleted: true, version: 5 });
  });

  it("isDeleted 요소도 버전 비교 대상이다 — 오래된 삭제는 진다", () => {
    const stored = [el("a", 9, 10, { isDeleted: false, text: "되살아난 요소" })];
    const incoming = [el("a", 3, 10, { isDeleted: true })];
    const merged = reconcileElements(stored, incoming);
    expect(merged[0]).toMatchObject({ isDeleted: false, text: "되살아난 요소" });
  });

  it("삭제된 요소도 결과에 남긴다 (tombstone)", () => {
    const stored = [el("a", 2, 10, { isDeleted: true })];
    const merged = reconcileElements(stored, []);
    expect(merged.map((e) => e.id)).toEqual(["a"]);
  });

  it("들어온 씬의 중복 id 는 첫 번째만 남긴다", () => {
    const merged = reconcileElements([], [el("a", 1, 1), el("a", 9, 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ version: 1 });
  });

  it("빈 입력을 안전하게 처리한다", () => {
    expect(reconcileElements([], [])).toEqual([]);
  });
});

describe("differsFromIncoming", () => {
  it("동일하면 false", () => {
    const incoming = [el("a", 1, 1), el("b", 2, 2)];
    expect(differsFromIncoming(reconcileElements(incoming, incoming), incoming)).toBe(false);
  });

  it("저장 쪽 요소가 살아남으면 true", () => {
    const stored = [el("a", 9, 1)];
    const incoming = [el("a", 1, 1)];
    expect(differsFromIncoming(reconcileElements(stored, incoming), incoming)).toBe(true);
  });

  it("저장에만 있는 요소가 덧붙으면 true", () => {
    const stored = [el("z", 1, 1)];
    const incoming = [el("a", 1, 1)];
    expect(differsFromIncoming(reconcileElements(stored, incoming), incoming)).toBe(true);
  });
});

describe("pickSharedAppState", () => {
  it("공유 가능한 키만 남긴다", () => {
    const result = pickSharedAppState({
      viewBackgroundColor: "#fff",
      gridSize: 20,
      scrollX: 123,
      scrollY: 456,
      zoom: { value: 2 },
      selectedElementIds: { a: true },
      collaborators: [],
    });
    expect(result).toEqual({ viewBackgroundColor: "#fff", gridSize: 20 });
  });

  it("객체가 아니면 빈 객체", () => {
    expect(pickSharedAppState(null)).toEqual({});
    expect(pickSharedAppState("x")).toEqual({});
    expect(pickSharedAppState(undefined)).toEqual({});
  });
});
