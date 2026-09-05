import { expect, test } from "@playwright/test";
import {
  ALICE_STATE,
  BOB_STATE,
  addRectangle,
  adminApi,
  createSessionWithPage,
  createSessionWithPages,
  loadFixtures,
  waitForExcalidraw,
  waitForSheet,
} from "./fixtures";

/**
 * 세션 실시간 이벤트 채널 (`/ws/session/:sessionId`) — 통합 디버깅 리포트 [높음] 1·2 회귀.
 *
 * 이전에는 세션 화면이 마운트 시 1회 로드가 전부라, 관리자가 보고 있던 페이지·세션을 지워도
 * 접속자는 삭제된 URL 에 남아 "연결을 확인해 주세요" 만 반복해서 봤다. 그리고 잠금 중에 열어 둔
 * 시트는 잠금이 풀려도 새로고침 전까지 읽기 전용에 갇혔다.
 */

/** 시나리오 7 — 보고 있던 페이지를 관리자가 지우면 안내 후 남은 페이지로 옮겨 간다 */
test("보고 있던 페이지가 삭제되면 안내 후 남은 페이지로 이동한다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageIds } = await createSessionWithPages(api, {
    name: "페이지 삭제 안내 세션",
    memberIds: [aliceId],
    pageNames: ["첫 페이지", "둘째 페이지"],
  });
  const [firstPageId, secondPageId] = pageIds as [string, string];

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${secondPageId}`);
  await waitForExcalidraw(alice);
  await expect(alice.getByTestId("page-tab")).toHaveCount(2);

  // 관리자가 앨리스가 보고 있는 페이지를 지운다.
  const deleted = await api.delete(`/api/pages/${secondPageId}`);
  expect(deleted.status(), await deleted.text()).toBe(200);
  await api.dispose();

  // 안내가 뜨고, 남아 있는 첫 페이지로 옮겨 간다 (탭도 하나로 줄어든다).
  await expect(alice.getByTestId("session-notice")).toContainText("이 페이지가 삭제되었습니다");
  await expect(alice).toHaveURL(new RegExp(`/s/${sessionId}/p/${firstPageId}$`));
  await expect(alice.getByTestId("page-tab")).toHaveCount(1);

  await context.close();
});

/** 마지막 페이지가 지워지면 "페이지 없음" 화면으로 내려간다 */
test("마지막 페이지가 삭제되면 안내와 함께 빈 세션 화면이 된다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "마지막 페이지 삭제 세션",
    memberIds: [aliceId],
    pageName: "하나뿐인 페이지",
  });

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(alice);

  expect((await api.delete(`/api/pages/${pageId}`)).status()).toBe(200);
  await api.dispose();

  await expect(alice.getByTestId("session-notice")).toContainText("이 페이지가 삭제되었습니다");
  await expect(alice.getByTestId("no-pages")).toBeVisible();

  await context.close();
});

/** 중간 이슈 — 다른 사람이 만든 페이지가 탭 목록에 즉시 나타난다 */
test("다른 사람이 만든 페이지가 새로고침 없이 탭에 나타난다", async ({ browser, playwright }) => {
  const { bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "탭 실시간 갱신 세션",
    memberIds: [bobId],
    pageName: "첫 페이지",
  });

  const context = await browser.newContext({ storageState: BOB_STATE });
  const bob = await context.newPage();
  await bob.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(bob);
  await expect(bob.getByTestId("page-tab")).toHaveCount(1);

  // 관리자가 시트 페이지를 하나 더 만든다.
  const created = await api.post(`/api/sessions/${sessionId}/pages`, {
    data: { name: "관리자가 만든 장부", type: "sheet", template: "ledger" },
  });
  expect(created.status(), await created.text()).toBe(201);

  await expect(bob.getByTestId("page-tab")).toHaveCount(2);
  await expect(bob.getByTestId("page-tab").nth(1)).toContainText("관리자가 만든 장부");
  await expect(bob.getByTestId("page-tab").nth(1)).toHaveAttribute("data-page-type", "sheet");

  // 이름 변경·순서 변경도 그대로 따라온다.
  const renamed = await api.patch(`/api/pages/${pageId}`, { data: { name: "이름 바뀐 첫 페이지" } });
  expect(renamed.status()).toBe(200);
  await expect(bob.getByTestId("page-tab").nth(0)).toContainText("이름 바뀐 첫 페이지");

  const newPageId = (await created.json()).page.id as string;
  const reordered = await api.put(`/api/sessions/${sessionId}/pages/order`, {
    data: { pageIds: [newPageId, pageId] },
  });
  expect(reordered.status(), await reordered.text()).toBe(200);
  await expect(bob.getByTestId("page-tab").nth(0)).toContainText("관리자가 만든 장부");

  await api.dispose();
  await context.close();
});

/** 시나리오 7b — 세션 자체가 삭제되면 안내 후 세션 목록으로 돌아간다 */
test("세션이 삭제되면 안내 후 세션 목록으로 돌아간다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "삭제될 세션",
    memberIds: [aliceId],
  });

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(alice);

  expect((await api.delete(`/api/admin/sessions/${sessionId}`)).status()).toBe(200);
  await api.dispose();

  await expect(alice).toHaveURL(/\/$/);
  await expect(alice.getByTestId("session-list-notice")).toContainText("이 세션이 삭제되었습니다");

  await context.close();
});

/** 시나리오 7c — 멤버에서 빠지면 안내 후 세션 목록으로 돌아간다 */
test("멤버에서 해제되면 안내 후 세션 목록으로 돌아간다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "멤버 해제 세션",
    memberIds: [aliceId],
  });

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(alice);

  expect((await api.delete(`/api/admin/sessions/${sessionId}/members/${aliceId}`)).status()).toBe(200);
  await api.dispose();

  await expect(alice).toHaveURL(/\/$/);
  await expect(alice.getByTestId("session-list-notice")).toContainText("접근 권한이 해제되었습니다");

  await context.close();
});

/**
 * 저장 실패 메시지 구분.
 *
 * 문구 매핑 자체는 순수 함수로 뽑아 단위 테스트한다
 * (`frontend/src/collab/status.ts` 의 `saveErrorMessage`, `status.test.ts`).
 * 여기서는 그 매핑의 전제 — 지워진 페이지에 저장하면 서버가 **404** 를 준다는 것과,
 * 그 상황에서 화면이 "연결 문제" 로 방치되지 않고 안내 후 옮겨 간다는 것 — 을 확인한다.
 */
test("삭제된 페이지는 404 로 저장이 막히고 화면은 안내 후 옮겨 간다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageIds } = await createSessionWithPages(api, {
    name: "저장 실패 문구 세션",
    memberIds: [aliceId],
    pageNames: ["살아남을 페이지", "지워질 페이지"],
  });
  const doomedPageId = pageIds[1]!;

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${doomedPageId}`);
  await waitForExcalidraw(alice);

  expect((await api.delete(`/api/pages/${doomedPageId}`)).status()).toBe(200);
  await api.dispose();

  // 삭제 안내는 뜨고 남은 페이지로 옮겨 간다.
  await expect(alice.getByTestId("session-notice")).toContainText("이 페이지가 삭제되었습니다");

  // 삭제된 페이지에 직접 저장하면 서버가 404 를 준다 (배너 문구의 근거).
  const res = await alice.request.put(`/api/pages/${doomedPageId}/scene`, {
    data: { elements: [], appState: {} },
  });
  expect(res.status()).toBe(404);

  await context.close();
});

/**
 * 시나리오 3 (잠금 해제 방향) — 잠금 중에 열어 둔 시트가 잠금 해제 후 편집으로 돌아온다.
 * 이전에는 `/ws/sheet` 의 readOnly 가 핸드셰이크 스냅샷이라 새로고침 전까지 갇혀 있었다.
 */
test("잠금 중에 열어 둔 시트는 잠금 해제 후 새로고침 없이 편집으로 돌아온다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "시트 잠금 해제 세션",
    memberIds: [aliceId],
    pageName: "장부",
    pageType: "sheet",
    template: "ledger",
  });
  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } })).status()).toBe(200);

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForSheet(alice);

  // 잠긴 동안: 읽기 전용 배지 + 가져오기 버튼 없음
  await expect(alice.getByTestId("sheet-readonly")).toBeVisible();
  await expect(alice.getByTestId("readonly-pill")).toBeVisible();
  await expect(alice.getByTestId("sheet-import-xlsx")).toHaveCount(0);

  // 관리자가 잠금을 푼다 — 새로고침 없이 편집이 돌아와야 한다.
  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: false } })).status()).toBe(200);
  await api.dispose();

  await expect(alice.getByTestId("sheet-readonly")).toHaveCount(0);
  await expect(alice.getByTestId("readonly-pill")).toHaveCount(0);
  await expect(alice.getByTestId("sheet-import-xlsx")).toBeVisible();

  await context.close();
});

/** 캔버스도 같은 채널로 잠금·해제를 즉시 반영한다 (폴링을 기다리지 않는다) */
test("캔버스는 세션 잠금·해제를 실시간으로 반영한다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "캔버스 잠금 실시간 세션",
    memberIds: [aliceId],
  });

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const alice = await context.newPage();
  await alice.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(alice);
  await expect(alice.getByTestId("readonly-pill")).toHaveCount(0);
  await addRectangle(alice, { x: 40, y: 40 });

  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } })).status()).toBe(200);
  await expect(alice.getByTestId("readonly-pill")).toBeVisible();
  await expect(alice.getByTestId("add-page-button")).toHaveCount(0);

  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: false } })).status()).toBe(200);
  await api.dispose();
  await expect(alice.getByTestId("readonly-pill")).toHaveCount(0);
  await expect(alice.getByTestId("add-page-button")).toBeVisible();

  await context.close();
});
