import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type PlaywrightWorkerArgs,
} from "@playwright/test";
import * as XLSX from "xlsx";
import {
  ALICE_STATE,
  BOB_STATE,
  adminApi,
  cellValue,
  createSessionWithPage,
  expectCellValue,
  loadFixtures,
  selectedCellName,
  typeIntoLedgerCell,
  waitForExcalidraw,
  waitForSheet,
} from "./fixtures";

/** 장부 템플릿의 셀 위치 (0-index) */
const CELL = {
  incomeTotal: { r: 203, c: 3 },
  expenseTotal: { r: 204, c: 3 },
  balance: { r: 205, c: 3 },
  /** 금액 열에 문자가 섞였을 때 뜨는 경고 (합계 블록 옆) */
  amountWarning: { r: 203, c: 4 },
  monthJanIncome: { r: 1, c: 9 },
  monthJanExpense: { r: 1, c: 10 },
  monthFebExpense: { r: 2, c: 10 },
  monthMarIncome: { r: 3, c: 9 },
  monthMarExpense: { r: 3, c: 10 },
  monthAprIncome: { r: 4, c: 9 },
};

/** 장부 시트 하나만 있는 세션을 만들고 Alice 로 연다. */
async function openLedger(
  browser: Browser,
  playwright: PlaywrightWorkerArgs["playwright"],
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId } = await createSessionWithPage(api, {
    name,
    memberIds: [aliceId],
    pageName: "장부",
    pageType: "sheet",
    template: "ledger",
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}`);
  await waitForSheet(page);
  return { context, page };
}

/** 밀린 5초 디바운스 저장을 즉시 비운다 (저장 완료가 안내 문구를 지우는 타이밍을 피한다). */
async function flushSheet(page: Page): Promise<void> {
  await page.evaluate(() => window.__sheetFlush?.());
  await expect
    .poll(async () => page.evaluate(() => window.__sheetSaveStatus), { timeout: 20_000 })
    .toBe("saved");
}

/** 시트 셀을 프로그램으로 채운다 — 붙여넣기·xlsx 가져오기처럼 입력 검사를 우회하는 경로. */
async function setCells(
  page: Page,
  cells: Array<{ r: number; c: number; value: unknown }>,
): Promise<void> {
  await page.evaluate((items) => {
    const api = window.__sheetRef?.current;
    if (!api) throw new Error("시트 API 가 없습니다.");
    for (const item of items) api.setCellValue(item.r, item.c, item.value);
  }, cells);
  await page.evaluate(() => window.__sheetRecalculate?.());
  await page.waitForTimeout(600);
}

/** 시나리오 10 — 회비 장부 시트: 템플릿·수식·실시간 동기화·저장·내보내기 */
test("회비 장부 시트를 만들고 함께 편집한다", async ({ browser, playwright }) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId } = await createSessionWithPage(api, {
    name: "회비 시트 세션",
    memberIds: [aliceId, bobId],
    pageName: "그림판",
  });
  await api.dispose();

  const aliceCtx = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await aliceCtx.newPage();
  await alice.goto(`/s/${sessionId}`);

  // ---- 페이지 추가 다이얼로그에서 "회비 장부" 템플릿을 고른다 ----
  await alice.getByTestId("add-page-button").click();
  await expect(alice.getByTestId("new-page-dialog")).toBeVisible();
  await alice.getByTestId("new-page-name").fill("2026 회비 장부");
  await alice.getByTestId("new-page-type-sheet").check();
  await expect(alice.getByTestId("new-page-template")).toBeVisible();
  await alice.getByTestId("new-page-template-ledger").check();
  await alice.getByTestId("new-page-submit").click();

  await waitForSheet(alice);
  const sheetUrl = alice.url();

  // ---- 샘플 데이터의 합계·잔액이 곧바로 계산되어 보인다 ----
  await expectCellValue(alice, CELL.incomeTotal.r, CELL.incomeTotal.c, 50000);
  await expectCellValue(alice, CELL.expenseTotal.r, CELL.expenseTotal.c, 45000);
  await expectCellValue(alice, CELL.balance.r, CELL.balance.c, 5000);
  // 월별 요약(같은 시트 I~L 블록)도 계산된다.
  await expectCellValue(alice, CELL.monthJanIncome.r, CELL.monthJanIncome.c, 50000);
  await expectCellValue(alice, CELL.monthJanExpense.r, CELL.monthJanExpense.c, 45000);
  // 금액은 원화 숫자 형식으로 보인다.
  expect((await cellValue(alice, 1, 3))?.m).toBe("30,000");

  // ---- Bob 이 같은 시트를 연다 (접속자 표시) ----
  const bobCtx = await browser.newContext({ storageState: BOB_STATE });
  const bob = await bobCtx.newPage();
  await bob.goto(sheetUrl);
  await waitForSheet(bob);
  await expect(alice.getByTestId("collab-count")).toHaveText("접속 2명", { timeout: 30_000 });

  // ---- Alice 가 5행에 지출을 직접 입력한다 (실제 클릭 + 타이핑) ----
  await typeIntoLedgerCell(alice, 4, 0, "2026-02-03");
  expect(await selectedCellName(alice)).toMatch(/^A/);
  // 구분 열은 드롭다운(데이터 유효성)이라 더블클릭으로 편집 모드에 들어간다.
  await typeIntoLedgerCell(alice, 4, 1, "지출", { doubleClick: true });
  await typeIntoLedgerCell(alice, 4, 3, "12000");

  // 지출 합계·잔액이 다시 계산된다.
  await expectCellValue(alice, CELL.expenseTotal.r, CELL.expenseTotal.c, 57000);
  await expectCellValue(alice, CELL.balance.r, CELL.balance.c, -7000);
  // 월 보조 열(=LEFT(A5,7))이 채워져 2월 지출로 잡힌다.
  await expectCellValue(alice, CELL.monthFebExpense.r, CELL.monthFebExpense.c, 12000);

  // ---- Bob 화면에도 WebSocket 으로 같은 값이 보인다 ----
  await expectCellValue(bob, 4, 3, 12000, 30_000);
  await expectCellValue(bob, CELL.balance.r, CELL.balance.c, -7000, 30_000);

  // ---- 저장 후 새로고침해도 유지된다 ----
  await alice.evaluate(() => window.__sheetFlush?.());
  await expect
    .poll(async () => alice.evaluate(() => window.__sheetSaveStatus), { timeout: 20_000 })
    .toBe("saved");

  await alice.reload();
  await waitForSheet(alice);
  await expectCellValue(alice, 4, 3, 12000);
  await expectCellValue(alice, CELL.balance.r, CELL.balance.c, -7000);

  // ---- xlsx 내보내기: 내려받은 파일을 SheetJS 로 읽어 값·수식을 확인한다 ----
  const [download] = await Promise.all([
    alice.waitForEvent("download"),
    alice.getByTestId("sheet-export-xlsx").click(),
  ]);
  // 파일명은 앵커의 `download` 속성("2026 회비 장부.xlsx")으로 정해지지만,
  // 헤드리스 Chromium 은 CDP 로 알려 주는 suggestedFilename 에서 한글을 떨어뜨린다.
  // 그래서 이름 대신 **내용**을 검증한다.
  const path = await download.path();
  const workbook = XLSX.read(readFileSync(path), { type: "buffer", cellFormula: true });
  expect(workbook.SheetNames).toContain("장부");
  const ws = workbook.Sheets["장부"]!;
  expect(ws["D2"]?.v).toBe(30000);
  expect(ws["D5"]?.v).toBe(12000);
  expect(ws["B5"]?.v).toBe("지출");
  // 합계는 금액 열이 아니라 숫자 보조 열(H)을 더한다 — 문자 오염 방지(회귀).
  expect(ws["D204"]?.f).toBe('SUMIF(B2:B201,"수입",H2:H201)');
  expect(ws["H5"]?.f).toBe("IF(ISNUMBER(D5),D5,0)");
  expect(ws["D206"]?.f).toBe("D204-D205");
  expect(ws["D206"]?.v).toBe(-7000);

  // ---- CSV 내보내기 (현재 시트) ----
  const [csvDownload] = await Promise.all([
    alice.waitForEvent("download"),
    alice.getByTestId("sheet-export-csv").click(),
  ]);
  const csv = readFileSync(await csvDownload.path(), "utf8");
  expect(csv).toContain("날짜");
  expect(csv).toContain("2026-02-03");
  expect(csv).toContain("12000");

  await bobCtx.close();
  await aliceCtx.close();
});

/** 잠긴 세션의 시트는 읽기 전용이다 */
test("잠긴 세션의 시트는 읽기 전용으로 열린다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId } = await createSessionWithPage(api, {
    name: "잠긴 시트 세션",
    memberIds: [aliceId],
    pageName: "장부",
    pageType: "sheet",
    template: "ledger",
  });
  const locked = await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } });
  expect(locked.status()).toBe(200);
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}`);
  await waitForSheet(page);

  await expect(page.getByTestId("sheet-readonly")).toBeVisible();
  // 가져오기 버튼은 읽기 전용에서 감춘다. 내보내기는 가능하다.
  await expect(page.getByTestId("sheet-import-xlsx")).toHaveCount(0);
  await expect(page.getByTestId("sheet-export-xlsx")).toBeVisible();
  // 값은 그대로 계산되어 보인다.
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 5000);

  await context.close();
});

/** 코드 스플리팅 — 그림판만 여는 경로에는 Fortune-sheet 청크가 실리지 않는다 */
test("캔버스만 있는 세션은 fortune-sheet 번들을 받지 않는다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const canvasOnly = await createSessionWithPage(api, {
    name: "그림판만 있는 세션",
    memberIds: [aliceId],
    pageName: "그림판",
  });
  const withSheet = await createSessionWithPage(api, {
    name: "시트가 있는 세션",
    memberIds: [aliceId],
    pageName: "장부",
    pageType: "sheet",
    template: "ledger",
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();

  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const isSheetBundle = (url: string) => /fortune-sheet|SheetWorkbook|\/xlsx/i.test(url);

  await page.goto(`/s/${canvasOnly.sessionId}`);
  await waitForExcalidraw(page);
  await expect(page.getByTestId("canvas-wrapper")).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(requested.filter(isSheetBundle)).toEqual([]);

  // 시트 페이지를 열면 그때 청크를 받는다 (지연 로딩이 실제로 동작한다는 확인).
  await page.goto(`/s/${withSheet.sessionId}`);
  await waitForSheet(page);
  expect(requested.filter(isSheetBundle).length).toBeGreaterThan(0);

  await context.close();
});

/**
 * 회귀 — 검증 리포트 Finding 1 (치명).
 *
 * 금액 칸에 글자가 들어가면 이 엔진의 SUMIF 는 조건을 무시하고 범위를 문자열로
 * 이어붙여, 잔액이 **에러 표시 없이** 그럴듯한 틀린 숫자가 됐다.
 * 방어 3겹(입력 되돌림 · 숫자 보조 열 · 경고 셀)을 모두 확인한다.
 */
test("금액 칸의 글자는 되돌려지고, 우회해 들어온 글자도 합계를 망치지 않는다", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await openLedger(browser, playwright, "금액 검사 세션");

  // 처음에는 경고가 없다.
  await expectCellValue(page, CELL.incomeTotal.r, CELL.incomeTotal.c, 50000);
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 5000);
  expect((await cellValue(page, CELL.amountWarning.r, CELL.amountWarning.c))?.v ?? "").toBe("");

  // ---- 1차 방어: 직접 타이핑한 글자는 되돌리고 한국어로 안내한다 ----
  await typeIntoLedgerCell(page, 4, 3, "오만원", { doubleClick: true });
  // 값은 들어가지 않았고 합계·잔액도 그대로다.
  expect((await cellValue(page, 4, 3))?.v ?? null).toBeNull();
  await expect(page.getByTestId("sheet-notice")).toContainText("숫자만");
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 5000);

  // 자릿수 쉼표는 받아 준다 (엑셀과 같은 동작).
  await typeIntoLedgerCell(page, 4, 1, "수입", { doubleClick: true });
  await typeIntoLedgerCell(page, 4, 3, "50,000", { doubleClick: true });
  await expectCellValue(page, 4, 3, 50000);
  await expectCellValue(page, CELL.incomeTotal.r, CELL.incomeTotal.c, 100000);
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 55000);

  // ---- 2·3차 방어: 붙여넣기·가져오기처럼 입력 검사를 우회한 글자 ----
  await setCells(page, [
    { r: 5, c: 0, value: "2026-02-20" },
    { r: 5, c: 1, value: "수입" },
    { r: 5, c: 2, value: "회비" },
    { r: 5, c: 3, value: "오만원" },
  ]);

  // 합계는 글자를 0 으로 보고 계속 **숫자**로 맞는다 (예전에는 문자열이 됐다).
  await expectCellValue(page, CELL.incomeTotal.r, CELL.incomeTotal.c, 100000);
  await expectCellValue(page, CELL.expenseTotal.r, CELL.expenseTotal.c, 45000);
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 55000);
  // 월별 요약도 #VALUE! 가 아니라 숫자다.
  await expectCellValue(page, CELL.monthFebExpense.r, CELL.monthFebExpense.c, 0);
  // 그리고 사용자에게 알린다.
  const warning = await cellValue(page, CELL.amountWarning.r, CELL.amountWarning.c);
  expect(String(warning?.v)).toContain("금액 열에 숫자가 아닌 값이 있습니다");

  // 글자를 숫자로 고치면 경고가 사라지고 합계에 들어간다.
  await setCells(page, [{ r: 5, c: 3, value: 50000 }]);
  await expectCellValue(page, CELL.incomeTotal.r, CELL.incomeTotal.c, 150000);
  await expect
    .poll(async () => (await cellValue(page, CELL.amountWarning.r, CELL.amountWarning.c))?.v ?? "")
    .toBe("");

  await context.close();
});

/**
 * 회귀 — 검증 리포트 Finding 2 (중간).
 * `2026/03/10` 처럼 흔히 쓰는 날짜 표기가 전체 합계에는 잡히면서 월별 요약에서만
 * 조용히 빠졌다. 이제 입력 단계에서 `yyyy-MM-dd` 로 바뀌고, 우회해 들어온 표기도
 * 월 보조 열이 흡수한다.
 */
test("슬래시·점 날짜도 월별 요약에 제대로 잡힌다", async ({ browser, playwright }) => {
  const { context, page } = await openLedger(browser, playwright, "날짜 형식 세션");

  // ---- 1차 방어: 입력한 표기를 yyyy-MM-dd 로 바꿔 넣는다 ----
  await typeIntoLedgerCell(page, 4, 0, "2026/03/10");
  await expectCellValue(page, 4, 0, "2026-03-10");
  await typeIntoLedgerCell(page, 4, 1, "지출", { doubleClick: true });
  await typeIntoLedgerCell(page, 4, 3, "5000");
  await expectCellValue(page, CELL.monthMarExpense.r, CELL.monthMarExpense.c, 5000);

  // 아예 날짜가 아니면 되돌리고 안내한다.
  // (밀린 저장을 먼저 비운다 — 저장이 끝나면서 안내가 지워지는 타이밍을 피한다.)
  await flushSheet(page);
  // 더블클릭으로 편집 모드에 확실히 들어간 뒤 친다 — 한 번 클릭 후 곧바로 타이핑하면
  // 화면이 바쁠 때 첫 글자가 편집기에 들어가지 않고 흘려질 수 있다.
  await typeIntoLedgerCell(page, 5, 0, "3/10", { doubleClick: true });
  expect((await cellValue(page, 5, 0))?.v ?? null).toBeNull();
  await expect(page.getByTestId("sheet-notice")).toContainText("yyyy-MM-dd");

  // ---- 2차 방어: 붙여넣기로 들어온 `2026.04.02` 도 월 보조 열이 흡수한다 ----
  await setCells(page, [
    { r: 6, c: 0, value: "2026.04.02" },
    { r: 6, c: 1, value: "수입" },
    { r: 6, c: 3, value: 2000 },
  ]);
  await expectCellValue(page, 6, 6, "2026-04");
  await expectCellValue(page, CELL.monthAprIncome.r, CELL.monthAprIncome.c, 2000);

  // 날짜 머리글이 형식을 알려 준다.
  expect((await cellValue(page, 0, 0))?.v).toBe("날짜(yyyy-MM-dd)");

  await context.close();
});

/**
 * 회귀 — 검증 리포트 Finding 4.
 * 확장자만 `.xlsx` 인 텍스트 파일을 SheetJS 가 CSV 로 관대하게 읽어, 확인창만 거치면
 * 장부가 알아보기 힘든 내용으로 조용히 덮어써졌다.
 */
test("xlsx 가 아닌 파일을 가져오면 거부하고 시트를 지킨다", async ({ browser, playwright }) => {
  const { context, page } = await openLedger(browser, playwright, "가짜 xlsx 세션");
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 5000);

  // 확인창이 뜨면 테스트가 멈추지 않도록 무조건 거절한다 — 애초에 뜨면 안 된다.
  let confirmed = false;
  page.on("dialog", (dialog) => {
    confirmed = true;
    void dialog.dismiss();
  });

  await page.getByTestId("sheet-import-input").setInputFiles({
    name: "가짜.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("날짜,구분,금액\n이건 진짜 xlsx 가 아닙니다,수입,12345\n", "utf8"),
  });

  await expect(page.getByTestId("sheet-notice")).toContainText("올바른 xlsx 파일이 아닙니다");
  expect(confirmed).toBe(false);
  // 장부 내용은 그대로다.
  await expectCellValue(page, 1, 3, 30000);
  await expectCellValue(page, CELL.balance.r, CELL.balance.c, 5000);

  await context.close();
});
