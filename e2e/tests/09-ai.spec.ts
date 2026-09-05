import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOCK_GEMINI_URL } from "../playwright.config";
import {
  ALICE_STATE,
  BOB_STATE,
  adminApi,
  createSessionWithPage,
  loadFixtures,
  waitForExcalidraw,
} from "./fixtures";

/**
 * M4 AI 검색 카드 — 게이트(토글·서버 키), 질문·미리보기, 카드 삽입(협업·저장), 폴백 파서, 퓨즈.
 *
 * 업스트림은 `e2e/mock-gemini.mjs` 다 (playwright.config 의 webServer). 백엔드는
 * `GEMINI_BASE_URL` 로 그쪽을 보고 있고 키(`e2e-test-key`)는 서버에만 있다 —
 * 브라우저가 보는 것은 `/api/ai/*` 뿐이다.
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

/** 사용자 메뉴의 「AI 도우미 사용」 토글을 켠다 (기기별 localStorage 설정). */
async function enableAi(page: Page): Promise<void> {
  await page.getByTestId("user-menu-button").click();
  await page.getByTestId("ai-toggle").locator("input").check();
  await page.getByTestId("user-menu-button").click(); // 메뉴 닫기
  await expect(page.getByTestId("ai-open")).toBeVisible({ timeout: 20_000 });
}

/** 씬에 들어간 AI 카드 요소들 (customData.aiCard 표시가 있는 것) */
async function aiCardElements(page: Page): Promise<
  Array<{ type: string; groupIds: string[]; link: string | null; text: string; query: string }>
> {
  return page.evaluate(() =>
    window
      .__excalidrawAPI!.getSceneElements()
      .filter((element) => Boolean((element.customData as { aiCard?: unknown } | undefined)?.aiCard))
      .map((element) => ({
        type: String(element.type),
        groupIds: (element.groupIds as string[]) ?? [],
        link: (element.link as string | null) ?? null,
        text: String(element.text ?? ""),
        query: String((element.customData as { aiCard: { query: string } }).aiCard.query),
      })),
  );
}

test("토글을 켜야 ✨ 가 나오고, 질문 → 미리보기 → 카드가 캔버스·협업·저장으로 이어진다", async ({
  browser,
  playwright,
}) => {
  const { aliceId, bobId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "AI 카드",
    memberIds: [aliceId, bobId],
  });
  await api.dispose();

  const url = `/s/${sessionId}/p/${pageId}`;
  const a = await openPage(browser, ALICE_STATE, url);
  const b = await openPage(browser, BOB_STATE, url);

  // 게이트: 토글이 꺼져 있으면 서버에 키가 있어도 ✨ 는 없다.
  await expect(a.page.getByTestId("ai-open")).toHaveCount(0);
  await enableAi(a.page);

  // 질문 → 미리보기
  await a.page.getByTestId("ai-open").click();
  await expect(a.page.getByTestId("ai-sheet")).toBeVisible();
  await expect(a.page.getByTestId("ai-grounding")).toBeChecked(); // 「검색 기반」 기본 ON
  await a.page.getByTestId("ai-input").fill("부산 2박 3일 코스 알려줘");
  await a.page.getByTestId("ai-submit").click();

  await expect(a.page.getByTestId("ai-preview")).toBeVisible({ timeout: 30_000 });
  await expect(a.page.getByTestId("ai-preview-title")).toHaveText("부산 2박 3일 코스");
  await expect(a.page.getByTestId("ai-preview-bullet")).toHaveCount(3);
  await expect(a.page.getByTestId("ai-source")).toHaveCount(2);
  await expect(a.page.getByTestId("ai-preview-meta")).toHaveText("Gemini · 검색 2건");

  // 키는 서버에만 있다 — 브라우저가 부른 것은 /api/ai/ask 뿐이고, 업스트림 요청에만 키가 붙는다.
  const upstream = await a.page.request.get(`${MOCK_GEMINI_URL}/__requests`);
  const requests = (await upstream.json()).requests as Array<{
    key: string;
    grounded: boolean;
    text: string;
    system: string;
  }>;
  const last = requests.at(-1)!;
  expect(last.key).toBe("e2e-test-key");
  expect(last.grounded).toBe(true);
  expect(last.text).toContain("부산 2박 3일 코스 알려줘");
  expect(last.system).toContain("30자");

  // 캔버스에 추가 → 한 묶음의 평범한 요소가 된다.
  await a.page.getByTestId("ai-insert").click();
  await expect(a.page.getByTestId("ai-added")).toBeVisible();

  const elements = await aiCardElements(a.page);
  expect(elements.length).toBeGreaterThanOrEqual(5); // 컨테이너 + 제목 + 본문 + 출처 2 + 만든이
  expect(new Set(elements.flatMap((el) => el.groupIds)).size).toBe(1);
  expect(elements.filter((el) => el.type === "rectangle")).toHaveLength(1);
  expect(elements.every((el) => el.query === "부산 2박 3일 코스 알려줘")).toBe(true);
  expect(elements.filter((el) => el.link).map((el) => el.link)).toEqual([
    "https://busan.example.test/travel",
    "https://blog.example.test/busan",
  ]);
  expect(elements.map((el) => el.text).join("\n")).toContain("광안리");

  // 협업으로 B 에게도 그대로 간다 (AI 카드용 동기화 경로가 따로 없다는 확인).
  await expect
    .poll(async () => (await aiCardElements(b.page)).length, { timeout: 30_000 })
    .toBe(elements.length);
  expect((await aiCardElements(b.page)).filter((el) => el.link)).toHaveLength(2);

  // 저장 → 새로고침 후에도 남아 있다.
  await expect(a.page.getByTestId("save-status")).toHaveText("저장됨", { timeout: 30_000 });
  await a.page.reload();
  await waitForExcalidraw(a.page);
  await expect
    .poll(async () => (await aiCardElements(a.page)).length, { timeout: 30_000 })
    .toBe(elements.length);

  await b.close();
  await a.close();
});

test("규약을 지키지 않은 답변도 폴백 파서로 카드가 된다 (검색 기반 OFF)", async ({
  browser,
  playwright,
}) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "AI 폴백",
    memberIds: [aliceId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  await enableAi(a.page);

  await a.page.getByTestId("ai-open").click();
  await a.page.getByTestId("ai-grounding").uncheck();
  await a.page.getByTestId("ai-input").fill("규약미준수 답변을 줘");
  await a.page.getByTestId("ai-submit").click();

  await expect(a.page.getByTestId("ai-preview")).toBeVisible({ timeout: 30_000 });
  // 첫 문장이 제목, 나머지 문장이 불릿이 된다.
  await expect(a.page.getByTestId("ai-preview-title")).toHaveText("부산은 대한민국 제2의 도시이자 항구 도시입니다.");
  await expect(a.page.getByTestId("ai-preview-bullet")).toHaveCount(2);
  // 검색 기반을 껐으므로 출처가 없다.
  await expect(a.page.getByTestId("ai-source")).toHaveCount(0);
  await expect(a.page.getByTestId("ai-preview-meta")).toHaveText("Gemini · 검색 0건");

  await a.page.getByTestId("ai-insert").click();
  const elements = await aiCardElements(a.page);
  expect(elements.length).toBeGreaterThanOrEqual(3);
  expect(elements.some((el) => el.text.includes("해운대"))).toBe(true);
  expect(elements.filter((el) => el.link)).toHaveLength(0);

  await a.close();
});

test("업스트림 오류는 시트 안에 한국어로만 표시된다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "AI 오류",
    memberIds: [aliceId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  await enableAi(a.page);

  await a.page.getByTestId("ai-open").click();
  await a.page.getByTestId("ai-input").fill("업스트림오류를 내줘");
  await a.page.getByTestId("ai-submit").click();

  const error = a.page.getByTestId("ai-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("AI 서버가 오류를 돌려줬습니다");
  await expect(a.page.getByTestId("ai-preview")).toHaveCount(0);
  // 캔버스는 멀쩡하다 — 오류가 시트 밖으로 번지지 않는다.
  await expect(a.page.getByTestId("canvas-wrapper")).toBeVisible();

  await a.close();
});

/**
 * 분당 퓨즈. **이 파일의 마지막 테스트여야 한다** — 성공하면 이번 분의 한도를 다 쓰기 때문이다
 * (퓨즈는 사용자와 무관한 전체 카운터다).
 */
test("분당 퓨즈를 넘기면 시트에 한국어 오류가 뜬다", async ({ browser, playwright }) => {
  const { aliceId } = loadFixtures();
  const api = await adminApi(playwright);
  const { sessionId, pageId } = await createSessionWithPage(api, {
    name: "AI 퓨즈",
    memberIds: [aliceId],
  });
  await api.dispose();

  const a = await openPage(browser, ALICE_STATE, `/s/${sessionId}/p/${pageId}`);
  await enableAi(a.page);

  // 한도(기본 20회/분)를 API 로 빠르게 태운다 — 429 가 나올 때까지.
  const burn = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) {
      const res = await a.page.request.post("/api/ai/ask", {
        data: { pageId, prompt: `퓨즈 태우기 ${i}`, grounding: false },
      });
      if (res.status() === 429) {
        expect((await res.json()).error.code).toBe("rate");
        return;
      }
      expect(res.status()).toBe(200);
    }
    throw new Error("분당 퓨즈가 끊기지 않았습니다.");
  };

  await a.page.getByTestId("ai-open").click();
  await a.page.getByTestId("ai-input").fill("퓨즈가 끊긴 뒤의 질문");

  // 태우기와 질문 사이에 분이 바뀌면 카운터가 초기화된다 — 그때는 한 번 더 태운다.
  const error = a.page.getByTestId("ai-error");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await burn();
    await a.page.getByTestId("ai-submit").click();
    try {
      await expect(error).toBeVisible({ timeout: 15_000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }

  await expect(error).toContainText("요청이 너무 많습니다");
  await expect(a.page.getByTestId("ai-preview")).toHaveCount(0);

  await a.close();
});
