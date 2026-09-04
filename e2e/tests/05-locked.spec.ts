import { expect, test } from "@playwright/test";
import { ALICE_STATE, adminApi, createSessionWithPage, loadFixtures, waitForExcalidraw } from "./fixtures";

/** 시나리오 7 — 잠긴 세션: 보기 모드로 열리고 저장 시도는 403 */
test("잠긴 세션은 읽기 전용으로 열리고 저장은 403", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "잠긴 세션",
    memberIds: [aliceId],
  });
  const locked = await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } });
  expect(locked.status()).toBe(200);
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();

  // 세션 목록에 자물쇠 표시
  await page.goto("/");
  await expect(
    page.getByTestId("session-card").filter({ hasText: "잠긴 세션" }),
  ).toContainText("🔒");

  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  // 읽기 전용 표시 + 페이지 추가/삭제 버튼 없음
  await expect(page.getByTestId("readonly-pill")).toBeVisible();
  await expect(page.getByTestId("add-page-button")).toHaveCount(0);
  await expect(page.getByTestId("page-delete")).toHaveCount(0);

  // Excalidraw 는 보기 모드 (도구 모음이 뜨지 않는다)
  await expect(page.locator(".App-toolbar")).toHaveCount(0);

  // 사용자가 직접 저장을 시도하면 서버가 403 을 준다.
  const res = await page.request.put(`/api/pages/${pageId}/scene`, {
    data: { elements: [], appState: {} },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe("session_locked");

  await context.close();
});
