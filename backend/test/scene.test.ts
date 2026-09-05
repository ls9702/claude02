import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SNAPSHOTS_PER_PAGE } from "../src/config.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, authHeaders, createTestApp, login, type TestApp } from "./helpers.js";

let ctx: TestApp;
let sid: string;
let pageId: string;

const el = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  version,
  versionNonce,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
});

beforeEach(async () => {
  ctx = await createTestApp();
  sid = await login(ctx.app, ADMIN_USERNAME, ADMIN_PASSWORD);
  const session = (
    await ctx.app.inject({
      method: "POST",
      url: "/api/admin/sessions",
      headers: authHeaders(sid),
      payload: { name: "테스트 세션" },
    })
  ).json().session;
  pageId = (
    await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/pages`,
      headers: authHeaders(sid),
      payload: { name: "캔버스", type: "canvas" },
    })
  ).json().page.id;
});

afterEach(async () => {
  await ctx.close();
});

const putScene = (elements: unknown[], appState: Record<string, unknown> = {}) =>
  ctx.app.inject({
    method: "PUT",
    url: `/api/pages/${pageId}/scene`,
    headers: authHeaders(sid),
    payload: { elements, appState },
  });

describe("씬 저장/불러오기", () => {
  it("빈 씬으로 시작하고 저장할 때마다 version 이 올라간다", async () => {
    const initial = (await ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/scene`, headers: authHeaders(sid) })).json();
    expect(initial).toMatchObject({ elements: [], version: 0 });

    expect((await putScene([el("a", 1, 10)])).json().version).toBe(1);
    expect((await putScene([el("a", 2, 10)])).json().version).toBe(2);
  });

  it("두 클라이언트의 저장을 요소 단위로 병합한다", async () => {
    await putScene([el("a", 1, 10)]);
    // 다른 클라이언트가 b 를 추가하며 a 는 옛 버전으로 보낸다.
    const res = await putScene([el("a", 1, 10), el("b", 1, 20)]);
    expect(res.json().elements.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);

    // 낡은 클라이언트가 b 를 모르는 채로 저장 → 서버가 b 를 되돌려 준다.
    const stale = await putScene([el("a", 1, 10)]);
    const body = stale.json();
    expect(body.elements.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
    expect(body.changed).toBe(true);
  });

  it("병합 결과가 보낸 것과 같으면 changed=false", async () => {
    await putScene([el("a", 1, 10)]);
    const res = await putScene([el("a", 2, 10)]);
    expect(res.json().changed).toBe(false);
  });

  it("요소가 그대로여도 appState 만 바꾸면 저장되고 버전이 오른다", async () => {
    const element = { id: "keep-1", version: 1, versionNonce: 10 };
    const first = await putScene([element], { viewBackgroundColor: "#ffffff" });
    expect(first.statusCode).toBe(200);
    const firstVersion = first.json().version as number;

    const second = await putScene([element], { viewBackgroundColor: "#7b3de7", gridModeEnabled: true });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(firstVersion + 1);
    expect(second.json().appState).toMatchObject({
      viewBackgroundColor: "#7b3de7",
      gridModeEnabled: true,
    });

    const scene = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/pages/${pageId}/scene`,
        headers: authHeaders(sid),
      })
    ).json();
    expect(scene.appState.viewBackgroundColor).toBe("#7b3de7");
    expect(scene.appState.gridModeEnabled).toBe(true);
  });

  it("appState 는 공유 가능한 키만 저장한다", async () => {
    await putScene([], { viewBackgroundColor: "#ffeedd", scrollX: 999, selectedElementIds: { a: true } });
    const scene = (await ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/scene`, headers: authHeaders(sid) })).json();
    expect(scene.appState).toEqual({ viewBackgroundColor: "#ffeedd" });
  });

  it("elements 가 배열이 아니면 400", async () => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/scene`,
      headers: authHeaders(sid),
      payload: { elements: { a: 1 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("시트 페이지의 씬 API 는 400", async () => {
    const sessionId = ctx.app.db.prepare<[string], { session_id: string }>("SELECT session_id FROM pages WHERE id = ?").get(pageId)!.session_id;
    const sheet = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pages`,
        headers: authHeaders(sid),
        payload: { name: "장부", type: "sheet" },
      })
    ).json().page;
    const res = await ctx.app.inject({ method: "GET", url: `/api/pages/${sheet.id}/scene`, headers: authHeaders(sid) });
    expect(res.statusCode).toBe(400);
  });
});

describe("스냅샷", () => {
  it("첫 저장에 스냅샷이 생기고 페이지당 최대 개수를 유지한다", async () => {
    for (let i = 1; i <= MAX_SNAPSHOTS_PER_PAGE * 2 + 5; i += 1) {
      await putScene([el("a", i, 10)]);
    }
    const snaps = (
      await ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/snapshots`, headers: authHeaders(sid) })
    ).json().snapshots as Array<{ id: string }>;
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.length).toBeLessThanOrEqual(MAX_SNAPSHOTS_PER_PAGE);
  });

  it("스냅샷을 복원하면 그 시점 요소로 되돌아간다", async () => {
    await putScene([el("a", 1, 10, { text: "처음" })]);
    const snaps = (
      await ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/snapshots`, headers: authHeaders(sid) })
    ).json().snapshots as Array<{ id: string }>;
    expect(snaps.length).toBeGreaterThan(0);

    await putScene([el("a", 5, 10, { text: "나중" }), el("b", 1, 1)]);

    const restore = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/snapshots/${snaps[0]!.id}/restore`,
      headers: authHeaders(sid),
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().elements.map((e: { id: string }) => e.id)).toEqual(["a"]);
  });

  it("없는 스냅샷 복원은 404", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/snapshots/nope/restore`,
      headers: authHeaders(sid),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("썸네일", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  it("PNG 를 저장하고 다시 읽는다", async () => {
    const put = await ctx.app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/thumbnail`,
      headers: { ...authHeaders(sid), "content-type": "image/png" },
      payload: PNG,
    });
    expect(put.statusCode).toBe(200);

    const get = await ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/thumbnail`, headers: authHeaders(sid) });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.rawPayload.equals(PNG)).toBe(true);
  });

  it("썸네일이 없으면 404", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/pages/${pageId}/thumbnail`, headers: authHeaders(sid) });
    expect(res.statusCode).toBe(404);
  });

  it("200KB 를 넘으면 413", async () => {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/thumbnail`,
      headers: { ...authHeaders(sid), "content-type": "image/png" },
      payload: Buffer.alloc(210 * 1024, 1),
    });
    expect(res.statusCode).toBe(413);
  });
});
