import { beforeAll, describe, expect, it, vi } from "vitest";

// utils.ts 는 `bumpVersion` 하나 때문에 `@excalidraw/excalidraw` 를 끌어온다.
// 그 번들은 node 환경에서 로드되지 않으므로(roughjs 등) 최소 구현으로 대체한다.
vi.mock("@excalidraw/excalidraw", () => ({
  bumpVersion: (element: { version: number }, version?: number) => ({
    ...element,
    version: (version ?? element.version) + 1,
    versionNonce: 999,
  }),
}));

beforeAll(() => {
  const globalAny = globalThis as unknown as {
    window?: unknown;
    requestAnimationFrame?: unknown;
    cancelAnimationFrame?: unknown;
  };
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  globalAny.requestAnimationFrame = (cb: () => void): number => {
    const id = nextId++;
    timers.set(id, setTimeout(cb, 0));
    return id;
  };
  globalAny.cancelAnimationFrame = (id: number): void => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };
  globalAny.window = globalThis;
});

const load = () => import("./utils");

const el = (id: string, version: number, versionNonce = 1) =>
  ({ id, version, versionNonce }) as never;

describe("collab/utils", () => {
  it("resolvablePromise 는 밖에서 resolve 할 수 있다", async () => {
    const { resolvablePromise } = await load();
    const promise = resolvablePromise<number>();
    promise.resolve(42);
    await expect(promise).resolves.toBe(42);
  });

  it("resolvablePromise 는 밖에서 reject 할 수 있다", async () => {
    const { resolvablePromise } = await load();
    const promise = resolvablePromise<number>();
    promise.reject(new Error("실패"));
    await expect(promise).rejects.toThrow("실패");
  });

  it("throttleRAF 는 한 프레임에 한 번만 실행한다", async () => {
    const { throttleRAF } = await load();
    const fn = vi.fn();
    const throttled = throttleRAF(fn);
    throttled(1);
    throttled(2);
    throttled(3);
    expect(fn).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fn).toHaveBeenCalledTimes(1);
    // 업스트림과 같은 의미: 예약 시점(첫 호출)의 인자로 실행된다.
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("throttleRAF.cancel 은 예약된 실행을 없앤다", async () => {
    const { throttleRAF } = await load();
    const fn = vi.fn();
    const throttled = throttleRAF(fn);
    throttled();
    throttled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fn).not.toHaveBeenCalled();
  });

  it("throttleRAF.flush 는 즉시 실행한다", async () => {
    const { throttleRAF } = await load();
    const fn = vi.fn();
    const throttled = throttleRAF(fn);
    throttled("x");
    throttled.flush();
    expect(fn).toHaveBeenCalledWith("x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("arrayToMap 은 id 로 색인한다", async () => {
    const { arrayToMap } = await load();
    const map = arrayToMap([{ id: "a" }, { id: "b" }]);
    expect([...map.keys()]).toEqual(["a", "b"]);
    // Map 을 그대로 주면 그대로 돌려준다.
    expect(arrayToMap(map)).toBe(map);
  });

  it("cloneJSON 은 깊은 복사를 한다", async () => {
    const { cloneJSON } = await load();
    const source = { a: { b: [1, 2] } };
    const copy = cloneJSON(source);
    expect(copy).toEqual(source);
    expect(copy.a).not.toBe(source.a);
  });

  it("isImageElement / isInitializedImageElement", async () => {
    const { isImageElement, isInitializedImageElement } = await load();
    const rect = { type: "rectangle" } as never;
    const pending = { type: "image", fileId: null } as never;
    const ready = { type: "image", fileId: "f1" } as never;

    expect(isImageElement(rect)).toBe(false);
    expect(isImageElement(pending)).toBe(true);
    expect(isInitializedImageElement(pending)).toBe(false);
    expect(isInitializedImageElement(ready)).toBe(true);
    expect(isInitializedImageElement(null)).toBe(false);
  });

  it("bumpElementVersions 는 로컬 버전이 더 높을 때만 올린다", async () => {
    const { bumpElementVersions } = await load();
    const local = [el("a", 5), el("b", 2), el("c", 3, 7)];
    const target = [el("a", 3), el("b", 9), el("c", 3, 8)];

    const result = bumpElementVersions(target, local) as unknown as Array<{
      id: string;
      version: number;
    }>;

    // a: 로컬(5) > 대상(3) → 로컬 버전 기준으로 올린다
    expect(result[0]).toMatchObject({ id: "a", version: 6 });
    // b: 로컬(2) < 대상(9) → 그대로
    expect(result[1]).toMatchObject({ id: "b", version: 9 });
    // c: 버전 같고 versionNonce 다름 → 올린다
    expect(result[2]).toMatchObject({ id: "c", version: 4 });
  });

  it("bumpElementVersions 는 로컬이 없으면 그대로 둔다", async () => {
    const { bumpElementVersions } = await load();
    const target = [el("a", 3)];
    expect(bumpElementVersions(target, null)).toEqual(target);
  });

  it("preventUnload 는 returnValue 를 세운다", async () => {
    const { preventUnload } = await load();
    const event = { preventDefault: vi.fn(), returnValue: undefined } as unknown as BeforeUnloadEvent;
    preventUnload(event);
    expect(event.returnValue).toBe("");
  });
});
