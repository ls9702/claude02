import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = resolve(here, "..", ".state");

export const ADMIN_STATE = resolve(STATE_DIR, "admin.json");
export const ALICE_STATE = resolve(STATE_DIR, "alice.json");
export const BOB_STATE = resolve(STATE_DIR, "bob.json");
const FIXTURES_FILE = resolve(STATE_DIR, "fixtures.json");

export const ACCOUNTS = {
  admin: { username: "admin", initialPassword: "admin1234", password: "adminpass1234" },
  alice: { username: "alice", password: "alicepass1234" },
  bob: { username: "bob", password: "bobpass1234" },
} as const;

export interface Fixtures {
  aliceId: string;
  bobId: string;
  s1Id: string;
  s2Id: string;
}

export function saveFixtures(data: Fixtures): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FIXTURES_FILE, JSON.stringify(data, null, 2));
}

export function loadFixtures(): Fixtures {
  if (!existsSync(FIXTURES_FILE)) throw new Error("setup 프로젝트가 먼저 실행되어야 합니다.");
  return JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** 관리자 권한으로 API 를 직접 호출하는 컨텍스트 */
export async function adminApi(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: "http://localhost:5173",
    storageState: ADMIN_STATE,
  });
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("아이디").fill(username);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

/** 관리자 API 로 세션 + 멤버 + 캔버스 페이지를 한 번에 만든다. */
export async function createSessionWithPage(
  api: APIRequestContext,
  opts: { name: string; memberIds?: string[]; pageName?: string; pageType?: "canvas" | "sheet" },
): Promise<{ sessionId: string; pageId: string }> {
  const created = await api.post("/api/admin/sessions", { data: { name: opts.name } });
  expect(created.status(), await created.text()).toBe(201);
  const sessionId = (await created.json()).session.id as string;

  for (const userId of opts.memberIds ?? []) {
    const res = await api.put(`/api/admin/sessions/${sessionId}/members/${userId}`);
    expect(res.status()).toBe(200);
  }

  const page = await api.post(`/api/sessions/${sessionId}/pages`, {
    data: { name: opts.pageName ?? "캔버스", type: opts.pageType ?? "canvas" },
  });
  expect(page.status(), await page.text()).toBe(201);
  return { sessionId, pageId: (await page.json()).page.id as string };
}

/** 관리자 API 로 세션 + 멤버 + 캔버스 페이지 여러 장을 만든다. */
export async function createSessionWithPages(
  api: APIRequestContext,
  opts: { name: string; memberIds?: string[]; pageNames: string[] },
): Promise<{ sessionId: string; pageIds: string[] }> {
  const created = await api.post("/api/admin/sessions", { data: { name: opts.name } });
  expect(created.status(), await created.text()).toBe(201);
  const sessionId = (await created.json()).session.id as string;

  for (const userId of opts.memberIds ?? []) {
    const res = await api.put(`/api/admin/sessions/${sessionId}/members/${userId}`);
    expect(res.status()).toBe(200);
  }

  const pageIds: string[] = [];
  for (const name of opts.pageNames) {
    const page = await api.post(`/api/sessions/${sessionId}/pages`, {
      data: { name, type: "canvas" },
    });
    expect(page.status(), await page.text()).toBe(201);
    pageIds.push((await page.json()).page.id as string);
  }
  return { sessionId, pageIds };
}

/** Excalidraw 가 마운트되어 테스트 훅이 준비될 때까지 기다린다. */
export async function waitForExcalidraw(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI && window.__excalidrawLib), null, {
    timeout: 60_000,
  });
}

/** 상단 탭 바의 "접속 N명" 배지가 기대값이 될 때까지 기다린다. */
export async function expectCollaborators(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("collab-count")).toHaveText(`접속 ${count}명`, {
    timeout: 30_000,
  });
}

/** 캔버스에 사각형 하나를 추가하고 그 id 를 돌려준다. */
export async function addRectangle(
  page: Page,
  box: { x: number; y: number; width?: number; height?: number },
): Promise<string> {
  return page.evaluate((rect) => {
    const api = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const created = lib.convertToExcalidrawElements([
      {
        type: "rectangle",
        x: rect.x,
        y: rect.y,
        width: rect.width ?? 100,
        height: rect.height ?? 60,
      },
    ]);
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...created] });
    return String(created[0]!.id);
  }, box);
}

/** 협업으로 넘어온 요소가 보일 때까지 기다린다. */
export async function expectElementVisible(page: Page, elementId: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) => window.__excalidrawAPI!.getSceneElements().some((el) => el.id === id),
          elementId,
        ),
      { timeout },
    )
    .toBe(true);
}
