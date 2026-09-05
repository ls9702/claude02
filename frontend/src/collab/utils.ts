/**
 * excalidraw 내부 유틸 사본.
 *
 * 아래 함수들은 excalidraw.com 협업 코드가 `@excalidraw/common`,
 * `@excalidraw/element`, `@excalidraw/excalidraw/data/restore`,
 * `@excalidraw/excalidraw/reactUtils` 에서 가져다 쓰지만 npm 배포본
 * (`@excalidraw/excalidraw` 0.18.1)은 타입만 노출하고 JS 는 내보내지 않는다.
 * 그래서 원본(MIT)을 그대로 옮겼다. 동작을 바꾸지 않는다.
 */
import { bumpVersion } from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  InitializedExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";
import { unstable_batchedUpdates } from "react-dom";

// ---- @excalidraw/common: utils ------------------------------------------

/**
 * 인자를 하나만 받는(또는 받지 않는) 핸들러를 requestAnimationFrame 한 프레임에
 * 한 번만 실행하도록 묶는다.
 */
export const throttleRAF = <T extends unknown[]>(
  fn: (...args: T) => void,
  opts?: { trailing?: boolean },
) => {
  let timerId: number | null = null;
  let lastArgs: T | null = null;
  let lastArgsTrailing: T | null = null;

  const scheduleFunc = (args: T) => {
    timerId = window.requestAnimationFrame(() => {
      timerId = null;
      fn(...args);
      lastArgs = null;
      if (lastArgsTrailing) {
        lastArgs = lastArgsTrailing;
        lastArgsTrailing = null;
        scheduleFunc(lastArgs);
      }
    });
  };

  const ret = (...args: T) => {
    lastArgs = args;
    if (timerId === null) {
      scheduleFunc(lastArgs);
    } else if (opts?.trailing) {
      lastArgsTrailing = args;
    }
  };
  ret.flush = () => {
    if (timerId !== null) {
      cancelAnimationFrame(timerId);
      timerId = null;
    }
    if (lastArgs) {
      const _lastArgs = lastArgs;
      const _lastArgsTrailing = lastArgsTrailing;
      lastArgs = null;
      lastArgsTrailing = null;
      fn(...(_lastArgsTrailing || _lastArgs));
    }
  };
  ret.cancel = () => {
    lastArgs = null;
    lastArgsTrailing = null;
    if (timerId !== null) {
      cancelAnimationFrame(timerId);
      timerId = null;
    }
  };
  return ret;
};

export type ResolvablePromise<T> = Promise<T> & {
  resolve: [T] extends [undefined] ? (value?: T) => void : (value: T) => void;
  reject: (error: Error) => void;
};

export const resolvablePromise = <T>(): ResolvablePromise<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  (promise as ResolvablePromise<T>).resolve = resolve as ResolvablePromise<T>["resolve"];
  (promise as ResolvablePromise<T>).reject = reject;
  return promise as ResolvablePromise<T>;
};

/** 브라우저에 "정말 나가시겠습니까?" 를 띄운다 (문구는 브라우저가 정한다). */
export const preventUnload = (event: BeforeUnloadEvent): void => {
  event.preventDefault();
  // NOTE: modern browsers no longer allow showing a custom message here
  event.returnValue = "";
};

export const cloneJSON = <T>(obj: T): T => JSON.parse(JSON.stringify(obj)) as T;

/** 브랜드 타입으로 캐스팅만 하는 헬퍼 (런타임 동작 없음). */
export const toBrandedType = <BrandedType, ExistingType = unknown>(value: ExistingType) =>
  value as unknown as BrandedType;

export const assertNever = (value: never, message: string | null): never => {
  if (message) throw new Error(message);
  return value;
};

export const arrayToMap = <T extends { id: string }>(
  items: readonly T[] | Map<string, T>,
): Map<string, T> => {
  if (items instanceof Map) return items;
  return items.reduce((acc, element) => {
    acc.set(element.id, element);
    return acc;
  }, new Map<string, T>());
};

// ---- @excalidraw/excalidraw/reactUtils ----------------------------------

/** React 상태 갱신을 한 번에 묶는다 (핸들러는 인자 0~1개). */
export const withBatchedUpdates = <TFunction extends ((event: never) => void) | (() => void)>(
  func: Parameters<TFunction>["length"] extends 0 | 1 ? TFunction : never,
): TFunction =>
  ((event: never) => {
    unstable_batchedUpdates(func as (event: never) => void, event);
  }) as TFunction;

// ---- @excalidraw/element: typeChecks ------------------------------------

export const isImageElement = (
  element: ExcalidrawElement | null,
): element is ExcalidrawImageElement => !!element && element.type === "image";

export const isInitializedImageElement = (
  element: ExcalidrawElement | null,
): element is InitializedExcalidrawImageElement =>
  !!element && element.type === "image" && !!element.fileId;

// ---- @excalidraw/excalidraw/data/restore --------------------------------

/**
 * 병합 결과 요소의 version 을 로컬 요소보다 뒤로 밀리지 않게 올린다.
 * 출처: `packages/excalidraw/data/restore.ts` 의 `bumpElementVersions`.
 */
export const bumpElementVersions = <T extends ExcalidrawElement>(
  targetElements: readonly T[],
  localElements: readonly ExcalidrawElement[] | null | undefined,
): T[] => {
  const localElementsMap = localElements ? arrayToMap(localElements) : null;

  return targetElements.map((element) => {
    const localElement = localElementsMap?.get(element.id);

    if (
      localElement &&
      (localElement.version > element.version ||
        // same versions but different versionNonce means different edits
        // (this often means the element was bumped during restore e.g. due
        // to re-indexing, and the original element was modified elsewhere
        // and supplied as localElements)
        (localElement.version === element.version &&
          localElement.versionNonce !== element.versionNonce))
    ) {
      return bumpVersion(element, localElement.version);
    }
    return element;
  });
};
