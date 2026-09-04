import { expect, test } from "@playwright/test";
import { ALICE_STATE, adminApi, createSessionWithPage, loadFixtures, waitForExcalidraw } from "./fixtures";

/**
 * 폰트 자체 호스팅 확인 — 캔버스를 여는 동안 외부 CDN 요청이 하나도 없어야 하고,
 * 폰트는 우리 서버의 /excalidraw-assets/fonts 에서 내려와야 한다.
 */
test("Excalidraw 폰트를 자체 호스팅하고 외부 CDN 을 부르지 않는다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "폰트 테스트",
    memberIds: [aliceId],
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();

  const external: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1):(5173|3001)\//.test(url)) external.push(url);
  });

  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  // 손글씨 텍스트 요소를 넣어 폰트 로딩을 강제한다.
  await page.evaluate(() => {
    const api2 = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      { type: "text", x: 40, y: 40, text: "한글 폰트 테스트 ABC", fontSize: 28 },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
  });
  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  expect(external, `외부 요청이 발생했습니다: ${external.join(", ")}`).toEqual([]);

  // 자체 호스팅된 폰트가 실제로 서빙되는지 직접 확인한다.
  const fontRes = await page.request.get("/excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2");
  expect(fontRes.status()).toBe(200);
  expect(fontRes.headers()["content-type"]).toContain("font");

  await context.close();
});
