import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  ADMIN_STATE,
  ALICE_STATE,
  BOB_STATE,
  ensureStateDir,
  login,
  saveFixtures,
} from "./fixtures";

/**
 * 시나리오 1 — 관리자 로그인 → 강제 비밀번호 변경 → 사용자 A·B 생성 →
 * 세션 S1(A만), S2(A·B) 생성·할당. 이후 테스트가 쓸 storageState 도 저장한다.
 */
test("관리자 부트스트랩: 강제 비밀번호 변경, 사용자·세션 생성", async ({ page, context }) => {
  ensureStateDir();

  // 최초 관리자 로그인 → 비밀번호 변경 화면으로 강제 이동
  await login(page, ACCOUNTS.admin.username, ACCOUNTS.admin.initialPassword);
  await expect(page).toHaveURL(/\/password$/);
  await expect(page.getByRole("heading", { name: "비밀번호 변경" })).toBeVisible();
  await expect(page.getByText("최초 로그인 시 비밀번호를 변경해야 합니다", { exact: false })).toBeVisible();

  await page.getByLabel("현재 비밀번호").fill(ACCOUNTS.admin.initialPassword);
  await page.getByLabel("새 비밀번호 (8자 이상)").fill(ACCOUNTS.admin.password);
  await page.getByLabel("새 비밀번호 확인").fill(ACCOUNTS.admin.password);
  await page.getByRole("button", { name: "비밀번호 변경" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "내 세션" })).toBeVisible();

  // 관리자 화면에서 사용자 2명 생성
  await page.goto("/admin");
  await expect(page.getByTestId("create-user-form")).toBeVisible();

  for (const account of [ACCOUNTS.alice, ACCOUNTS.bob]) {
    await page.getByTestId("new-user-username").fill(account.username);
    await page.getByTestId("new-user-password").fill(account.password);
    await page.getByTestId("new-user-submit").click();
    await expect(page.locator(`[data-testid="user-row"][data-username="${account.username}"]`)).toBeVisible();
    // 폼이 초기화될 때까지 기다린 뒤 다음 사용자를 입력한다.
    await expect(page.getByTestId("new-user-username")).toHaveValue("");
  }

  // 세션 2개 생성
  await page.getByTestId("admin-tab-sessions").click();
  let expectedCount = 0;
  for (const name of ["S1", "S2"]) {
    await page.getByTestId("new-session-name").fill(name);
    await page.getByTestId("new-session-submit").click();
    expectedCount += 1;
    await expect(page.getByTestId("admin-session")).toHaveCount(expectedCount);
    await expect(page.getByTestId("new-session-name")).toHaveValue("");
  }

  // 멤버 할당: S1 = alice, S2 = alice + bob
  const sessions = page.getByTestId("admin-session");
  const s1 = sessions.nth(0);
  const s2 = sessions.nth(1);

  // 제어 컴포넌트라 클릭 후 서버 반영까지 기다렸다가 다음 클릭으로 넘어간다.
  const assign = async (session: typeof s1, username: string) => {
    const box = session.locator(`[data-testid="member-checkbox"][data-username="${username}"] input`);
    await box.click();
    await expect(box).toBeChecked();
  };

  await assign(s1, "alice");
  await assign(s2, "alice");
  await assign(s2, "bob");
  await expect(s1.locator('[data-testid="member-checkbox"][data-username="bob"] input')).not.toBeChecked();

  // id 수집 (API 로 확인)
  const usersRes = await page.request.get("/api/admin/users");
  const users = (await usersRes.json()).users as Array<{ id: string; username: string }>;
  const sessionsRes = await page.request.get("/api/admin/sessions");
  const sessionList = (await sessionsRes.json()).sessions as Array<{ id: string; name: string; memberIds: string[] }>;

  const alice = users.find((u) => u.username === "alice")!;
  const bob = users.find((u) => u.username === "bob")!;
  const s1Row = sessionList.find((s) => s.name === "S1")!;
  const s2Row = sessionList.find((s) => s.name === "S2")!;

  expect(s1Row.memberIds).toEqual([alice.id]);
  expect(s2Row.memberIds.sort()).toEqual([alice.id, bob.id].sort());

  saveFixtures({ aliceId: alice.id, bobId: bob.id, s1Id: s1Row.id, s2Id: s2Row.id });
  await context.storageState({ path: ADMIN_STATE });
});

test("사용자 A·B 로그인 상태 저장", async ({ browser }) => {
  for (const [account, statePath] of [
    [ACCOUNTS.alice, ALICE_STATE],
    [ACCOUNTS.bob, BOB_STATE],
  ] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, account.username, account.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "내 세션" })).toBeVisible();
    await context.storageState({ path: statePath });
    await context.close();
  }
});
