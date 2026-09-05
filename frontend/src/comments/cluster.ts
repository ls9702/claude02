/**
 * 겹친 핀 펼치기 (M3 후속 수정).
 *
 * 서로 다른 댓글이 같은 지점(같은 요소의 우상단, 같은 좌표, 고아로 수렴한 위치)에 붙으면
 * 핀이 픽셀 단위로 포개져 **나중에 그려진 핀만** 클릭을 받는다. 아래 핀은 사이드바로만
 * 열 수 있었다(m3-comments QA "중간").
 *
 * 그래서 화면 좌표가 {@link PIN_CLUSTER_RADIUS_PX} 안에서 겹치는 핀들을 한 묶음으로 보고
 * **생성 순서대로 가로로 한 칸씩 밀어** 펼친다. 한 칸({@link PIN_FAN_STEP_PX})은 핀 지름과
 * 같아서 데스크톱에서는 아예 겹치지 않고, 터치용으로 핀이 커지는 환경(40px)에서도
 * 아래 핀의 왼쪽 26px 이 항상 드러나 직접 누를 수 있다.
 *
 * 순수 함수다 — DOM·Excalidraw 를 모른다(단위 테스트 대상).
 */

/** 화면(오버레이) 좌표 */
export interface PinPlacement {
  left: number;
  top: number;
}

/** 펼친 뒤의 위치 + 몇 번째로 겹쳤는지 */
export interface FannedPlacement extends PinPlacement {
  /** 묶음 안에서의 순서 (0 이면 맨 처음 = 밀리지 않은 핀) */
  clusterIndex: number;
  /** 이 핀이 속한 묶음의 크기 (1 이면 겹치지 않았다) */
  clusterSize: number;
}

/** 이 거리(px) 안에 있으면 "겹쳤다" 고 본다. */
export const PIN_CLUSTER_RADIUS_PX = 12;

/** 겹친 핀을 한 칸 밀어내는 거리(px). 핀 지름(26px)과 같다. */
export const PIN_FAN_STEP_PX = 26;

export interface FanOutOptions {
  /** 겹침 판정 반경 (기본 {@link PIN_CLUSTER_RADIUS_PX}) */
  radius?: number;
  /** 한 칸 간격 (기본 {@link PIN_FAN_STEP_PX}) */
  step?: number;
}

interface Cluster {
  anchor: PinPlacement;
  count: number;
}

/** 두 점이 겹침 반경 안인지 (축별 거리로 판정한다 — 핀은 사각형이다). */
const overlaps = (a: PinPlacement, b: PinPlacement, radius: number): boolean =>
  Math.abs(a.left - b.left) <= radius && Math.abs(a.top - b.top) <= radius;

/**
 * 겹치는 핀을 가로로 펼친다. 입력 순서가 곧 생성 순서이고, 그 순서가 그대로 밀리는 순서다.
 *
 * 겹침 판정은 **원래 위치**끼리 한다(밀린 뒤 위치로 다시 판정하면 사슬처럼 계속 밀린다).
 * 묶음의 기준점은 그 묶음에서 처음 만난 핀의 위치이고, 같은 묶음의 핀은 세로 위치를 공유한다.
 */
export function fanOutPins<T extends PinPlacement>(
  pins: readonly T[],
  options: FanOutOptions = {},
): Array<T & FannedPlacement> {
  const radius = options.radius ?? PIN_CLUSTER_RADIUS_PX;
  const step = options.step ?? PIN_FAN_STEP_PX;

  const clusters: Cluster[] = [];
  const assigned: Array<{ cluster: Cluster; index: number }> = [];

  for (const pin of pins) {
    const point = { left: pin.left, top: pin.top };
    let cluster = clusters.find((c) => overlaps(c.anchor, point, radius));
    if (!cluster) {
      cluster = { anchor: point, count: 0 };
      clusters.push(cluster);
    }
    assigned.push({ cluster, index: cluster.count });
    cluster.count += 1;
  }

  return pins.map((pin, i) => {
    const { cluster, index } = assigned[i]!;
    return {
      ...pin,
      left: cluster.anchor.left + index * step,
      top: cluster.anchor.top,
      clusterIndex: index,
      clusterSize: cluster.count,
    };
  });
}
