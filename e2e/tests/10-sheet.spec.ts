import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
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
  monthJanIncome: { r: 1, c: 9 },
  monthJanExpense: { r: 1, c: 10 },
  monthFebExpense: { r: 2, c: 10 },
};

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
  expect(ws["D204"]?.f).toBe('SUMIF(B2:B201,"수입",D2:D201)');
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
