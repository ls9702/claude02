/**
 * 시트 입력 단계 검사 (1차 방어).
 *
 * 시트에 저장된 데이터 유효성 규칙(`dataVerification`)을 **우리가** 다시 검사한다.
 * Fortune-sheet 도 `prohibitInput: true` 로 같은 일을 하지만, 그때 뜨는 안내창이
 * 영어인 데다 `type2` 가 없으면 "what you entered is not a Number undefined" 처럼
 * 문장이 깨진다. 그래서 규칙만 시트에 남겨 두고(선택 시 뜨는 한국어 힌트는 엔진이 쓴다)
 * 되돌리는 일과 안내 문구는 이 모듈이 맡는다 —
 * `SheetWorkbook` 의 `hooks.beforeUpdateCell` 에서 부른다.
 *
 * 이 방어만으로는 충분하지 않다(붙여넣기·xlsx 가져오기는 이 경로를 타지 않는다).
 * 그래서 장부 템플릿은 계산 단계(숫자 보조 열 H)와 표시 단계(경고 셀 E204)에서
 * 한 번 더 막는다 — `backend/src/sheets/templates.ts` 참고.
 *
 * DOM 을 건드리지 않는 순수 함수라 vitest 로 검증한다.
 */

/** 시트 한 칸에 걸린 데이터 유효성 규칙 (필요한 필드만) */
export interface CellRule {
  type?: unknown;
}

/** 검사 결과 */
export type InputCheck =
  | { kind: "accept" }
  /** 형태만 다를 뿐 뜻이 맞는 입력 — 정규화한 값으로 대신 넣는다 (예: `50,000` → `50000`) */
  | { kind: "replace"; value: number | string }
  /** 받을 수 없는 입력 — 되돌리고 안내한다 */
  | { kind: "reject"; message: string };

export const AMOUNT_REJECT_MESSAGE =
  "금액 칸에는 숫자만 넣을 수 있습니다. 단위·글자 없이 숫자만 입력해 주세요 (예: 30000).";
export const DATE_REJECT_MESSAGE =
  "날짜는 yyyy-MM-dd 형식으로 입력해 주세요 (예: 2026-03-10). 형식이 다르면 월별 요약에서 빠집니다.";

/** 자릿수 쉼표·공백을 뺀 뒤의 숫자 표기 */
const NUMBER_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
/** `2026-3-10` · `2026/3/10` · `2026.3.10` (네 자리 연도만 받는다) */
const DATE_PATTERN = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 실제로 있는 날짜인가 (2026-02-30 같은 값을 거른다) */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** 금액 칸 검사 — 자릿수 쉼표(`50,000`)·앞뒤 공백은 받아서 숫자로 바꿔 준다(엑셀과 같은 동작). */
function checkAmount(input: string, raw: string): InputCheck {
  const compact = input.replace(/[\s,]/g, "");
  if (!NUMBER_PATTERN.test(compact)) return { kind: "reject", message: AMOUNT_REJECT_MESSAGE };
  const value = Number(compact);
  if (!Number.isFinite(value)) return { kind: "reject", message: AMOUNT_REJECT_MESSAGE };
  // 사용자가 친 그대로가 이미 숫자면 엔진에 맡긴다 — 굳이 되돌릴 이유가 없다.
  return String(value) === raw ? { kind: "accept" } : { kind: "replace", value };
}

/** 날짜 칸 검사 — `2026/3/10`·`2026.3.10` 은 받아서 `2026-03-10` 으로 바꿔 준다. */
function checkDate(input: string, raw: string): InputCheck {
  const match = DATE_PATTERN.exec(input);
  if (!match) return { kind: "reject", message: DATE_REJECT_MESSAGE };
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!isRealDate(year, month, day)) return { kind: "reject", message: DATE_REJECT_MESSAGE };
  const canonical = `${year}-${pad2(month)}-${pad2(day)}`;
  return canonical === raw ? { kind: "accept" } : { kind: "replace", value: canonical };
}

/**
 * 한 칸의 입력을 검사한다.
 *
 * - 규칙이 없거나 우리가 다루는 종류(`number`·`date`)가 아니면 그대로 통과시킨다.
 *   (구분 열의 `dropdown` 은 엔진의 목록 UI 로 충분하다.)
 * - **빈 값은 언제나 통과**시킨다 — 그러지 않으면 값을 지울 수 없다.
 * - `=` 로 시작하는 수식도 통과시킨다.
 */
export function checkCellInput(rule: CellRule | null | undefined, value: unknown): InputCheck {
  const type = rule?.type;
  if (type !== "number" && type !== "date") return { kind: "accept" };

  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const input = raw.trim();
  if (input === "") return { kind: "accept" };
  if (input.startsWith("=")) return { kind: "accept" };

  return type === "number" ? checkAmount(input, raw) : checkDate(input, raw);
}
