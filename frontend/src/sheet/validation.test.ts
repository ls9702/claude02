import { describe, expect, it } from "vitest";
import {
  AMOUNT_REJECT_MESSAGE,
  DATE_REJECT_MESSAGE,
  checkCellInput,
  type CellRule,
} from "./validation";

const amount: CellRule = { type: "number" };
const date: CellRule = { type: "date" };

describe("금액 칸 (type: number)", () => {
  it("숫자는 그대로 통과한다", () => {
    expect(checkCellInput(amount, "30000")).toEqual({ kind: "accept" });
    expect(checkCellInput(amount, "-3000")).toEqual({ kind: "accept" });
    expect(checkCellInput(amount, "0")).toEqual({ kind: "accept" });
    expect(checkCellInput(amount, 12000)).toEqual({ kind: "accept" });
  });

  /** 검증 리포트 Finding 1 — 이 한 칸이 합계·잔액을 통째로 틀어지게 했다. */
  it("문자가 섞이면 되돌리고 한국어로 안내한다", () => {
    expect(checkCellInput(amount, "오만원")).toEqual({
      kind: "reject",
      message: AMOUNT_REJECT_MESSAGE,
    });
    expect(checkCellInput(amount, "30000원")).toEqual({
      kind: "reject",
      message: AMOUNT_REJECT_MESSAGE,
    });
    expect(checkCellInput(amount, "1-2")).toMatchObject({ kind: "reject" });
    expect(checkCellInput(amount, "3만")).toMatchObject({ kind: "reject" });
  });

  it("자릿수 쉼표는 받아서 숫자로 바꿔 준다", () => {
    expect(checkCellInput(amount, "50,000")).toEqual({ kind: "replace", value: 50000 });
    expect(checkCellInput(amount, " 7000 ")).toEqual({ kind: "replace", value: 7000 });
    expect(checkCellInput(amount, "-1,200")).toEqual({ kind: "replace", value: -1200 });
  });

  it("빈 값(지우기)과 수식은 막지 않는다", () => {
    expect(checkCellInput(amount, "")).toEqual({ kind: "accept" });
    expect(checkCellInput(amount, "   ")).toEqual({ kind: "accept" });
    expect(checkCellInput(amount, null)).toEqual({ kind: "accept" });
    expect(checkCellInput(amount, "=D2*2")).toEqual({ kind: "accept" });
  });
});

describe("날짜 칸 (type: date)", () => {
  it("yyyy-MM-dd 는 그대로 통과한다", () => {
    expect(checkCellInput(date, "2026-03-10")).toEqual({ kind: "accept" });
  });

  /** 검증 리포트 Finding 2 — 형식이 다르면 월별 요약에서 조용히 빠졌다. */
  it("슬래시·점 표기는 받아서 yyyy-MM-dd 로 바꿔 준다", () => {
    expect(checkCellInput(date, "2026/03/10")).toEqual({ kind: "replace", value: "2026-03-10" });
    expect(checkCellInput(date, "2026.3.5")).toEqual({ kind: "replace", value: "2026-03-05" });
    expect(checkCellInput(date, "2026-3-5")).toEqual({ kind: "replace", value: "2026-03-05" });
  });

  it("연도가 두 자리거나 날짜가 아니면 되돌리고 안내한다", () => {
    expect(checkCellInput(date, "26.3.15")).toEqual({
      kind: "reject",
      message: DATE_REJECT_MESSAGE,
    });
    expect(checkCellInput(date, "3/10")).toMatchObject({ kind: "reject" });
    expect(checkCellInput(date, "내일")).toMatchObject({ kind: "reject" });
    // 없는 날짜도 막는다.
    expect(checkCellInput(date, "2026-02-30")).toMatchObject({ kind: "reject" });
    expect(checkCellInput(date, "2026-13-01")).toMatchObject({ kind: "reject" });
  });

  it("빈 값(지우기)은 막지 않는다", () => {
    expect(checkCellInput(date, "")).toEqual({ kind: "accept" });
  });
});

describe("그 밖의 칸", () => {
  it("규칙이 없거나 드롭다운이면 손대지 않는다", () => {
    expect(checkCellInput(undefined, "아무 값")).toEqual({ kind: "accept" });
    expect(checkCellInput(null, "아무 값")).toEqual({ kind: "accept" });
    expect(checkCellInput({ type: "dropdown" }, "수입")).toEqual({ kind: "accept" });
    expect(checkCellInput({ type: "dropdown" }, "기타")).toEqual({ kind: "accept" });
  });
});
