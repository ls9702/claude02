import { expect, test } from "@playwright/test";
import {
  ADMIN_STATE,
  ALICE_STATE,
  addRectangle,
  adminApi,
  createSessionWithPage,
  expectElementVisible,
  loadFixtures,
  waitForExcalidraw,
} from "./fixtures";

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

/**
 * 잠긴 세션은 릴레이(룸)를 아예 쓰지 않는다 — 읽기 전용 멤버가 룸으로 편집을 주입해
 * 다른 사람의 자동저장에 실리는 경로를 없앤다 (m2-collab §8).
 * 대신 뷰어는 서버 씬을 주기적으로 폴링해 관리자의 편집을 받는다.
 */
test("잠긴 세션은 룸 키를 주지 않고, 뷰어는 폴링으로 관리자 편집을 받는다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "잠긴 세션 폴링",
    memberIds: [aliceId],
  });
  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } })).status()).toBe(200);
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;

  const aliceContext = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await aliceContext.newPage();
  await alice.goto(url);
  await waitForExcalidraw(alice);

  // 룸 키를 주지 않는다 — 멤버에게도, 관리자에게도.
  const aliceRoom = await alice.request.get(`/api/pages/${pageId}/room`);
  expect(aliceRoom.status()).toBe(200);
  expect(await aliceRoom.json()).toEqual({ locked: true });

  // 접속자 배지는 뜨지 않고, 잠금 안내 배너가 뜬다.
  await expect(alice.getByTestId("collab-count")).toHaveCount(0);
  await expect(alice.getByTestId("collab-notice")).toContainText("실시간 협업을 사용하지 않습니다");

  // 관리자는 잠긴 세션에도 쓸 수 있다 — 관리자 화면에서 도형을 하나 그린다.
  const adminContext = await browser.newContext({ storageState: ADMIN_STATE });
  const admin = await adminContext.newPage();
  await admin.goto(url);
  await waitForExcalidraw(admin);
  const adminRoom = await admin.request.get(`/api/pages/${pageId}/room`);
  expect(await adminRoom.json()).toEqual({ locked: true });

  const rectId = await addRectangle(admin, { x: 60, y: 60 });

  // 릴레이가 없어도 뷰어의 씬 폴링으로 반영된다.
  await expectElementVisible(alice, rectId, 30_000);

  await adminContext.close();
  await aliceContext.close();
});
