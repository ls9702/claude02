import { expect, test } from "@playwright/test";
import {
  ALICE_STATE,
  BOB_STATE,
  adminApi,
  addRectangle,
  createSessionWithPage,
  expectCellValue,
  expectElementVisible,
  loadFixtures,
  waitForSheet,
} from "../tests/fixtures";
import { expectNoCspViolations, openCanvas, openPage } from "./helpers";

/**
 * 프로덕션 빌드 스모크 — 캔버스 · 이미지 · 협업 · 시트 · AI 시트가
 * **CSP 아래에서** 그대로 도는지 본다.
 *
 * 기능 자체의 자세한 검증은 dev e2e(`tests/`)가 한다. 여기서 확인하려는 것은
 * "번들·CSP·정적 서빙이 dev 와 달라져서 깨지는 곳이 없는가" 하나다.
 */

test("캔버스: 도형을 그리고 저장 → 새로고침 후에도 남는다 (CSP 위반 없음)", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "프로덕션 캔버스",
    memberIds: [aliceId],
  });
  await api.dispose();

  const { page, close } = await openCanvas(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);

  await addRectangle(page, { x: 100, y: 100, width: 200, height: 120 });
  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  // 썸네일(exportToBlob → 캔버스·폰트·워커 경로)도 프로덕션에서 올라간다.
  await expect
    .poll(async () => (await page.request.get(`/api/pages/${pageId}/thumbnail`)).status(), {
      timeout: 30_000,
    })
    .toBe(200);

  await page.reload();
  await expect
    .poll(async () => page.evaluate(() => window.__excalidrawAPI?.getSceneElements().length ?? -1), {
      timeout: 60_000,
    })
    .toBe(1);

  await expectNoCspViolations(page);
  await close();
});

test("폰트: 손글씨 폰트가 자체 호스팅 경로에서 로드된다 (외부 CDN 차단)", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "프로덕션 폰트",
    memberIds: [aliceId],
  });
  await api.dispose();

  const { page, close } = await openCanvas(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);

  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));

  // 한글·라틴이 섞인 텍스트 → Excalifont(라틴) + Xiaolai(한중일) 두 패밀리를 실제로 쓴다.
  await page.evaluate(() => {
    const api2 = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      { type: "text", x: 50, y: 50, text: "한글 Hello 123", fontFamily: 5 },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
  });

  await expect
    .poll(async () => page.evaluate(() => document.fonts.check("20px Excalifont")), { timeout: 30_000 })
    .toBe(true);

  // 실제 폰트 파일은 우리 오리진에서 받는다 — esm.sh 로는 한 바이트도 나가지 않는다.
  const local = requests.filter((url) => url.includes("/excalidraw-assets/fonts/"));
  expect(local.length, `자체 호스팅 폰트 요청: ${JSON.stringify(local.slice(0, 3))}`).toBeGreaterThan(0);
  expect(requests.filter((url) => url.startsWith("https://esm.sh/"))).toEqual([]);

  await expectNoCspViolations(page);
  await close();
});

test("이미지: 붙여넣은 이미지가 업로드되고 새로고침 후 복원된다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "프로덕션 이미지",
    memberIds: [aliceId],
  });
  await api.dispose();

  const { page, close } = await openCanvas(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);

  const uploaded = page.waitForResponse(
    (res) => res.url().includes(`/api/pages/${pageId}/files`) && res.request().method() === "POST",
    { timeout: 60_000 },
  );

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3355ff";
    ctx.fillRect(0, 0, 640, 400);
    const api2 = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    api2.addFiles([
      { id: "prodsmokeimage001", dataURL: canvas.toDataURL("image/png"), mimeType: "image/png", created: Date.now() },
    ]);
    const created = lib.convertToExcalidrawElements([
      { type: "image", x: 0, y: 0, width: 320, height: 200, fileId: "prodsmokeimage001" },
    ]);
    api2.updateScene({ elements: [...api2.getSceneElementsIncludingDeleted(), ...created] });
  });

  const response = await uploaded;
  expect([200, 201]).toContain(response.status());
  await expect(page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });

  await page.reload();
  // 새로고침 후 서버에서 받은 이미지가 다시 씬에 붙는다.
  // (`GET /files/:id` → blob → dataURL 경로라, blob:/data: 가 CSP 에 막히면 여기서 깨진다.)
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api2 = window.__excalidrawAPI;
          if (!api2) return null;
          const image = api2.getSceneElements().find((el) => el.type === "image");
          if (!image) return null;
          return Boolean(api2.getFiles()[String(image.fileId)]);
        }),
      { timeout: 60_000 },
    )
    .toBe(true);

  // 업로드 파일은 프로덕션에서도 권한 검사를 지나 내려온다 (자체 CSP + 장기 캐시).
  const fileRes = await page.request.get(`/files/prodsmokeimage001`);
  expect(fileRes.status()).toBe(200);
  expect(fileRes.headers()["content-security-policy"]).toContain("sandbox");
  expect(fileRes.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");

  await expectNoCspViolations(page);
  await close();
});

test("협업: 두 사람의 편집이 릴레이를 지나 서로 보인다", async ({ browser, playwright }) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "프로덕션 협업",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openCanvas(browser, ALICE_STATE, url);
  const b = await openCanvas(browser, BOB_STATE, url);

  await expect(a.page.getByTestId("collab-count")).toHaveText("접속 2명", { timeout: 30_000 });

  const id = await addRectangle(a.page, { x: 40, y: 40 });
  await expectElementVisible(b.page, id, 30_000);

  await expectNoCspViolations(a.page);
  await expectNoCspViolations(b.page);
  await b.close();
  await a.close();
});

test("시트: 회비 장부 템플릿이 열리고 수식이 계산된다 (지연 로드 청크)", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "프로덕션 시트",
    memberIds: [aliceId],
    pageName: "장부",
    pageType: "sheet",
    template: "ledger",
  });
  await api.dispose();

  const { page, close } = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  await waitForSheet(page);

  // 샘플 데이터의 합계·잔액 (dev e2e 10-sheet 와 같은 좌표)
  await expectCellValue(page, 203, 3, 50000);
  await expectCellValue(page, 204, 3, 45000);
  await expectCellValue(page, 205, 3, 5000);

  await expectNoCspViolations(page);
  await close();
});

test("AI 시트: 질문 → 미리보기 → 카드 삽입이 프로덕션 번들에서 동작한다", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "프로덕션 AI",
    memberIds: [aliceId],
  });
  await api.dispose();

  const { page, close } = await openCanvas(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);

  // 「AI 도우미 사용」은 기기별 설정이다 — 켜야 ✨ 가 나온다.
  await page.getByTestId("user-menu-button").click();
  await page.getByTestId("ai-toggle").locator("input").check();
  await page.getByTestId("user-menu-button").click();

  await page.getByTestId("ai-open").click();
  await expect(page.getByTestId("ai-sheet")).toBeVisible();
  await page.getByTestId("ai-input").fill("부산 2박 3일 코스 알려줘");
  await page.getByTestId("ai-submit").click();

  await expect(page.getByTestId("ai-preview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ai-preview-title")).toHaveText("부산 2박 3일 코스");
  await expect(page.getByTestId("ai-source")).toHaveCount(2);

  await page.getByTestId("ai-insert").click();
  await expect(page.getByTestId("ai-added")).toBeVisible();

  const cards = await page.evaluate(
    () =>
      window
        .__excalidrawAPI!.getSceneElements()
        .filter((el) => Boolean((el.customData as { aiCard?: unknown } | undefined)?.aiCard)).length,
  );
  expect(cards).toBeGreaterThanOrEqual(5);

  await expectNoCspViolations(page);
  await close();
});
