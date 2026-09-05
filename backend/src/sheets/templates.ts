/**
 * 시트 페이지 초기 데이터(템플릿) 생성 — 서버에서 만든다.
 *
 * 저장 포맷은 **우리 래퍼 스키마**다:
 *   `{ engine: "fortune-sheet", engineVersion: "1.0.4", sheets: <Fortune-sheet Sheet[]> }`
 * 엔진을 갈아 끼울 때 저장본을 식별·변환할 수 있게 한 겹 감싼다(PLAN §2.7 리스크 항목).
 *
 * ⚠️ Fortune-sheet 1.0.4 수식 엔진에서 실측으로 확인한 제약 (m5 조사 결과)
 * 1. 저장된 수식은 **불러오는 것만으로는 계산되지 않는다**. 클라이언트가 마운트 후
 *    `calculateFormula(현재 시트 id)` 를 한 번 불러야 값이 채워진다.
 *    (`forceCalculation` 설정값은 defaultSettings 에만 있고 실제로 쓰이지 않는다.)
 * 2. **시트 간 참조는 시트 이름이 ASCII 일 때만** 동작한다. 수식 파서(jison)의
 *    VARIABLE 토큰이 `[A-Za-z_][A-Za-z_0-9]*` 라서 `장부!D2:D201` 은 토큰화 자체가
 *    실패해 `#ERROR!` 가 된다(`'장부'!D2` 는 문자열로 잘못 파싱되어 엉뚱한 값이 나온다).
 *    → 한글 시트 이름을 유지하기 위해 **월별 요약을 같은 시트의 오른쪽 블록(I:L)** 으로
 *      옮겼다. 시트 간 참조가 없으므로 항상 올바르게 계산된다.
 * 3. `TEXT(날짜,"yyyy-mm")` 는 `#ERROR!` 다(텍스트 날짜·직렬값 모두). 대신 날짜를
 *    `yyyy-MM-dd` **텍스트**로 저장하고 `LEFT(A2,7)` 로 월(`yyyy-MM`)을 뽑는다.
 * 4. SUMIF/SUMIFS/COUNTIF/IF/LEFT 는 같은 시트 안에서 정상 동작한다.
 * 5. **합계 범위에 문자가 하나라도 섞이면 SUMIF/SUMIFS 가 조용히 깨진다.** 숫자를 더하다가
 *    문자 셀을 만나는 순간 조건을 무시하고 범위 전체를 문자열로 이어붙인다
 *    (`"50000오만원01000002000"`). 그 값이 잔액 수식에 들어가면 앞부분 숫자만 잘려
 *    **에러 표시 없이 그럴듯한 틀린 잔액**이 된다. → 금액을 그대로 더하지 않고
 *    **숫자 보조 열 H(`=IF(ISNUMBER(D2),D2,0)`)** 를 거쳐 더한다.
 * 6. **배열 연산은 지원하지 않는다.** `SUMPRODUCT((B2:B201="수입")*ISNUMBER(D2:D201)*D2:D201)`
 *    은 `#VALUE!` 다(`SUMPRODUCT(D2:D201)` 같은 단일 범위도 마찬가지). 반면 인수를 쉼표로
 *    나눈 `SUMPRODUCT(H2:H201,H2:H201)` 은 동작한다. → 문자 혼입 감지는 배열식 대신
 *    `COUNTA(D2:D201)-COUNT(D2:D201)` 로 센다.
 * 7. `ISNUMBER`·`COUNT`·`COUNTA`·`SUBSTITUTE` 는 정상 동작한다(실측).
 */

export const SHEET_ENGINE = "fortune-sheet";
export const SHEET_ENGINE_VERSION = "1.0.4";

export type SheetTemplate = "blank" | "ledger";

/** Fortune-sheet 셀 (필요한 필드만) */
export interface TemplateCell {
  v?: string | number | boolean;
  m?: string;
  f?: string;
  ct?: { fa: string; t: string };
  bl?: number;
  bg?: string;
  fc?: string;
  ht?: number;
  /** 텍스트 넘침 처리 — 엔진이 **문자열**로 비교한다: "0" 잘라내기 / "1" 넘치게 두기 / "2" 줄바꿈 */
  tb?: string;
}

export interface TemplateCellData {
  r: number;
  c: number;
  v: TemplateCell;
}

export interface TemplateSheet {
  name: string;
  id: string;
  order: number;
  status?: number;
  row: number;
  column: number;
  celldata: TemplateCellData[];
  config?: Record<string, unknown>;
  dataVerification?: Record<string, unknown>;
  luckysheet_conditionformat_save?: unknown[];
  frozen?: { type: string; range?: { row_focus: number; column_focus: number } };
}

export interface SheetDoc {
  engine: string;
  engineVersion: string;
  sheets: TemplateSheet[];
}

/** 장부 데이터 행: 2행 ~ 201행 (0-index r=1..200) */
export const LEDGER_FIRST_ROW = 1;
export const LEDGER_LAST_ROW = 200;
/** 합계 블록: 204~206행 (0-index 203..205) */
export const LEDGER_SUMMARY_ROW = 203;
/** 금액 열(D) 0-index */
export const LEDGER_AMOUNT_COL = 3;
/** 날짜 열(A) 0-index */
export const LEDGER_DATE_COL = 0;
/** 월 보조 열(G) / 금액 보조 열(H) 0-index */
export const LEDGER_MONTH_HELPER_COL = 6;
export const LEDGER_AMOUNT_HELPER_COL = 7;

/** 날짜 열에 기대하는 형식 — 머리글·안내·유효성 검사가 모두 이 값을 쓴다. */
export const LEDGER_DATE_FORMAT = "yyyy-MM-dd";

const HEADER_BG = "#eef1f6";
/** 보조 열(G·H) 글자색 — 사용자가 직접 고칠 칸이 아니라는 표시 */
const HELPER_FC = "#8a93a0";
/** 금액 열에 숫자가 아닌 값이 섞였을 때 E204 에 뜨는 경고 */
export const AMOUNT_WARNING_TEXT = "⚠ 금액 열에 숫자가 아닌 값이 있습니다 — 합계에서 빠집니다";
const MONEY_FORMAT = { fa: "#,##0", t: "n" } as const;
const TEXT_FORMAT = { fa: "@", t: "s" } as const;

const text = (value: string, extra: Partial<TemplateCell> = {}): TemplateCell => ({
  v: value,
  m: value,
  ct: { ...TEXT_FORMAT },
  ...extra,
});

const header = (value: string): TemplateCell => ({
  v: value,
  m: value,
  bl: 1,
  bg: HEADER_BG,
  ht: 0,
});

const money = (value: number, extra: Partial<TemplateCell> = {}): TemplateCell => ({
  v: value,
  m: new Intl.NumberFormat("ko-KR").format(value),
  ct: { ...MONEY_FORMAT },
  ...extra,
});

const formula = (f: string, extra: Partial<TemplateCell> = {}): TemplateCell => ({ f, ...extra });

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 빈 시트 한 장 */
function blankSheets(): TemplateSheet[] {
  return [
    {
      name: "시트1",
      id: "sheet1",
      order: 0,
      status: 1,
      row: 100,
      column: 26,
      celldata: [],
      config: {},
    },
  ];
}

/**
 * 회비 장부.
 *
 * A 날짜 | B 구분 | C 항목 | D 금액 | E 담당 | F 메모 | G 월(자동) | H 금액(숫자)  …  I~L 월별 요약
 * 204~206행: 수입 합계 / 지출 합계 / 현재 잔액, E204 에 "금액에 문자 섞임" 경고
 *
 * 금액이 틀리지 않게 하는 방어는 3겹이다(m5 수정 라운드 1).
 *  1) 입력 단계 — D2:D201 에 숫자 데이터 유효성, A2:A201 에 날짜 데이터 유효성.
 *  2) 계산 단계 — 유효성을 우회한 값(붙여넣기·가져오기)이 있어도 합계가 깨지지 않도록
 *     **숫자 보조 열 H** 를 거쳐 더한다. 문자는 0 으로 떨어진다.
 *  3) 표시 단계 — 그래도 문자가 남아 있으면 E204 경고 셀이 사용자에게 알린다.
 */
function ledgerSheets(year: number): TemplateSheet[] {
  const cells: TemplateCellData[] = [];
  const put = (r: number, c: number, v: TemplateCell) => cells.push({ r, c, v });

  // ---- 머리글 -----------------------------------------------------------
  // 날짜 머리글에 형식을 적어 둔다 — 형식이 다르면 월별 요약에서 조용히 빠지기 때문이다.
  [`날짜(${LEDGER_DATE_FORMAT})`, "구분", "항목", "금액", "담당", "메모", "월(자동)", "금액(숫자)"].forEach(
    (label, c) => {
      put(0, c, header(label));
    },
  );
  ["월", "수입", "지출", "잔액"].forEach((label, i) => {
    put(0, 8 + i, header(label));
  });

  // ---- 샘플 3행 (잔액이 곧바로 보이도록) ---------------------------------
  const samples: Array<[string, string, string, number, string, string]> = [
    [`${year}-01-05`, "수입", "입회비(홍길동)", 30000, "홍길동", ""],
    [`${year}-01-12`, "수입", "입회비(김영희)", 20000, "김영희", ""],
    [`${year}-01-20`, "지출", "1월 정기 회식", 45000, "홍길동", "○○식당 결제"],
  ];
  const sampleDate = `${year}-03-10`;
  samples.forEach((row, index) => {
    const r = LEDGER_FIRST_ROW + index;
    put(r, 0, text(row[0]));
    put(r, 1, text(row[1]));
    put(r, 2, text(row[2]));
    put(r, 3, money(row[3]));
    put(r, 4, text(row[4]));
    if (row[5]) put(r, 5, text(row[5]));
  });

  // ---- 데이터 행 서식 + 보조 열 -----------------------------------------
  // 금액 열은 빈 칸도 원화 숫자 형식을 미리 잡아 둔다.
  // 월 보조 열(G)은 날짜 텍스트에서 `yyyy-MM` 을 뽑는다 (TEXT() 는 이 엔진에서 #ERROR!).
  //   `2026/03/10`·`2026.03.10` 처럼 흔히 쓰는 표기도 SUBSTITUTE 로 `-` 로 바꿔 흡수한다.
  //   (그냥 LEFT 만 쓰면 `2026/03` 이 되어 월별 요약에서 조용히 빠졌다.)
  // 금액 보조 열(H)은 문자 금액을 0 으로 떨어뜨린다 — SUMIF/SUMIFS 는 이 열만 더한다.
  for (let r = LEDGER_FIRST_ROW; r <= LEDGER_LAST_ROW; r += 1) {
    const rowNo = r + 1;
    if (!samples[r - LEDGER_FIRST_ROW]) {
      // 날짜 열은 **텍스트 서식**으로 고정한다 — 그래야 사용자가 친 날짜가 직렬값(45000 같은 수)이
      // 아니라 `2026-02-03` 문자열로 남고 `LEFT(A2,7)` 로 월을 뽑을 수 있다.
      put(r, LEDGER_DATE_COL, { ct: { ...TEXT_FORMAT } });
      put(r, LEDGER_AMOUNT_COL, { ct: { ...MONEY_FORMAT } });
    }
    put(
      r,
      LEDGER_MONTH_HELPER_COL,
      formula(`=IF(A${rowNo}="","",LEFT(SUBSTITUTE(SUBSTITUTE(A${rowNo},"/","-"),".","-"),7))`, {
        fc: HELPER_FC,
      }),
    );
    put(
      r,
      LEDGER_AMOUNT_HELPER_COL,
      formula(`=IF(ISNUMBER(D${rowNo}),D${rowNo},0)`, {
        ct: { ...MONEY_FORMAT },
        fc: HELPER_FC,
      }),
    );
  }

  // ---- 합계 (204~206행) --------------------------------------------------
  const first = LEDGER_FIRST_ROW + 1; // 스프레드시트 행 번호 (2)
  const last = LEDGER_LAST_ROW + 1; // 201
  const range = (col: string) => `${col}${first}:${col}${last}`;
  // 합계는 금액 열(D)이 아니라 **숫자 보조 열(H)** 을 더한다 — D 에 문자가 섞이면
  // SUMIF 가 조건을 무시하고 문자열을 이어붙여 잔액이 조용히 틀어지기 때문이다.
  put(LEDGER_SUMMARY_ROW, 2, { v: "수입 합계", m: "수입 합계", bl: 1 });
  put(
    LEDGER_SUMMARY_ROW,
    3,
    formula(`=SUMIF(${range("B")},"수입",${range("H")})`, { ct: { ...MONEY_FORMAT } }),
  );
  put(LEDGER_SUMMARY_ROW + 1, 2, { v: "지출 합계", m: "지출 합계", bl: 1 });
  put(
    LEDGER_SUMMARY_ROW + 1,
    3,
    formula(`=SUMIF(${range("B")},"지출",${range("H")})`, { ct: { ...MONEY_FORMAT } }),
  );
  put(LEDGER_SUMMARY_ROW + 2, 2, { v: "현재 잔액", m: "현재 잔액", bl: 1 });
  put(
    LEDGER_SUMMARY_ROW + 2,
    3,
    formula(`=D${LEDGER_SUMMARY_ROW + 1}-D${LEDGER_SUMMARY_ROW + 2}`, {
      ct: { ...MONEY_FORMAT },
      bl: 1,
    }),
  );

  // ---- 경고 셀 (E204) ----------------------------------------------------
  // 3차 방어: 유효성 검사를 우회한 문자 금액이 남아 있으면 합계 옆에서 알린다.
  // 배열식(SUMPRODUCT(--NOT(ISNUMBER(...))))은 이 엔진에서 #VALUE! 라
  // `COUNTA - COUNT`(비어 있지 않은 칸 수 − 숫자 칸 수)로 센다.
  put(
    LEDGER_SUMMARY_ROW,
    4,
    formula(
      `=IF(COUNTA(${range("D")})-COUNT(${range("D")})>0,"${AMOUNT_WARNING_TEXT}","")`,
      // `tb: "1"`(넘치게 두기)이 없으면 E 열 너비(90px)에서 잘려 "⚠ 금액 열에 숫" 까지만 보인다.
      // 엔진이 `cell.tb === "1"` 로 **문자열 비교**를 하므로 숫자 1 은 듣지 않는다.
      { fc: "#c0392b", bl: 1, tb: "1" },
    ),
  );

  // ---- 월별 요약 (I~L, 1~12월) -------------------------------------------
  // 시트 간 참조가 불가능해 같은 시트에 둔다. 월 보조 열(G)·금액 보조 열(H)과 SUMIFS 로 집계한다.
  for (let month = 1; month <= 12; month += 1) {
    const r = month; // 2행부터
    const rowNo = r + 1;
    put(r, 8, text(`${year}-${pad2(month)}`));
    const sumifs = (kind: string) =>
      `=SUMIFS($H$${first}:$H$${last},$B$${first}:$B$${last},"${kind}",$G$${first}:$G$${last},$I${rowNo})`;
    put(r, 9, formula(sumifs("수입"), { ct: { ...MONEY_FORMAT } }));
    put(r, 10, formula(sumifs("지출"), { ct: { ...MONEY_FORMAT } }));
    put(r, 11, formula(`=J${rowNo}-K${rowNo}`, { ct: { ...MONEY_FORMAT } }));
  }

  // ---- 데이터 유효성 검사 -------------------------------------------------
  // 구분 열(B): 수입/지출 드롭다운.
  // 날짜 열(A): 날짜만 — 형식이 다르면 월별 요약에서 조용히 빠진다.
  // 금액 열(D): 숫자만 — 문자가 섞이면 합계가 조용히 틀어진다(이 파일 위 제약 5).
  //
  // ⚠️ `prohibitInput` 은 **끈다**. 켜면 엔진이 잘못된 입력을 실제로 되돌려 주기는 하지만
  //    (실측 확인) 그때 뜨는 안내창이 영어이고, `type2` 가 없으면
  //    "what you entered is not a Number undefined" 처럼 깨진 문장이 나온다.
  //    그래서 **되돌리는 일은 프런트의 `hooks.beforeUpdateCell` 이 한국어 안내와 함께**
  //    처리하고(`frontend/src/sheet/SheetWorkbook.tsx`), 여기서는 규칙(type)과
  //    선택 시 뜨는 한국어 안내(`hintValue`)만 남긴다.
  const dataVerification: Record<string, unknown> = {};
  const verification = (extra: Record<string, unknown>) => ({
    type2: null,
    value1: "",
    value2: "",
    validity: "",
    remote: false,
    prohibitInput: false,
    hintShow: false,
    hintValue: "",
    checked: false,
    ...extra,
  });
  for (let r = LEDGER_FIRST_ROW; r <= LEDGER_LAST_ROW; r += 1) {
    dataVerification[`${r}_${LEDGER_DATE_COL}`] = verification({
      type: "date",
      hintShow: true,
      hintValue: `날짜는 ${LEDGER_DATE_FORMAT} 형식으로 입력하세요 (예: ${sampleDate})`,
    });
    dataVerification[`${r}_1`] = verification({
      type: "dropdown",
      value1: "수입,지출",
      hintShow: true,
      hintValue: "구분은 수입 또는 지출 중에서 고르세요",
    });
    dataVerification[`${r}_${LEDGER_AMOUNT_COL}`] = verification({
      type: "number",
      hintShow: true,
      hintValue: "금액은 숫자만 입력하세요 (예: 30000). 쉼표·단위는 빼 주세요",
    });
  }

  return [
    {
      name: "장부",
      id: "ledger",
      order: 0,
      status: 1,
      row: 210,
      column: 14,
      celldata: cells,
      config: {
        columnlen: {
          0: 130,
          1: 70,
          2: 190,
          3: 110,
          4: 90,
          5: 200,
          6: 90,
          7: 90,
          8: 90,
          9: 100,
          10: 100,
          11: 100,
        },
        rowlen: { 0: 24 },
      },
      dataVerification,
      // 지출 표시 — 조건부 서식.
      // ⚠️ `conditionName: "formula"` (예: `=$B2="지출"`) 은 이 버전에서 렌더 중 실행되며
      //    얼어 있는 context 에 쓰려다 예외("Cannot assign to read only property
      //    'calculateSheetId'")로 시트 전체가 죽는다 — 그래서 쓸 수 없다.
      //    값 비교 규칙(textContains)은 안전하므로 "구분" 열만 연한 빨강으로 칠한다.
      luckysheet_conditionformat_save: [
        {
          type: "default",
          cellrange: [{ row: [LEDGER_FIRST_ROW, LEDGER_LAST_ROW], column: [1, 1] }],
          format: { textColor: "#c0392b", cellColor: "#fdeceb" },
          conditionName: "textContains",
          conditionValue: ["지출"],
          conditionRange: [],
        },
      ],
      frozen: { type: "row", range: { row_focus: 0, column_focus: 0 } },
    },
  ];
}

/** 템플릿 이름 검증 */
export function isSheetTemplate(value: unknown): value is SheetTemplate {
  return value === "blank" || value === "ledger";
}

/** 페이지 생성 시 저장할 초기 문서 */
export function buildSheetDoc(template: SheetTemplate, now: Date = new Date()): SheetDoc {
  return {
    engine: SHEET_ENGINE,
    engineVersion: SHEET_ENGINE_VERSION,
    sheets: template === "ledger" ? ledgerSheets(now.getFullYear()) : blankSheets(),
  };
}

/** 저장된 JSON 을 읽을 때 쓰는 기본값 (M1 에 만들어진 빈 `{}` 행 대비) */
export function emptySheetDoc(): SheetDoc {
  return buildSheetDoc("blank");
}
