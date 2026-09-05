import { expect, test } from "@playwright/test";
import { ALICE_STATE, adminApi, createSessionWithPage, loadFixtures, waitForSheet } from "./fixtures";

/** 시나리오 4 — 페이지 생성/이름 변경/전환/순서 변경 + 시트 페이지 */
test("페이지 CRUD·전환·순서 변경과 시트 페이지", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId } = await createSessionWithPage(api, {
    name: "페이지 테스트 세션",
    memberIds: [aliceId],
    pageName: "첫 페이지",
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}`);

  await expect(page.getByTestId("session-name")).toContainText("페이지 테스트 세션");
  await expect(page.getByTestId("page-tab")).toHaveCount(1);

  // 캔버스 페이지 1개 추가 (총 캔버스 2개)
  await page.getByTestId("add-page-button").click();
  await expect(page.getByTestId("new-page-dialog")).toBeVisible();
  await page.getByTestId("new-page-name").fill("두 번째 그림판");
  await page.getByTestId("new-page-type-canvas").check();
  await page.getByTestId("new-page-submit").click();
  await expect(page.getByTestId("page-tab")).toHaveCount(2);

  // 시트 페이지 1개 추가 (빈 시트 템플릿)
  await page.getByTestId("add-page-button").click();
  await page.getByTestId("new-page-name").fill("회비 장부");
  await page.getByTestId("new-page-type-sheet").check();
  await page.getByTestId("new-page-template-blank").check();
  await page.getByTestId("new-page-submit").click();
  await expect(page.getByTestId("page-tab")).toHaveCount(3);

  // 시트 페이지로 이동하면 Fortune-sheet 워크북이 열린다
  await waitForSheet(page);
  await expect(page.getByTestId("sheet-export-xlsx")).toBeVisible();

  // 탭 타입 아이콘 확인
  const tabs = page.getByTestId("page-tab");
  await expect(tabs.nth(0)).toHaveAttribute("data-page-type", "canvas");
  await expect(tabs.nth(2)).toHaveAttribute("data-page-type", "sheet");
  await expect(tabs.nth(2)).toContainText("📊");

  // 이름 더블클릭 → 수정
  await tabs.nth(0).getByTestId("page-tab-button").dblclick();
  const input = page.getByTestId("page-tab-input");
  await expect(input).toBeVisible();
  await input.fill("이름 바뀐 페이지");
  await input.press("Enter");
  await expect(page.getByTestId("page-tab").nth(0)).toContainText("이름 바뀐 페이지");

  // 페이지 전환 (시트 → 첫 캔버스)
  await page.getByTestId("page-tab").nth(0).getByTestId("page-tab-button").click();
  await expect(page.getByTestId("canvas-wrapper")).toBeVisible();
  await expect(page.getByTestId("sheet-wrapper")).toHaveCount(0);

  // 순서 변경 (◀ 버튼으로 시트를 한 칸 앞으로)
  const namesBefore = await page.getByTestId("page-tab").allInnerTexts();
  await page.getByTestId("page-tab").nth(2).getByTestId("page-move-left").click();
  await expect
    .poll(async () => (await page.getByTestId("page-tab").allInnerTexts())[1])
    .toContain("회비 장부");
  expect(namesBefore[2]).toContain("회비 장부");

  // 새로고침해도 순서가 유지된다 (서버에 저장됨)
  await page.reload();
  await expect
    .poll(async () => (await page.getByTestId("page-tab").allInnerTexts())[1])
    .toContain("회비 장부");

  // 페이지 삭제
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId("page-tab").nth(1).getByTestId("page-delete").click();
  await expect(page.getByTestId("page-tab")).toHaveCount(2);

  await context.close();
});
