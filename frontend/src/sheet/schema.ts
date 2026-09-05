/**
 * 시트 저장 스키마 (프런트 쪽 타입).
 *
 * 서버와 같은 래퍼를 쓴다: `{ engine, engineVersion, sheets }`.
 * Fortune-sheet 의 `Sheet` 전체를 그대로 담되, 저장할 때는 `data`(행렬) 대신
 * `celldata`(희소 배열)로 줄인다 — 200행 × 14열의 null 을 저장할 이유가 없다.
 */

export const SHEET_ENGINE = "fortune-sheet";
export const SHEET_ENGINE_VERSION = "1.0.4";

export interface SheetCell {
  v?: string | number | boolean | null;
  m?: string | number;
  f?: string;
  ct?: { fa?: string; t?: string };
  bl?: number;
  it?: number;
  bg?: string;
  fc?: string;
  ht?: number;
  vt?: number;
  fs?: number;
  mc?: { r: number; c: number; rs?: number; cs?: number };
  [key: string]: unknown;
}

export interface SheetCellData {
  r: number;
  c: number;
  v: SheetCell | null;
}

export interface WorkSheet {
  name: string;
  id?: string;
  order?: number;
  status?: number;
  row?: number;
  column?: number;
  celldata?: SheetCellData[];
  data?: (SheetCell | null)[][];
  config?: {
    merge?: Record<string, { r: number; c: number; rs: number; cs: number }>;
    columnlen?: Record<string, number>;
    rowlen?: Record<string, number>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SheetDoc {
  engine: string;
  engineVersion: string;
  sheets: WorkSheet[];
}

/** 빈 문서 (서버 응답이 이상할 때의 안전망) */
export const emptyDoc = (): SheetDoc => ({
  engine: SHEET_ENGINE,
  engineVersion: SHEET_ENGINE_VERSION,
  sheets: [{ name: "시트1", id: "sheet1", order: 0, status: 1, row: 100, column: 26, celldata: [] }],
});

/** 서버에서 받은 값이 우리 래퍼인지 확인하고, 아니면 빈 문서로 대체한다. */
export function normalizeDoc(value: unknown): SheetDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDoc();
  const doc = value as Partial<SheetDoc>;
  if (!Array.isArray(doc.sheets) || doc.sheets.length === 0) return emptyDoc();
  const sheets = doc.sheets.filter(
    (sheet): sheet is WorkSheet =>
      !!sheet && typeof sheet === "object" && typeof (sheet as WorkSheet).name === "string",
  );
  if (sheets.length === 0) return emptyDoc();
  return {
    engine: typeof doc.engine === "string" ? doc.engine : SHEET_ENGINE,
    engineVersion: typeof doc.engineVersion === "string" ? doc.engineVersion : SHEET_ENGINE_VERSION,
    sheets,
  };
}

/** 행렬(data) → 희소 배열(celldata) */
export function dataToCelldata(data: (SheetCell | null)[][] | undefined): SheetCellData[] {
  if (!data) return [];
  const cells: SheetCellData[] = [];
  data.forEach((row, r) => {
    row?.forEach((cell, c) => {
      if (cell !== null && cell !== undefined) cells.push({ r, c, v: cell });
    });
  });
  return cells;
}

/** 시트에서 셀 목록을 얻는다 (celldata 우선, 없으면 data 행렬에서 만든다). */
export function cellsOf(sheet: WorkSheet): SheetCellData[] {
  if (sheet.celldata && sheet.celldata.length > 0) return sheet.celldata;
  return dataToCelldata(sheet.data);
}

/** 저장용으로 시트를 정리한다 (`data` 행렬 제거 → `celldata`). */
export function toStorableSheet(sheet: WorkSheet): WorkSheet {
  const { data: _data, ...rest } = sheet;
  return { ...rest, celldata: cellsOf(sheet) };
}

/** 저장용 문서 */
export function toStorableDoc(sheets: WorkSheet[]): SheetDoc {
  return {
    engine: SHEET_ENGINE,
    engineVersion: SHEET_ENGINE_VERSION,
    sheets: sheets.map(toStorableSheet),
  };
}
