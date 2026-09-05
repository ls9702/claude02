import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  ALICE_STATE,
  BOB_STATE,
  addRectangle,
  adminApi,
  createSessionWithPage,
  createSessionWithPages,
  expectCollaborators,
  expectElementVisible,
  loadFixtures,
  waitForExcalidraw,
} from "./fixtures";

/**
 * M2 실시간 협업 — 브라우저 컨텍스트 두 개(A=alice, B=bob)로 같은 페이지를 연다.
 * 릴레이는 excalidraw-room(3002)이고, 브라우저는 언제나 app 의 `/socket.io` 프록시를 거친다.
 */

/** 저장된 페이지의 서버 씬을 읽는다 (요소 id 목록). */
async function serverElementIds(page: Page, pageId: string): Promise<string[]> {
  const res = await page.request.get(`/api/pages/${pageId}/scene`);
  expect(res.ok()).toBe(true);
  const scene = (await res.json()) as { elements: Array<{ id: string; isDeleted?: boolean }> };
  return scene.elements.filter((el) => !el.isDeleted).map((el) => el.id).sort();
}

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

test("A 가 추가한 도형이 B 에게 실시간으로 보이고, B 가 옮기면 A 에도 반영된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "협업 브로드캐스트",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openPage(browser, ALICE_STATE, url);
  const b = await openPage(browser, BOB_STATE, url);

  // 둘 다 같은 룸에 들어갈 때까지 기다린다.
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  // 시나리오 1 — A 가 사각형 추가 → B 에 등장
  const rectId = await addRectangle(a.page, { x: 120, y: 80, width: 220, height: 140 });
  await expectElementVisible(b.page, rectId, 10_000);

  // 시나리오 2 — B 가 그 사각형을 옮기면 A 에 반영된다 (버전 충돌 없음)
  await b.page.evaluate((id) => {
    const api2 = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const next = api2.getSceneElementsIncludingDeleted().map((el) => {
      if (el.id !== id) return el;
      return lib.newElementWith(el, { x: Number(el.x) + 300, y: Number(el.y) + 150 });
    });
    api2.updateScene({ elements: next });
  }, rectId);

  const readX = (page: Page) =>
    page.evaluate((id) => {
      const el = window.__excalidrawAPI!.getSceneElements().find((e) => e.id === id);
      return el ? Number(el.x) : null;
    }, rectId);

  await expect.poll(() => readX(a.page), { timeout: 15_000 }).toBe(420);

  // 양쪽 요소 수·버전이 어긋나지 않는다 (같은 요소 하나로 수렴).
  const summary = (page: Page) =>
    page.evaluate((id) => {
      const els = window.__excalidrawAPI!.getSceneElements();
      const el = els.find((e) => e.id === id);
      return { count: els.length, x: el ? Number(el.x) : null, y: el ? Number(el.y) : null };
    }, rectId);

  await expect.poll(() => summary(a.page), { timeout: 15_000 }).toEqual({ count: 1, x: 420, y: 230 });
  await expect.poll(() => summary(b.page), { timeout: 15_000 }).toEqual({ count: 1, x: 420, y: 230 });

  // 서버에도 같은 결과가 저장된다.
  await expect.poll(() => serverElementIds(a.page, pageId), { timeout: 40_000 }).toEqual([rectId]);

  await b.close();
  await a.close();
});

test("A 가 넣은 이미지가 B 에 요소·파일 모두 동기화된다", async ({ browser, playwright }) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "협업 이미지",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openPage(browser, ALICE_STATE, url);
  const b = await openPage(browser, BOB_STATE, url);
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  const FILE_ID = "collabimagefixture01";

  const uploaded = a.page.waitForResponse(
    (res) => res.url().includes(`/api/pages/${pageId}/files`) && res.request().method() === "POST",
    { timeout: 60_000 },
  );

  const imageElementId = await a.page.evaluate((fileId) => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 120;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#22aa66";
    ctx.fillRect(0, 0, 200, 120);
    const dataURL = canvas.toDataURL("image/png");

    const api2 = window.__excalidrawAPI!;
    api2.addFiles([{ id: fileId, dataURL, mimeType: "image/png", created: Date.now() }]);

    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      { type: "image", x: 40, y: 40, width: 200, height: 120, fileId },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
    return String(created[0]!.id);
  }, FILE_ID);

  const response = await uploaded;
  expect([200, 201]).toContain(response.status());

  // B 는 이미지 요소를 받고, 파일도 서버에서 내려받는다.
  await expectElementVisible(b.page, imageElementId, 20_000);
  await expect
    .poll(
      async () => b.page.evaluate((fileId) => Boolean(window.__excalidrawAPI!.getFiles()[fileId]), FILE_ID),
      { timeout: 30_000 },
    )
    .toBe(true);

  await b.close();
  await a.close();
});

test("둘이 동시에 그려도 최종 요소가 같고, 서버 씬에도 같은 결과가 남는다", async ({
  browser,
  playwright,
}) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "협업 동시 편집",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openPage(browser, ALICE_STATE, url);
  const b = await openPage(browser, BOB_STATE, url);
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  // 3초 동안 각자 5개씩 (600ms 간격) 동시에 추가한다.
  const drawFive = async (page: Page, baseX: number) => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await addRectangle(page, { x: baseX + i * 40, y: 100 + i * 30 }));
      await page.waitForTimeout(600);
    }
    return ids;
  };

  const [aIds, bIds] = await Promise.all([drawFive(a.page, 0), drawFive(b.page, 600)]);
  const expected = [...aIds, ...bIds].sort();
  expect(expected).toHaveLength(10);

  const localIds = (page: Page) =>
    page.evaluate(() =>
      window
        .__excalidrawAPI!.getSceneElements()
        .map((el) => String(el.id))
        .sort(),
    );

  await expect.poll(() => localIds(a.page), { timeout: 40_000 }).toEqual(expected);
  await expect.poll(() => localIds(b.page), { timeout: 40_000 }).toEqual(expected);

  // 서버 씬에도 10개가 모두 병합되어 있다.
  await expect.poll(() => serverElementIds(a.page, pageId), { timeout: 60_000 }).toEqual(expected);

  // 새로고침해도 같은 결과.
  await a.page.reload();
  await waitForExcalidraw(a.page);
  await expect.poll(() => localIds(a.page), { timeout: 40_000 }).toEqual(expected);

  await b.close();
  await a.close();
});

test("접속자 수가 '접속 2명' 으로 뜨고 한 명이 나가면 '접속 1명' 이 된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "협업 접속자",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openPage(browser, ALICE_STATE, url);
  await expectCollaborators(a.page, 1);

  const b = await openPage(browser, BOB_STATE, url);
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  await b.close();
  await expectCollaborators(a.page, 1);

  await a.close();
});

test("페이지를 전환하면 이전 룸에서 나가고 새 룸에 참여한다 (편집이 새지 않는다)", async ({
  browser,
  playwright,
}) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageIds } = await createSessionWithPages(api, {
    name: "협업 페이지 전환",
    memberIds: [aliceId, bobId],
    pageNames: ["첫 페이지", "둘째 페이지"],
  });
  await api.dispose();
  const [page1, page2] = pageIds as [string, string];

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${page1}`);
  const b = await openPage(browser, BOB_STATE, `/s/${sessionId}/p/${page1}`);
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  // A 가 둘째 페이지로 이동 → 양쪽 모두 1명이 된다 (A 는 새 룸, B 는 남은 룸).
  await a.page.getByTestId("page-tab-button").nth(1).click();
  await waitForExcalidraw(a.page);
  await expectCollaborators(a.page, 1);
  await expectCollaborators(b.page, 1);

  // A 가 둘째 페이지에 그린 것은 B(첫 페이지)에 새지 않는다.
  const leakedId = await addRectangle(a.page, { x: 10, y: 10 });
  await expect
    .poll(() => serverElementIds(a.page, page2), { timeout: 60_000 })
    .toEqual([leakedId]);

  expect(
    await b.page.evaluate(
      (id) => window.__excalidrawAPI!.getSceneElements().some((el) => el.id === id),
      leakedId,
    ),
  ).toBe(false);
  expect(await serverElementIds(b.page, page1)).toEqual([]);

  // A 가 첫 페이지로 돌아오면 다시 2명이 된다.
  await a.page.getByTestId("page-tab-button").nth(0).click();
  await waitForExcalidraw(a.page);
  await expectCollaborators(a.page, 2);
  await expectCollaborators(b.page, 2);

  await b.close();
  await a.close();
});

test("로그인하지 않으면 /socket.io 릴레이에 붙을 수 없다", async ({ browser }) => {
  const context = await browser.newContext();
  const res = await context.request.get(
    "http://localhost:5173/socket.io/?EIO=4&transport=polling",
  );
  expect(res.status()).toBe(401);
  await context.close();
});

test("세션이 잠기면 접속 중인 클라이언트가 룸에서 나가고 읽기 전용이 된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "협업 중 잠금",
    memberIds: [aliceId],
  });

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  await expectCollaborators(a.page, 1);

  // 관리자가 잠근다 → 재검증 주기(VITE_ROOM_RECHECK_MS) 안에 룸을 떠나고 읽기 전용이 된다.
  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: true } })).status()).toBe(200);

  await expect(a.page.getByTestId("readonly-pill")).toBeVisible({ timeout: 30_000 });
  await expect(a.page.getByTestId("collab-count")).toHaveCount(0);
  await expect(a.page.getByTestId("collab-notice")).toContainText("실시간 협업을 사용하지 않습니다");

  // 잠금을 풀면 다시 룸에 참여한다.
  expect((await api.patch(`/api/admin/sessions/${sessionId}`, { data: { locked: false } })).status()).toBe(200);
  await expect(a.page.getByTestId("readonly-pill")).toHaveCount(0, { timeout: 30_000 });
  await expectCollaborators(a.page, 1);

  await api.dispose();
  await a.close();
});

test("저장에 실패해 배너가 떠도, 다시 저장에 성공하면 배너가 사라진다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "저장 실패 배너",
    memberIds: [aliceId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);

  // 씬 저장만 실패하게 만든다 (백엔드를 내리는 것과 같은 효과).
  let failSaves = true;
  await a.page.route(`**/api/pages/${pageId}/scene`, async (route) => {
    if (failSaves && route.request().method() === "PUT") return route.abort();
    return route.continue();
  });

  await addRectangle(a.page, { x: 30, y: 30 });
  await expect(a.page.getByTestId("save-status")).toHaveAttribute("data-status", "error", {
    timeout: 30_000,
  });
  await expect(a.page.getByTestId("collab-error")).toBeVisible();

  // 복구되면 다음 성공 저장에서 오류 배너가 사라져야 한다.
  failSaves = false;
  await addRectangle(a.page, { x: 200, y: 30 });
  await expect(a.page.getByTestId("save-status")).toHaveAttribute("data-status", "saved", {
    timeout: 30_000,
  });
  await expect(a.page.getByTestId("collab-error")).toHaveCount(0);

  await a.close();
});

test("릴레이 연결이 끊기면 '재연결 중…' 을 표시하고 복구되면 접속자 수로 돌아온다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "재연결 표시",
    memberIds: [aliceId],
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);
  await expectCollaborators(page, 1);

  // 오프라인으로 만든 뒤 transport 를 끊는다 — 재연결이 실패하는 동안 상태가 유지된다.
  await context.setOffline(true);
  await page.evaluate(() => window.__closeCollabTransport!());
  await expect(page.getByTestId("collab-reconnecting")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("collab-count")).toHaveCount(0);
  await expect(page.getByTestId("collab-notice")).toContainText("변경 내용은 계속 저장됩니다");

  await context.setOffline(false);
  await expect(page.getByTestId("collab-reconnecting")).toHaveCount(0, { timeout: 60_000 });
  await expectCollaborators(page, 1);

  await context.close();
});
