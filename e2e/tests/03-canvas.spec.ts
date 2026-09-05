import { expect, test } from "@playwright/test";
import { ALICE_STATE, adminApi, createSessionWithPage, loadFixtures, waitForExcalidraw } from "./fixtures";

/** 시나리오 5 — 캔버스에 도형 추가 → 저장 인디케이터 → 새로고침 후 유지 */
test("캔버스에 사각형을 추가하면 저장되고 새로고침해도 남아 있다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "캔버스 저장 테스트",
    memberIds: [aliceId],
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  // 처음에는 비어 있다.
  expect(await page.evaluate(() => window.__excalidrawAPI!.getSceneElements().length)).toBe(0);

  await page.evaluate(() => {
    const api2 = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      {
        type: "rectangle",
        x: 120,
        y: 80,
        width: 220,
        height: 140,
        backgroundColor: "#ffc9c9",
        strokeColor: "#1e1e1e",
      },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
  });

  // 저장 인디케이터: 저장 중 → 저장됨
  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  // 저장 후 썸네일(exportToBlob → PUT /thumbnail)도 올라간다.
  await expect
    .poll(async () => (await page.request.get(`/api/pages/${pageId}/thumbnail`)).status(), {
      timeout: 30_000,
    })
    .toBe(200);

  // 새로고침 후에도 요소가 남아 있다.
  await page.reload();
  await waitForExcalidraw(page);
  await expect
    .poll(async () => page.evaluate(() => window.__excalidrawAPI!.getSceneElements().length), {
      timeout: 30_000,
    })
    .toBe(1);

  const types = await page.evaluate(() =>
    window.__excalidrawAPI!.getSceneElements().map((el) => String(el.type)),
  );
  expect(types).toEqual(["rectangle"]);

  await context.close();
});

/** 서버 병합: 다른 클라이언트가 추가한 요소가 저장 응답으로 되돌아온다 */
test("다른 사용자가 추가한 요소가 저장 응답으로 병합되어 화면에 반영된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "씬 병합 테스트",
    memberIds: [aliceId],
  });

  // 관리자가 API 로 다른 요소를 먼저 저장해 둔다 (= 다른 클라이언트의 변경).
  const remoteElement = {
    id: "remote-element-1",
    type: "ellipse",
    x: 500,
    y: 500,
    width: 80,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 12345,
    version: 5,
    versionNonce: 111,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: "a0",
  };
  const saved = await api.put(`/api/pages/${pageId}/scene`, {
    data: { elements: [remoteElement], appState: {} },
  });
  expect(saved.status()).toBe(200);
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  await expect
    .poll(async () => page.evaluate(() => window.__excalidrawAPI!.getSceneElements().length), {
      timeout: 30_000,
    })
    .toBe(1);

  // 로컬에서 사각형을 추가하면 병합 결과로 둘 다 남는다.
  await page.evaluate(() => {
    const api2 = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      { type: "rectangle", x: 10, y: 10, width: 50, height: 50 },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
  });

  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  await page.reload();
  await waitForExcalidraw(page);
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          window
            .__excalidrawAPI!.getSceneElements()
            .map((el) => String(el.type))
            .sort()
            .join(","),
        ),
      { timeout: 30_000 },
    )
    .toBe("ellipse,rectangle");

  await context.close();
});

/** 회귀: 요소를 건드리지 않고 배경색(appState)만 바꿔도 저장되고 새로고침 후에도 유지된다 */
test("배경색만 바꿔도 저장되고 새로고침 후 유지된다", async ({ browser, playwright }) => {
  const BACKGROUND = "#7b3de7";
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "배경색 저장 테스트",
    memberIds: [aliceId],
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  // 페이지를 연 직후의 첫 저장이 끝난 뒤에 배경색만 바꾼다.
  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  await page.evaluate((background) => {
    window.__excalidrawAPI!.updateScene({ appState: { viewBackgroundColor: background } });
  }, BACKGROUND);

  // 요소 변경이 없어도 서버에 저장되어야 한다.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/pages/${pageId}/scene`);
        if (!res.ok()) return null;
        return (await res.json()).appState?.viewBackgroundColor ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe(BACKGROUND);

  // 새로고침해도 배경색이 유지된다.
  await page.reload();
  await waitForExcalidraw(page);
  await expect
    .poll(
      async () => page.evaluate(() => window.__excalidrawAPI!.getAppState().viewBackgroundColor),
      { timeout: 30_000 },
    )
    .toBe(BACKGROUND);

  await context.close();
});
