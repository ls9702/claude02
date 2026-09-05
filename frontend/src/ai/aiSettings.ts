/**
 * "AI 도우미 사용" 토글과 ✨ 버튼이 읽는 게이트 (claude01 `src/ai/aiSettings.ts` 이식).
 *
 * ✨ 가 화면에 나오려면 **세 가지가 모두** 참이어야 한다.
 *   1. 사용자가 토글을 켰다      — 여기(localStorage, 기기별)
 *   2. 서버에 Gemini 키가 있다   — `GET /api/ai/ping`
 *   3. 그 계정이 AI 를 쓸 수 있다 — 같은 ping (`users.ai_allowed`, 관리자가 끌 수 있다)
 *
 * 토글은 **기기별 선호**라 서버로 보내지 않고 localStorage 에 둔다(막힌 환경에서도 앱은 돈다).
 * ping 결과는 세션 상태라 저장하지 않는다 — 지난주에 캐시한 "키가 있었다" 보다 ping 한 번이 낫다.
 *
 * zustand 를 쓰지 않는 저장소라 `useSyncExternalStore` 로 최소한의 스토어를 직접 만든다.
 */
import { useCallback, useSyncExternalStore } from "react";
import { pingAi } from "./aiClient";

const STORAGE_KEY = "whiteboard/ai-enabled";

/** localStorage, 또는 없거나 막혔으면 null */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 저장된 토글 값 (읽지 못하면 꺼짐) */
export function loadAiEnabled(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 토글 저장. 실패는 무시한다 — 선호 값일 뿐이다. */
export function saveAiEnabled(enabled: boolean): void {
  try {
    storage()?.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* 용량 초과 / 사생활 보호 모드 */
  }
}

export interface AiState {
  /** 사용자의 토글 (저장됨) */
  enabled: boolean;
  /** 마지막 ping 이 키를 찾았는가 (세션 한정) */
  available: boolean;
  /** 이번 세션에 ping 이 한 번이라도 끝났는가 */
  checked: boolean;
}

let state: AiState = { enabled: loadAiEnabled(), available: false, checked: false };
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getState = (): AiState => state;

export function setAiEnabled(enabled: boolean): void {
  if (state.enabled === enabled) return;
  saveAiEnabled(enabled);
  state = { ...state, enabled };
  emit();
}

export function setAiAvailable(available: boolean): void {
  if (state.available === available && state.checked) return;
  state = { ...state, available, checked: true };
  emit();
}

/** 테스트용 초기화 (모듈 상태를 쓰는 스토어라 명시적으로 되돌린다) */
export function resetAiState(): void {
  state = { enabled: loadAiEnabled(), available: false, checked: false };
  emit();
}

/**
 * 서버에 한 번 물어 능력을 갱신한다.
 * 앱 시작(로그인 후)과 토글을 켤 때 부른다 — 그 밖에는 다시 묻지 않는다.
 */
export async function refreshAiCapability(): Promise<boolean> {
  const available = await pingAi();
  setAiAvailable(available);
  return available;
}

/** 스토어 구독 */
export function useAiState(): AiState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 세 조건이 모두 참일 때만 true — ✨ 버튼의 표시 조건이다. */
export function useAiEnabled(): boolean {
  const { enabled, available } = useAiState();
  return enabled && available;
}

/** 토글 컴포넌트가 쓰는 setter */
export function useSetAiEnabled(): (enabled: boolean) => void {
  return useCallback((enabled: boolean) => {
    setAiEnabled(enabled);
    // 켜는 순간에만 다시 확인한다 (끌 때는 물어볼 필요가 없다).
    if (enabled) void refreshAiCapability();
  }, []);
}
