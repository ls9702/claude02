import { expect, test } from "@playwright/test";
import { ALICE_STATE, adminApi, createSessionWithPage, loadFixtures, waitForExcalidraw } from "./fixtures";

const FILE_ID = "e2eimagefixture0001";

/** 시나리오 6 — 3000px 이미지를 넣으면 2048px 이하로 리사이즈해 업로드하고, 새로고침 후 복원한다 */
test("큰 이미지는 장변 2048px 로 리사이즈해 업로드되고 새로고침 후 복원된다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "이미지 테스트",
    memberIds: [aliceId],
  });
  await api.dispose();

  const context = await browser.newContext({ storageState: ALICE_STATE });
  const page = await context.newPage();
  await page.goto(`/s/${sessionId}/p/${pageId}`);
  await waitForExcalidraw(page);

  const uploadResponse = page.waitForResponse(
    (res) => res.url().includes(`/api/pages/${pageId}/files`) && res.request().method() === "POST",
    { timeout: 60_000 },
  );

  await page.evaluate((fileId) => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 1500;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3355ff";
    ctx.fillRect(0, 0, 3000, 1500);
    ctx.fillStyle = "#ffcc00";
    ctx.fillRect(200, 200, 1200, 700);
    const dataURL = canvas.toDataURL("image/png");

    const api2 = window.__excalidrawAPI!;
    api2.addFiles([{ id: fileId, dataURL, mimeType: "image/png", created: Date.now() }]);

    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      { type: "image", x: 0, y: 0, width: 600, height: 300, fileId },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
  }, FILE_ID);

  const response = await uploadResponse;
  expect([200, 201]).toContain(response.status());

  // 씬의 이미지 요소는 리사이즈본 파일을 가리켜야 한다.
  const sceneFileId = await page.evaluate(() => {
    const image = window
      .__excalidrawAPI!.getSceneElements()
      .find((el) => el.type === "image");
    return image ? String(image.fileId) : null;
  });
  expect(sceneFileId).toBe(`${FILE_ID}-r2048`);

  // 씬 안의 dataURL 이 리사이즈된 크기(장변 2048)로 바뀌었는지 확인
  const sceneSize = await page.evaluate(async (fileId) => {
    const file = window.__excalidrawAPI!.getFiles()[fileId];
    if (!file) return null;
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("load failed"));
      img.src = file.dataURL;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, sceneFileId!);
  expect(sceneSize).not.toBeNull();
  expect(Math.max(sceneSize!.width, sceneSize!.height)).toBe(2048);
  expect(sceneSize!.height).toBe(1024);

  // 서버에 저장된 파일도 리사이즈된 크기여야 한다.
  const storedSize = await page.evaluate(async (fileId) => {
    const res = await fetch(`/files/${fileId}`, { credentials: "same-origin" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("load failed"));
      img.src = url;
    });
    URL.revokeObjectURL(url);
    return { width: img.naturalWidth, height: img.naturalHeight, type: blob.type };
  }, sceneFileId!);
  expect(storedSize).not.toBeNull();
  expect(storedSize!.width).toBe(2048);
  expect(storedSize!.height).toBe(1024);
  expect(storedSize!.type).toBe("image/png");

  // 원본(3000px)은 서버에 올라가지 않는다.
  const originalStatus = await page.evaluate(
    async (fileId) => (await fetch(`/files/${fileId}`, { credentials: "same-origin" })).status,
    FILE_ID,
  );
  expect(originalStatus).toBe(404);

  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  // 새로고침 → 이미지 요소와 파일이 복원된다.
  await page.reload();
  await waitForExcalidraw(page);

  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          window.__excalidrawAPI!.getSceneElements().filter((el) => el.type === "image").length,
        ),
      { timeout: 30_000 },
    )
    .toBe(1);

  await expect
    .poll(
      async () =>
        page.evaluate((fileId) => Boolean(window.__excalidrawAPI!.getFiles()[fileId]), sceneFileId!),
      { timeout: 30_000 },
    )
    .toBe(true);

  await context.close();
});
