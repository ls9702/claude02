import { describe, expect, it } from "vitest";
import {
  bytesToWorkbook,
  sheetToCsv,
  sheetsToWorkbook,
  workbookToBytes,
  workbookToSheets,
} from "./xlsx";
import { cellsOf, type SheetCell, type WorkSheet } from "./schema";

const cell = (r: number, c: number, v: SheetCell) => ({ r, c, v });

/** 회비 장부와 같은 모양의 시트 (값·수식·서식·병합·열 너비) */
function ledgerLike(): WorkSheet {
  return {
    name: "장부",
    id: "ledger",
    order: 0,
    row: 210,
    column: 14,
    celldata: [
      cell(0, 0, { v: "날짜", m: "날짜", bl: 1, bg: "#eef1f6" }),
      cell(0, 1, { v: "구분", m: "구분", bl: 1 }),
      cell(0, 3, { v: "금액", m: "금액", bl: 1 }),
      cell(1, 0, { v: "2026-01-05", m: "2026-01-05", ct: { fa: "@", t: "s" } }),
      cell(1, 1, { v: "수입", m: "수입" }),
      cell(1, 3, { v: 30000, m: "30,000", ct: { fa: "#,##0", t: "n" } }),
      cell(2, 0, { v: "2026-01-20", m: "2026-01-20", ct: { fa: "@", t: "s" } }),
      cell(2, 1, { v: "지출", m: "지출" }),
      cell(2, 3, { v: 45000, m: "45,000", ct: { fa: "#,##0", t: "n" } }),
      cell(3, 1, { v: true, m: "TRUE" }),
      // 합계 수식 (값이 이미 계산된 상태)
      cell(203, 2, { v: "수입 합계", m: "수입 합계", bl: 1 }),
      cell(203, 3, {
        f: '=SUMIF(B2:B201,"수입",D2:D201)',
        v: 30000,
        m: "30,000",
        ct: { fa: "#,##0", t: "n" },
      }),
      cell(205, 3, { f: "=D204-D205", v: -15000, m: "-15,000", ct: { fa: "#,##0", t: "n" } }),
      // 아직 계산되지 않은 수식
      cell(206, 3, { f: '=SUMIFS($D$2:$D$201,$B$2:$B$201,"수입",$G$2:$G$201,$I2)' }),
    ],
    config: {
      merge: { "0_5": { r: 0, c: 5, rs: 1, cs: 2 } },
      columnlen: { 0: 100, 3: 110 },
      rowlen: { 0: 24 },
    },
  };
}

/** 한 시트를 xlsx 바이트로 내보냈다가 다시 읽어 온다 */
function roundTrip(sheet: WorkSheet): WorkSheet {
  const bytes = workbookToBytes(sheetsToWorkbook([sheet]));
  const sheets = workbookToSheets(bytesToWorkbook(bytes));
  expect(sheets).toHaveLength(1);
  return sheets[0]!;
}

const find = (sheet: WorkSheet, r: number, c: number): SheetCell | null =>
  cellsOf(sheet).find((item) => item.r === r && item.c === c)?.v ?? null;

describe("xlsx 왕복", () => {
  it("값과 자료형이 보존된다", () => {
    const back = roundTrip(ledgerLike());
    expect(back.name).toBe("장부");
    expect(find(back, 0, 0)?.v).toBe("날짜");
    expect(find(back, 1, 0)?.v).toBe("2026-01-05");
    expect(find(back, 1, 3)?.v).toBe(30000);
    expect(find(back, 1, 3)?.ct?.t).toBe("n");
    expect(find(back, 3, 1)?.v).toBe(true);
  });

  it("수식 문자열이 보존된다 (계산 전 수식 포함)", () => {
    const back = roundTrip(ledgerLike());
    expect(find(back, 203, 3)?.f).toBe('=SUMIF(B2:B201,"수입",D2:D201)');
    expect(find(back, 205, 3)?.f).toBe("=D204-D205");
    expect(find(back, 206, 3)?.f).toBe(
      '=SUMIFS($D$2:$D$201,$B$2:$B$201,"수입",$G$2:$G$201,$I2)',
    );
  });

  it("숫자 서식·병합·열 너비·행 높이가 보존된다", () => {
    const back = roundTrip(ledgerLike());
    expect(find(back, 1, 3)?.ct?.fa).toBe("#,##0");
    expect(back.config?.merge?.["0_5"]).toEqual({ r: 0, c: 5, rs: 1, cs: 2 });
    expect(back.config?.columnlen?.["0"]).toBe(100);
    expect(back.config?.columnlen?.["3"]).toBe(110);
    expect(back.config?.rowlen?.["0"]).toBe(24);
  });

  it("두 번 왕복해도 값·수식이 그대로다", () => {
    const once = roundTrip(ledgerLike());
    const twice = roundTrip(once);
    expect(find(twice, 1, 3)?.v).toBe(30000);
    expect(find(twice, 203, 3)?.f).toBe('=SUMIF(B2:B201,"수입",D2:D201)');
    expect(find(twice, 1, 0)?.v).toBe("2026-01-05");
  });

  it("여러 시트 탭의 순서와 이름을 지킨다", () => {
    const sheets: WorkSheet[] = [
      { name: "둘째", order: 1, celldata: [cell(0, 0, { v: 2, m: "2" })] },
      { name: "첫째", order: 0, celldata: [cell(0, 0, { v: 1, m: "1" })] },
    ];
    const back = workbookToSheets(bytesToWorkbook(workbookToBytes(sheetsToWorkbook(sheets))));
    expect(back.map((s) => s.name)).toEqual(["첫째", "둘째"]);
    expect(find(back[0]!, 0, 0)?.v).toBe(1);
  });

  it("엑셀에서 금지된 시트 이름 문자를 바꾸고 중복을 피한다", () => {
    const sheets: WorkSheet[] = [
      { name: "가/나:다", order: 0, celldata: [] },
      { name: "가_나_다", order: 1, celldata: [] },
    ];
    const wb = sheetsToWorkbook(sheets);
    expect(wb.SheetNames[0]).toBe("가_나_다");
    expect(wb.SheetNames[1]).not.toBe(wb.SheetNames[0]);
  });

  it("data 행렬만 있는 시트도 내보낼 수 있다", () => {
    const sheet: WorkSheet = {
      name: "행렬",
      data: [
        [{ v: "a", m: "a" }, null],
        [null, { v: 5, m: "5" }],
      ],
    };
    const back = roundTrip(sheet);
    expect(find(back, 0, 0)?.v).toBe("a");
    expect(find(back, 1, 1)?.v).toBe(5);
  });
});

describe("CSV 내보내기", () => {
  it("현재 시트의 값을 CSV 로 만든다", () => {
    const csv = sheetToCsv(ledgerLike());
    const lines = csv.split("\n");
    expect(lines[0]).toContain("날짜");
    expect(lines[1]).toContain("2026-01-05");
    expect(lines[1]).toContain("수입");
    expect(lines[1]).toContain("30000");
  });
});
