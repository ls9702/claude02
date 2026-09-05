import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 로그인 상태·픽스처를 두는 곳. 기본은 `e2e/.state` 다.
 * 프로덕션 스모크(`playwright.prod.config.ts`)는 다른 DB·다른 포트로 도는 별개 실행이라
 * `E2E_STATE_DIR` 로 `.state-prod` 를 쓴다 — dev e2e 의 상태를 덮어쓰지 않게 한다.
 */
export const STATE_DIR = resolve(here, "..", process.env.E2E_STATE_DIR ?? ".state");
/** 앱 오리진. dev 는 Vite(5173), 프로덕션 스모크는 app 이 직접 서빙한다(3901). */
export const APP_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

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
    baseURL: APP_BASE_URL,
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
  opts: {
    name: string;
    memberIds?: string[];
    pageName?: string;
    pageType?: "canvas" | "sheet";
    /** 시트 페이지일 때의 템플릿 (기본 blank) */
    template?: "blank" | "ledger";
  },
): Promise<{ sessionId: string; pageId: string }> {
  const created = await api.post("/api/admin/sessions", { data: { name: opts.name } });
  expect(created.status(), await created.text()).toBe(201);
  const sessionId = (await created.json()).session.id as string;

  for (const userId of opts.memberIds ?? []) {
    const res = await api.put(`/api/admin/sessions/${sessionId}/members/${userId}`);
    expect(res.status()).toBe(200);
  }

  const page = await api.post(`/api/sessions/${sessionId}/pages`, {
    data: {
      name: opts.pageName ?? "캔버스",
      type: opts.pageType ?? "canvas",
      ...(opts.pageType === "sheet" ? { template: opts.template ?? "blank" } : {}),
    },
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

// ---- 댓글 (M3) ----------------------------------------------------------

/** 씬 좌표를 현재 뷰포트의 클라이언트 좌표로 바꾼다 (오버레이와 같은 공식). */
export async function sceneToClient(
  page: Page,
  scene: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate((point) => {
    const state = window.__excalidrawAPI!.getAppState() as unknown as {
      zoom: { value: number };
      scrollX: number;
      scrollY: number;
      offsetLeft: number;
      offsetTop: number;
    };
    return {
      x: (point.x + state.scrollX) * state.zoom.value + state.offsetLeft,
      y: (point.y + state.scrollY) * state.zoom.value + state.offsetTop,
    };
  }, scene);
}

/** "💬 댓글" 모드로 씬 좌표를 클릭해 댓글을 남긴다. */
export async function addComment(
  page: Page,
  scene: { x: number; y: number },
  body: string,
): Promise<void> {
  await page.getByTestId("comment-mode").click();
  const point = await sceneToClient(page, scene);
  await page.mouse.click(point.x, point.y);
  await page.getByTestId("comment-input").fill(body);
  await page.getByTestId("comment-submit").click();
  await expect(page.getByTestId("comment-composer")).toHaveCount(0);
}

/** 핀의 화면 위치 (없으면 null) */
export async function pinPosition(
  page: Page,
  commentId?: string,
): Promise<{ x: number; y: number } | null> {
  const pin = commentId
    ? page.locator(`[data-testid="comment-pin"][data-comment-id="${commentId}"]`)
    : page.getByTestId("comment-pin").first();
  const box = await pin.boundingBox();
  return box ? { x: Math.round(box.x), y: Math.round(box.y) } : null;
}

/** 요소를 씬에서 옮긴다 (협업 병합을 위해 version 을 올린다). */
export async function moveElement(
  page: Page,
  elementId: string,
  delta: { dx: number; dy: number },
): Promise<void> {
  await page.evaluate(
    ({ id, dx, dy }) => {
      const api = window.__excalidrawAPI!;
      const lib = window.__excalidrawLib!;
      const next = api.getSceneElementsIncludingDeleted().map((el) =>
        el.id === id ? lib.newElementWith(el, { x: Number(el.x) + dx, y: Number(el.y) + dy }) : el,
      );
      api.updateScene({ elements: next });
    },
    { id: elementId, ...delta },
  );
}

/** 요소를 삭제 표시한다 (Excalidraw 의 삭제와 같은 형태). */
export async function deleteElement(page: Page, elementId: string): Promise<void> {
  await page.evaluate((id) => {
    const api = window.__excalidrawAPI!;
    const lib = window.__excalidrawLib!;
    const next = api.getSceneElementsIncludingDeleted().map((el) =>
      el.id === id ? lib.newElementWith(el, { isDeleted: true }) : el,
    );
    api.updateScene({ elements: next });
  }, elementId);
}

// ---- 시트 (M5) ----------------------------------------------------------

/** 회비 장부 템플릿의 열 너비(px) — `backend/src/sheets/templates.ts` 와 같은 값이어야 한다. */
const LEDGER_COLUMN_WIDTHS = [100, 70, 190, 110, 90, 200, 90, 24, 90, 100, 100, 100];
/** Fortune-sheet 기본 행 높이(px)와 장부 템플릿의 머리글 행 높이(rowlen[0]) */
const ROW_HEIGHT = 20;
const FIRST_ROW_HEIGHT = 24;

/** 시트가 마운트되고 초기 수식 계산이 끝날 때까지 기다린다. */
export async function waitForSheet(page: Page): Promise<void> {
  await expect(page.getByTestId("sheet-wrapper")).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__sheetReady && window.__sheetRef?.current), null, {
    timeout: 60_000,
  });
  // 첫 계산(마운트 150ms 뒤 + 2패스)이 끝나기를 기다린다.
  await page.waitForTimeout(1_200);
}

/** 현재 시트의 셀 값을 읽는다 (0-index). */
export async function cellValue(
  page: Page,
  r: number,
  c: number,
): Promise<{ v: unknown; m: unknown; f: unknown } | null> {
  return page.evaluate(
    ({ r: row, c: col }) => {
      const api = window.__sheetRef?.current;
      if (!api) return null;
      const sheet = api.getAllSheets()[0];
      const cell = sheet?.data?.[row]?.[col];
      if (!cell) return null;
      return { v: cell.v ?? null, m: cell.m ?? null, f: cell.f ?? null };
    },
    { r, c },
  );
}

/** 셀 값이 기대한 값이 될 때까지 기다린다. */
export async function expectCellValue(
  page: Page,
  r: number,
  c: number,
  expected: unknown,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(async () => (await cellValue(page, r, c))?.v ?? null, { timeout })
    .toBe(expected);
}

/**
 * 장부 시트에서 (r, c) 셀의 화면 좌표 (0-index).
 * 격자 원점은 `.fortune-cell-area`(행/열 머리글을 뺀 영역)에서 읽는다 —
 * 자체 툴바·수식 입력줄 높이가 바뀌어도 좌표가 어긋나지 않는다.
 */
async function ledgerCellPoint(
  page: Page,
  r: number,
  c: number,
): Promise<{ x: number; y: number }> {
  const box = await page.locator(".fortune-cell-area").first().boundingBox();
  if (!box) throw new Error("시트 격자 영역(.fortune-cell-area)을 찾지 못했습니다.");
  let x = box.x;
  for (let i = 0; i < c; i += 1) x += LEDGER_COLUMN_WIDTHS[i] ?? 73;
  x += (LEDGER_COLUMN_WIDTHS[c] ?? 73) / 2;

  let y = box.y;
  for (let i = 0; i < r; i += 1) y += i === 0 ? FIRST_ROW_HEIGHT : ROW_HEIGHT;
  y += (r === 0 ? FIRST_ROW_HEIGHT : ROW_HEIGHT) / 2;
  return { x, y };
}

/** 이름 상자(A1 표시)의 현재 값 */
export async function selectedCellName(page: Page): Promise<string> {
  return (await page.locator(".fortune-name-box").first().innerText()).trim();
}

/**
 * 장부 시트의 셀을 실제로 클릭해 값을 입력한다.
 * `구분` 열처럼 드롭다운(데이터 유효성)이 걸린 셀은 한 번 클릭으로는 입력이 먹지 않아
 * 더블클릭으로 편집 모드에 들어간다.
 */
export async function typeIntoLedgerCell(
  page: Page,
  r: number,
  c: number,
  value: string,
  opts: { doubleClick?: boolean } = {},
): Promise<void> {
  const point = await ledgerCellPoint(page, r, c);
  if (opts.doubleClick) await page.mouse.dblclick(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(150);
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
}
