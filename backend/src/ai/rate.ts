/**
 * AI 호출 분당 퓨즈 (claude01 `server/ai.php` 의 카운터 파일을 메모리로 옮긴 것).
 *
 * 쿼터가 아니라 **폭주 방지용 퓨즈**다: 한 사람의 재시도 루프나 스크립트가 하루 만에 한 달치
 * 토큰을 태우지 못하게 막는 것이 목적이라, 사용자별이 아니라 **전체 합**으로 센다.
 *
 * 앱 프로세스는 하나이므로 상태는 메모리에 둔다(재기동하면 0 부터 — 퓨즈에는 문제가 없다).
 * claude01 의 **fail-open** 원칙은 그대로 지킨다: 세다가 문제가 생기면 막지 않고 통과시킨다.
 * 거절이 목적이 아니라 폭주만 끊는 장치이기 때문이다.
 */

/** 분 단위 키 (UTC) — `2026-09-05T03:04` */
export const minuteKey = (at: Date = new Date()): string => at.toISOString().slice(0, 16);

export class RateFuse {
  private counts = new Map<string, number>();

  constructor(private readonly limitPerMin: number) {}

  /**
   * 이번 호출을 현재 분에 기록하고 한도 안인지 알려 준다.
   * `false` 면 한도 초과(429). 세는 데 실패하면 `true`(통과)다.
   */
  allow(at: Date = new Date()): boolean {
    try {
      const key = minuteKey(at);
      const next = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, next);
      // 지난 분의 카운터는 버린다 (맵이 자라지 않게).
      for (const old of this.counts.keys()) {
        if (old !== key) this.counts.delete(old);
      }
      return next <= this.limitPerMin;
    } catch {
      return true;
    }
  }

  /** 진단·테스트용 — 현재 분의 호출 수 */
  countFor(at: Date = new Date()): number {
    return this.counts.get(minuteKey(at)) ?? 0;
  }
}
