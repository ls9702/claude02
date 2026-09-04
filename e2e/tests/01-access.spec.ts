import { expect, test } from "@playwright/test";
import { ACCOUNTS, ALICE_STATE, BOB_STATE, loadFixtures, login } from "./fixtures";

const fx = () => loadFixtures();

/** 시나리오 2 — 세션 할당에 따른 목록/직접 접근 제어 */
test.describe("세션 접근 제어", () => {
  test("A 는 S1·S2 를 모두 본다", async ({ browser }) => {
    const context = await browser.newContext({ storageState: ALICE_STATE });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("session-card")).toHaveCount(2);
    await expect(page.getByTestId("session-card").filter({ hasText: "S1" })).toBeVisible();
    await expect(page.getByTestId("session-card").filter({ hasText: "S2" })).toBeVisible();
    await context.close();
  });

  test("B 는 S2 만 보이고 S1 직접 접근은 차단된다", async ({ browser }) => {
    const { s1Id } = fx();
    const context = await browser.newContext({ storageState: BOB_STATE });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.getByTestId("session-card")).toHaveCount(1);
    await expect(page.getByTestId("session-card").filter({ hasText: "S2" })).toBeVisible();
    await expect(page.getByTestId("session-card").filter({ hasText: "S1" })).toHaveCount(0);

    // URL 직접 접근 → 403 화면
    await page.goto(`/s/${s1Id}`);
    await expect(page.getByRole("heading", { name: "접근 권한이 없습니다" })).toBeVisible();

    // API 직접 호출도 403
    const res = await page.request.get(`/api/sessions/${s1Id}`);
    expect(res.status()).toBe(403);
    expect((await res.json()).error.message).toBe("이 세션에 접근할 권한이 없습니다.");

    await context.close();
  });
});

/** 시나리오 3 — 로그인 유지 (쿠키 기반 storageState) */
test.describe("로그인 유지", () => {
  test("storageState 를 새 컨텍스트에 실어도 로그인 상태가 유지된다", async ({ browser }) => {
    const context = await browser.newContext({ storageState: ALICE_STATE });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "내 세션" })).toBeVisible();
    await expect(page.getByTestId("user-menu-button")).toContainText("alice");
    await context.close();
  });

  test("로그아웃하면 다시 로그인 화면으로 간다", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ACCOUNTS.bob.username, ACCOUNTS.bob.password);
    await expect(page.getByRole("heading", { name: "내 세션" })).toBeVisible();

    await page.getByTestId("user-menu-button").click();
    await page.getByTestId("logout-button").click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await context.close();
  });

  test("비로그인 상태로 세션 URL 에 가면 로그인 화면으로 보낸다", async ({ browser }) => {
    const { s2Id } = fx();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/s/${s2Id}`);
    await expect(page).toHaveURL(/\/login$/);
    await context.close();
  });
});
