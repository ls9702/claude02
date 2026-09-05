/**
 * 시트 문서 읽기/검증.
 *
 * 저장 포맷은 `{ engine, engineVersion, sheets }` 래퍼다(templates.ts 참고).
 * 서버는 Fortune-sheet 의 내부 구조를 해석하지 않는다 — 형태와 크기만 확인하고
 * 그대로 보관한다(엔진 교체 시 마이그레이션할 수 있도록).
 */
import type { Db } from "../db/index.js";
import { badRequest, payloadTooLarge } from "../errors.js";
import { nowIso } from "../ids.js";
import { emptySheetDoc, SHEET_ENGINE, SHEET_ENGINE_VERSION, type SheetDoc } from "./templates.js";

/** 시트 문서 1개 최대 크기 (직렬화 기준) */
export const MAX_SHEET_BYTES = 4 * 1024 * 1024;
/** 워크북 1개당 시트 탭 수 상한 */
export const MAX_SHEETS = 20;

export interface SheetRow {
  page_id: string;
  data: string;
  version: number;
  updated_at: string;
}

export interface StoredSheet {
  data: SheetDoc;
  version: number;
  updatedAt: string;
}

/** 저장된 문서를 읽는다. 행이 없거나 M1 시절의 빈 `{}` 이면 빈 시트를 돌려준다. */
export function readSheet(db: Db, pageId: string): StoredSheet {
  const row = db
    .prepare<[string], SheetRow>("SELECT * FROM sheets WHERE page_id = ?")
    .get(pageId);
  if (!row) {
    const at = nowIso();
    const doc = emptySheetDoc();
    db.prepare("INSERT INTO sheets (page_id, data, version, updated_at) VALUES (?, ?, 0, ?)").run(
      pageId,
      JSON.stringify(doc),
      at,
    );
    return { data: doc, version: 0, updatedAt: at };
  }
  return { data: parseDoc(row.data), version: row.version, updatedAt: row.updated_at };
}

/** 저장 문자열 → 문서. 깨졌거나 비어 있으면 빈 시트로 되돌린다(화면이 죽지 않게). */
export function parseDoc(json: string): SheetDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return emptySheetDoc();
  }
  if (!isDocShape(parsed)) return emptySheetDoc();
  return parsed;
}

function isDocShape(value: unknown): value is SheetDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return typeof doc.engine === "string" && Array.isArray(doc.sheets) && doc.sheets.length > 0;
}

/**
 * 클라이언트가 보낸 `data` 를 검증한다.
 * - 래퍼 형태(`engine`/`sheets`)여야 한다. 엔진 이름이 다르면 거부한다.
 * - 시트마다 이름이 있어야 한다 (탭 표시·수식 참조에 쓰인다).
 * - 직렬화 크기 상한을 넘으면 413.
 */
export function validateSheetDoc(value: unknown): { doc: SheetDoc; json: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("시트 데이터가 올바르지 않습니다.");
  }
  const doc = value as Record<string, unknown>;
  if (doc.engine !== SHEET_ENGINE) {
    throw badRequest("지원하지 않는 시트 엔진입니다.", "unsupported_engine");
  }
  const sheets = doc.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw badRequest("시트가 최소 한 장은 있어야 합니다.");
  }
  if (sheets.length > MAX_SHEETS) {
    throw badRequest(`시트 탭은 최대 ${MAX_SHEETS}개까지 만들 수 있습니다.`);
  }
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) {
      throw badRequest("시트 데이터가 올바르지 않습니다.");
    }
    const name = (sheet as Record<string, unknown>).name;
    if (typeof name !== "string" || name.trim() === "") {
      throw badRequest("시트 이름이 필요합니다.");
    }
  }

  const normalized: SheetDoc = {
    engine: SHEET_ENGINE,
    engineVersion:
      typeof doc.engineVersion === "string" && doc.engineVersion.length <= 20
        ? doc.engineVersion
        : SHEET_ENGINE_VERSION,
    sheets: sheets as SheetDoc["sheets"],
  };
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_SHEET_BYTES) {
    throw payloadTooLarge("시트가 너무 큽니다. 행/열을 줄이거나 나눠 주세요.");
  }
  return { doc: normalized, json };
}
