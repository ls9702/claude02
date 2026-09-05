import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  ALICE_STATE,
  BOB_STATE,
  addComment,
  addRectangle,
  adminApi,
  createSessionWithPage,
  deleteElement,
  expectCollaborators,
  expectElementVisible,
  loadFixtures,
  moveElement,
  pinPosition,
  waitForExcalidraw,
} from "./fixtures";

/**
 * M3 오브젝트 댓글 — 핀 앵커·실시간 브로드캐스트·해결·배지.
 * 실시간 경로는 `/ws/comments/:pageId` (협업 릴레이와 별개의 채널)다.
 */

async function openPage(
  browser: Browser,
  storageState: string,
  url: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto(url);
  await waitForExcalidraw(page);
  return { page, close: () => context.close() };
}

test("A 의 댓글이 B 에 즉시 뜨고, 답글·해결도 실시간으로 반영된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "댓글 실시간",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openPage(browser, ALICE_STATE, url);
  const b = await openPage(browser, BOB_STATE, url);
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  // A 가 도형을 그리고 그 위에 댓글을 단다 → 요소 앵커
  const rectId = await addRectangle(a.page, { x: 120, y: 80, width: 220, height: 140 });
  await expectElementVisible(b.page, rectId, 15_000);
  await addComment(a.page, { x: 200, y: 140 }, "이 도형 확인해 주세요");

  await expect(a.page.getByTestId("comment-pin")).toHaveCount(1);
  await expect(a.page.getByTestId("comment-pin")).toHaveAttribute("data-orphaned", "0");
  // B 에는 WebSocket 으로 즉시 나타난다.
  await expect(b.page.getByTestId("comment-pin")).toHaveCount(1, { timeout: 20_000 });

  // 상단 바 미해결 배지
  await expect(a.page.getByTestId("comment-count")).toHaveText("💬 1");
  await expect(b.page.getByTestId("comment-count")).toHaveText("💬 1", { timeout: 20_000 });

  // 세션 목록 카드 배지 (서버 집계)
  const list = await a.page.context().newPage();
  await list.goto("/");
  const card = list.getByTestId("session-card").filter({ hasText: "댓글 실시간" });
  await expect(card.getByTestId("unresolved-badge")).toHaveText("1");

  // B 가 답글 → A 의 스레드에 실시간 반영
  await b.page.getByTestId("comment-pin").click();
  await expect(b.page.getByTestId("comment-body")).toHaveText("이 도형 확인해 주세요");
  await b.page.getByTestId("reply-input").fill("확인했습니다");
  await b.page.getByTestId("reply-submit").click();
  await expect(b.page.getByTestId("comment-reply")).toHaveCount(1);

  await a.page.getByTestId("comment-pin").click();
  await expect(a.page.getByTestId("comment-reply")).toHaveCount(1, { timeout: 20_000 });
  await expect(a.page.getByTestId("comment-reply")).toContainText("확인했습니다");

  // A 가 해결 처리 → 기본 뷰에서는 양쪽 모두 핀이 사라진다.
  await a.page.getByTestId("comment-resolve").click();
  await expect(a.page.getByTestId("comment-pin")).toHaveCount(0);
  await expect(b.page.getByTestId("comment-pin")).toHaveCount(0, { timeout: 20_000 });
  await expect(a.page.getByTestId("comment-count")).toHaveCount(0);

  // 목록에서 "해결 포함" 을 켜면 다시 보인다.
  await a.page.getByTestId("comments-sidebar-toggle").click();
  await expect(a.page.getByTestId("comments-empty")).toBeVisible();
  await a.page.getByTestId("comments-show-resolved").check();
  await expect(a.page.getByTestId("comments-list-item")).toHaveCount(1);
  await expect(a.page.getByTestId("comment-pin")).toHaveAttribute("data-resolved", "1");

  // 세션 목록 배지도 줄어든다.
  await list.reload();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("unresolved-badge")).toHaveCount(0);

  await list.close();
  await b.close();
  await a.close();
});

test("요소를 옮기면 핀이 따라가고, 요소를 지우면 마지막 위치에서 '요소 삭제됨' 이 된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "댓글 앵커",
    memberIds: [aliceId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  const page = a.page;

  const rectId = await addRectangle(page, { x: 100, y: 100, width: 200, height: 100 });
  await addComment(page, { x: 150, y: 140 }, "요소에 붙은 댓글");

  const pin = page.getByTestId("comment-pin");
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveAttribute("data-orphaned", "0");

  // 서버에는 생성 시점의 요소 우상단(300, 100)이 저장된다.
  const readComment = async () => {
    const res = await page.request.get(`/api/pages/${pageId}/comments`);
    const comments = (await res.json()).comments as Array<{
      id: string;
      x: number;
      y: number;
      elementId: string | null;
    }>;
    return comments[0]!;
  };
  const created = await readComment();
  expect(created.elementId).toBe(rectId);
  expect(Math.round(created.x)).toBe(300);
  expect(Math.round(created.y)).toBe(100);

  const before = (await pinPosition(page))!;

  // 요소를 오른쪽으로 300 옮기면 핀의 화면 위치도 그만큼 이동한다.
  await moveElement(page, rectId, { dx: 300, dy: 0 });
  await expect
    .poll(async () => (await pinPosition(page))?.x ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(before.x + 250);
  const moved = (await pinPosition(page))!;
  expect(moved.y).toBe(before.y);

  // 요소를 지우면 핀은 그 자리에 남고 "요소 삭제됨" 이 뜬다.
  await deleteElement(page, rectId);
  await expect(page.getByTestId("comment-pin-orphan")).toBeVisible({ timeout: 10_000 });
  await expect(pin).toHaveAttribute("data-orphaned", "1");
  expect(await pinPosition(page)).toEqual(moved);

  // 고아로 바뀌는 순간 마지막 위치가 서버에 한 번 저장된다 (600, 100).
  await expect
    .poll(async () => Math.round((await readComment()).x), { timeout: 15_000 })
    .toBe(600);
  expect(Math.round((await readComment()).y)).toBe(100);

  await a.close();
});

test("사이드바 목록에서 고르면 그 위치로 캔버스가 이동하고 스레드가 열린다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "댓글 사이드바",
    memberIds: [aliceId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  const page = a.page;

  // API 로 만든 댓글도 WebSocket 으로 화면에 들어온다.
  const far = await page.request.post(`/api/pages/${pageId}/comments`, {
    data: { x: 2400, y: 1800, body: "멀리 있는 메모" },
  });
  expect(far.status()).toBe(201);
  const farId = (await far.json()).comment.id as string;

  await page.getByTestId("comments-sidebar-toggle").click();
  await expect(page.getByTestId("comments-list-item")).toHaveCount(1, { timeout: 20_000 });

  const scrollBefore = await page.evaluate(
    () => (window.__excalidrawAPI!.getAppState() as { scrollX: number }).scrollX,
  );
  await page.getByTestId("comments-list-item").click();

  await expect(page.getByTestId("comment-thread")).toHaveAttribute("data-comment-id", farId);
  const scrollAfter = await page.evaluate(
    () => (window.__excalidrawAPI!.getAppState() as { scrollX: number }).scrollX,
  );
  expect(Math.abs(scrollAfter - scrollBefore)).toBeGreaterThan(100);
  // 이동 후 핀은 화면 안에 있다.
  const position = await pinPosition(page, farId);
  expect(position).not.toBeNull();

  await a.close();
});

test("잠긴 세션에서는 댓글 작성이 막히고 해결 처리만 남는다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "댓글 잠금",
    memberIds: [aliceId],
  });

  const created = await api.post(`/api/pages/${pageId}/comments`, {
    data: { x: 60, y: 60, body: "잠그기 전 댓글" },
  });
  expect(created.status()).toBe(201);
  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } })).status()).toBe(200);
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  const page = a.page;

  await expect(page.getByTestId("readonly-pill")).toBeVisible();
  // 댓글 모드 버튼 자체가 없다.
  await expect(page.getByTestId("comment-mode")).toHaveCount(0);

  // 서버도 작성을 거부한다.
  const denied = await page.request.post(`/api/pages/${pageId}/comments`, {
    data: { x: 1, y: 1, body: "잠긴 세션" },
  });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe("session_locked");

  // 읽기와 해결 처리는 된다.
  await expect(page.getByTestId("comment-pin")).toHaveCount(1);
  await page.getByTestId("comment-pin").click();
  await expect(page.getByTestId("reply-input")).toHaveCount(0);
  await expect(page.getByTestId("comment-delete")).toHaveCount(0);
  await page.getByTestId("comment-resolve").click();
  await expect(page.getByTestId("comment-pin")).toHaveCount(0);

  await a.close();
});

test("남의 댓글은 삭제 버튼이 없고, 내 댓글은 지울 수 있다", async ({ browser, playwright }) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "댓글 삭제 권한",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  const b = await openPage(browser, BOB_STATE, `/s/${sessionId}/p/${pageId}`);

  await addComment(a.page, { x: 160, y: 120 }, "alice 의 댓글");
  await expect(b.page.getByTestId("comment-pin")).toHaveCount(1, { timeout: 20_000 });

  // bob 에게는 삭제 버튼이 없다.
  await b.page.getByTestId("comment-pin").click();
  await expect(b.page.getByTestId("comment-resolve")).toBeVisible();
  await expect(b.page.getByTestId("comment-delete")).toHaveCount(0);

  // 서버도 막는다.
  const commentId = await b.page
    .getByTestId("comment-pin")
    .getAttribute("data-comment-id");
  const denied = await b.page.request.delete(`/api/comments/${commentId}`);
  expect(denied.status()).toBe(403);

  // alice 는 지울 수 있고 bob 화면에서도 사라진다.
  await a.page.getByTestId("comment-pin").click();
  await a.page.getByTestId("comment-delete").click();
  await expect(a.page.getByTestId("comment-pin")).toHaveCount(0);
  await expect(b.page.getByTestId("comment-pin")).toHaveCount(0, { timeout: 20_000 });

  await b.close();
  await a.close();
});

test("같은 자리에 겹친 핀도 하나씩 직접 클릭할 수 있다", async ({ browser, playwright }) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "겹친 핀",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  const b = await openPage(browser, BOB_STATE, `/s/${sessionId}/p/${pageId}`);

  // 두 사람이 **같은 좌표**에 댓글을 남긴다 (API 로 직접 — UI 로는 먼저 생긴 핀이 클릭을 가져간다).
  for (const [ctx, body] of [
    [a.page, "겹침 A"],
    [b.page, "겹침 B"],
  ] as const) {
    const created = await ctx.request.post(`/api/pages/${pageId}/comments`, {
      data: { x: 100, y: 100, body },
    });
    expect(created.status(), await created.text()).toBe(201);
  }

  const pins = a.page.getByTestId("comment-pin");
  await expect(pins).toHaveCount(2, { timeout: 20_000 });

  // 생성 순서대로 가로로 펼쳐진다 — 두 핀의 상자가 겹치지 않는다.
  await expect(pins.nth(0)).toHaveAttribute("data-cluster-index", "0");
  await expect(pins.nth(1)).toHaveAttribute("data-cluster-index", "1");
  await expect(pins.nth(1)).toHaveAttribute("data-cluster-size", "2");
  const first = (await pins.nth(0).boundingBox())!;
  const second = (await pins.nth(1).boundingBox())!;
  expect(second.x).toBeGreaterThanOrEqual(first.x + first.width - 1);
  expect(Math.round(second.y)).toBe(Math.round(first.y));

  // 아래(먼저 생긴) 핀도 직접 눌러 스레드를 열 수 있다 — 예전에는 위 핀에 가려 클릭이 막혔다.
  await pins.nth(0).click();
  await expect(a.page.getByTestId("comment-body")).toHaveText("겹침 A");
  await a.page.keyboard.press("Escape");
  await expect(a.page.getByTestId("comment-body")).toHaveCount(0);

  await pins.nth(1).click();
  await expect(a.page.getByTestId("comment-body")).toHaveText("겹침 B");

  await b.close();
  await a.close();
});

test("터치 기기(pointer: coarse)에서는 핀·버튼 탭 타겟이 40px 이상이다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "탭 타겟",
    memberIds: [aliceId],
  });
  await api.dispose();

  // `hasTouch` 를 켜면 Chromium 이 굵은 포인터로 보고한다 — CSS `@media (pointer: coarse)` 검증.
  const context = await browser.newContext({
    storageState: ALICE_STATE,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  const created = await page.request.post(`/api/pages/${pageId}/comments`, {
    data: { x: 120, y: 120, body: "모바일 탭 타겟" },
  });
  expect(created.status()).toBe(201);
  await expect(page.getByTestId("comment-pin")).toHaveCount(1, { timeout: 20_000 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

  const boxOf = async (testId: string) => (await page.getByTestId(testId).boundingBox())!;
  for (const testId of ["comment-pin", "comment-mode", "comments-sidebar-toggle"]) {
    const box = await boxOf(testId);
    expect(box.height, `${testId} 높이`).toBeGreaterThanOrEqual(40);
    expect(box.width, `${testId} 너비`).toBeGreaterThanOrEqual(40);
  }

  // 커진 핀도 그대로 눌러서 열린다.
  await page.getByTestId("comment-pin").click();
  await expect(page.getByTestId("comment-body")).toHaveText("모바일 탭 타겟");

  await context.close();
});
