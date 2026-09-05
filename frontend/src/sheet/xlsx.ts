/**
 * Fortune-sheet ↔ SheetJS(xlsx) 변환.
 *
 * 보존 범위 (커뮤니티판 SheetJS 기준):
 * - 값(문자열·숫자·불리언)과 **수식 문자열**(`f`)
 * - 숫자 서식(`ct.fa` ↔ 셀의 `z`) — 예: `#,##0`
 * - 병합(`config.merge` ↔ `!merges`), 열 너비(`config.columnlen` ↔ `!cols`),
 *   행 높이(`config.rowlen` ↔ `!rows`)
 * - 굵게·배경색은 **읽기만** 최선을 다한다. SheetJS 커뮤니티판은 셀 스타일을
 *   **쓰지 못하므로**(Pro 기능) 내보낸 xlsx 에는 굵게·배경이 담기지 않는다.
 *
 * DOM 을 건드리지 않는 순수 변환 모듈이라 vitest 로 왕복 검증이 가능하다.
 */
import * as XLSX from "xlsx";
import { cellsOf, type SheetCell, type SheetCellData, type WorkSheet } from "./schema";

/** 엑셀 기본 열 너비(px) — columnlen 이 없을 때 기준값 */
const DEFAULT_COL_WIDTH = 73;

const isBlank = (cell: SheetCell | null | undefined): boolean =>
  !cell || (cell.v === undefined && cell.v === null) || (cell.v === undefined && !cell.f);

/** Fortune-sheet 셀 → SheetJS 셀 */
function toXlsxCell(cell: SheetCell): XLSX.CellObject | null {
  const value = cell.v;
  const formula = typeof cell.f === "string" && cell.f.length > 0 ? cell.f.replace(/^=/, "") : undefined;
  if (value === undefined || value === null || value === "") {
    if (!formula) return null;
    // 값이 아직 계산되지 않은 수식 셀도 수식은 보존한다.
    return { t: "n", f: formula, v: 0 } as XLSX.CellObject;
  }

  let out: XLSX.CellObject;
  if (typeof value === "number") out = { t: "n", v: value };
  else if (typeof value === "boolean") out = { t: "b", v: value };
  else out = { t: "s", v: String(value) };

  if (formula) out.f = formula;
  const fa = cell.ct?.fa;
  if (fa && fa !== "General" && fa !== "@") out.z = fa;
  return out;
}

/** SheetJS 셀 → Fortune-sheet 셀 */
function fromXlsxCell(cell: XLSX.CellObject): SheetCell | null {
  const out: SheetCell = {};
  const raw = cell.v;

  if (cell.t === "n" && typeof raw === "number") {
    out.v = raw;
    out.m = typeof cell.w === "string" ? cell.w : String(raw);
    out.ct = { fa: typeof cell.z === "string" ? cell.z : "General", t: "n" };
  } else if (cell.t === "b") {
    out.v = Boolean(raw);
    out.m = raw ? "TRUE" : "FALSE";
    out.ct = { fa: "General", t: "b" };
  } else if (raw !== undefined && raw !== null) {
    const text = typeof cell.w === "string" ? cell.w : String(raw);
    out.v = text;
    out.m = text;
    out.ct = { fa: "@", t: "s" };
  }

  if (typeof cell.f === "string" && cell.f.length > 0) out.f = `=${cell.f}`;

  // 스타일은 파일에 들어 있을 때만 최선을 다해 읽는다 (커뮤니티판은 대개 비어 있다).
  const style = (cell as { s?: Record<string, unknown> }).s;
  if (style) {
    const font = style.font as { bold?: boolean; color?: { rgb?: string } } | undefined;
    const fill = style.fill as { fgColor?: { rgb?: string } } | undefined;
    if (font?.bold) out.bl = 1;
    if (font?.color?.rgb) out.fc = `#${String(font.color.rgb).slice(-6)}`;
    if (fill?.fgColor?.rgb) out.bg = `#${String(fill.fgColor.rgb).slice(-6)}`;
  }

  if (out.v === undefined && !out.f) return null;
  return out;
}

/** 시트 한 장 → SheetJS 워크시트 */
export function sheetToWorksheet(sheet: WorkSheet): XLSX.WorkSheet {
  const cells = cellsOf(sheet);
  const ws: XLSX.WorkSheet = {};
  let maxRow = 0;
  let maxCol = 0;

  for (const item of cells) {
    if (!item.v || isBlank(item.v)) continue;
    const converted = toXlsxCell(item.v);
    if (!converted) continue;
    ws[XLSX.utils.encode_cell({ r: item.r, c: item.c })] = converted;
    if (item.r > maxRow) maxRow = item.r;
    if (item.c > maxCol) maxCol = item.c;
  }

  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });

  const merge = sheet.config?.merge;
  if (merge) {
    const merges = Object.values(merge).map((m) => ({
      s: { r: m.r, c: m.c },
      e: { r: m.r + Math.max(1, m.rs) - 1, c: m.c + Math.max(1, m.cs) - 1 },
    }));
    if (merges.length > 0) ws["!merges"] = merges;
  }

  const columnlen = sheet.config?.columnlen;
  if (columnlen && Object.keys(columnlen).length > 0) {
    const cols: XLSX.ColInfo[] = [];
    for (let c = 0; c <= maxCol; c += 1) {
      cols.push({ wpx: columnlen[String(c)] ?? DEFAULT_COL_WIDTH });
    }
    ws["!cols"] = cols;
  }

  const rowlen = sheet.config?.rowlen;
  if (rowlen && Object.keys(rowlen).length > 0) {
    const rows: XLSX.RowInfo[] = [];
    for (let r = 0; r <= maxRow; r += 1) {
      const h = rowlen[String(r)];
      rows.push(h ? { hpx: h } : {});
    }
    ws["!rows"] = rows;
  }

  return ws;
}

/** 워크북 전체 (시트 탭 순서 유지) */
export function sheetsToWorkbook(sheets: WorkSheet[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const ordered = [...sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const used = new Set<string>();
  for (const sheet of ordered) {
    // 엑셀 시트 이름 제약: 31자, `[]:*?/\` 불가, 중복 불가
    let name = (sheet.name || "시트").replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "시트";
    let suffix = 2;
    while (used.has(name)) {
      const base = name.slice(0, 28);
      name = `${base}(${suffix})`;
      suffix += 1;
    }
    used.add(name);
    XLSX.utils.book_append_sheet(wb, sheetToWorksheet(sheet), name);
  }
  return wb;
}

/** SheetJS 워크시트 → 시트 한 장 */
export function worksheetToSheet(ws: XLSX.WorkSheet, name: string, order = 0): WorkSheet {
  const celldata: SheetCellData[] = [];
  const refRange = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  const endRow = refRange?.e.r ?? 0;
  const endCol = refRange?.e.c ?? 0;

  for (let r = 0; r <= endRow; r += 1) {
    for (let c = 0; c <= endCol; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      const raw = ws[address] as XLSX.CellObject | undefined;
      if (!raw) continue;
      const cell = fromXlsxCell(raw);
      if (cell) celldata.push({ r, c, v: cell });
    }
  }

  const config: WorkSheet["config"] = {};
  const merges = ws["!merges"];
  if (merges && merges.length > 0) {
    const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
    for (const m of merges) {
      merge[`${m.s.r}_${m.s.c}`] = {
        r: m.s.r,
        c: m.s.c,
        rs: m.e.r - m.s.r + 1,
        cs: m.e.c - m.s.c + 1,
      };
    }
    config.merge = merge;
  }
  const cols = ws["!cols"];
  if (cols && cols.length > 0) {
    const columnlen: Record<string, number> = {};
    cols.forEach((col, index) => {
      const width = col?.wpx ?? (col?.wch ? Math.round(col.wch * 7.5) : undefined);
      if (width) columnlen[String(index)] = Math.round(width);
    });
    if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;
  }
  const rows = ws["!rows"];
  if (rows && rows.length > 0) {
    const rowlen: Record<string, number> = {};
    rows.forEach((row, index) => {
      const height = row?.hpx ?? (row?.hpt ? Math.round(row.hpt * (4 / 3)) : undefined);
      if (height) rowlen[String(index)] = Math.round(height);
    });
    if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;
  }

  return {
    name,
    order,
    row: Math.max(endRow + 1, 100),
    column: Math.max(endCol + 1, 26),
    celldata,
    config,
  };
}

/** 워크북 → 시트 목록 */
export function workbookToSheets(wb: XLSX.WorkBook): WorkSheet[] {
  return wb.SheetNames.map((name, index) => {
    const sheet = worksheetToSheet(wb.Sheets[name]!, name, index);
    return { ...sheet, id: `imported-${index}-${Date.now().toString(36)}` };
  });
}

/** 워크북을 xlsx 바이트로 (브라우저 다운로드용) */
export function workbookToBytes(wb: XLSX.WorkBook): Uint8Array {
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array;
}

/** 바이트 → 워크북 */
export function bytesToWorkbook(bytes: ArrayBuffer | Uint8Array): XLSX.WorkBook {
  return XLSX.read(bytes, { type: "array", cellStyles: true, cellNF: true, cellFormula: true });
}

/**
 * 현재 시트 한 장을 CSV 문자열로 (BOM 은 붙이는 쪽에서 처리).
 * 숫자는 표시 형식(`30,000`)이 아니라 원값(`30000`)으로 내보낸다 — 다시 계산에 쓰기 위해서다.
 */
export function sheetToCsv(sheet: WorkSheet): string {
  return XLSX.utils.sheet_to_csv(sheetToWorksheet(sheet), { blankrows: false, rawNumbers: true });
}
