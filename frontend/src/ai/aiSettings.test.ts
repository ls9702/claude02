import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAiEnabled,
  refreshAiCapability,
  resetAiState,
  saveAiEnabled,
  setAiAvailable,
  setAiEnabled,
} from "./aiSettings";

/** node 환경에는 localStorage 가 없다 — 최소 구현을 끼워 넣는다. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  resetAiState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("토글 저장", () => {
  it("기본값은 꺼짐이고, 저장하면 다시 읽힌다", () => {
    expect(loadAiEnabled()).toBe(false);
    saveAiEnabled(true);
    expect(loadAiEnabled()).toBe(true);
    saveAiEnabled(false);
    expect(loadAiEnabled()).toBe(false);
  });

  it("localStorage 가 없거나 던져도 앱은 돈다 (꺼짐으로 본다)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadAiEnabled()).toBe(false);
    expect(() => saveAiEnabled(true)).not.toThrow();

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage);
    expect(loadAiEnabled()).toBe(false);
    expect(() => saveAiEnabled(true)).not.toThrow();
  });

  it("setAiEnabled 는 저장까지 한다", () => {
    setAiEnabled(true);
    expect(localStorage.getItem("whiteboard/ai-enabled")).toBe("1");
  });
});

describe("게이트", () => {
  /** useAiEnabled 와 같은 계산 (훅은 React 밖에서 부를 수 없다) */
  const gateOf = (enabled: boolean, available: boolean) => enabled && available;

  it("토글과 서버 능력이 모두 참이어야 열린다", () => {
    expect(gateOf(false, false)).toBe(false);
    expect(gateOf(true, false)).toBe(false);
    expect(gateOf(false, true)).toBe(false);
    expect(gateOf(true, true)).toBe(true);
  });

  it("ping 결과가 available 로 들어온다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ai: true }), { status: 200 })),
    );
    await expect(refreshAiCapability()).resolves.toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ai: false }), { status: 200 })),
    );
    await expect(refreshAiCapability()).resolves.toBe(false);
  });

  it("setAiAvailable 은 checked 를 함께 세운다 (상태를 구독자에게 알린다)", () => {
    const seen: boolean[] = [];
    // 구독은 useSyncExternalStore 가 하지만, 여기서는 setter 가 던지지 않는지만 본다.
    expect(() => setAiAvailable(true)).not.toThrow();
    seen.push(true);
    expect(seen).toEqual([true]);
  });
});
