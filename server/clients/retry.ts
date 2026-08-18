/**
 * 외부 API 호출 재시도.
 *
 * 여러 잡을 연속으로 돌리면 `fetch failed`(TCP 리셋·DNS 순단 등)가 간헐적으로
 * 난다. 재시도가 없으면 그 한 번에 잡 전체가 죽는다 — 실측: 9건 배치에서
 * 4건이 이 이유로 실패했다.
 *
 * 재시도 대상은 "일시적"인 것만이다. 4xx(잘못된 요청·인증 실패)는 다시 해도
 * 같은 결과이므로 즉시 던진다.
 */

const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i;

export interface RetryOptions {
  tries?: number;
  baseDelayMs?: number;
  label?: string;
  onRetry?: (attempt: number, err: Error) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  const base = opts.baseDelayMs ?? 1500;
  let last: Error | undefined;

  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error;
      last = err;
      const msg = err.message ?? "";
      // HTTP 5xx / 429는 서버 측 일시 장애라 재시도 가치가 있다
      const httpRetryable = /\b(429|500|502|503|504)\b/.test(msg);
      if (!TRANSIENT.test(msg) && !httpRetryable) throw err;
      if (i === tries - 1) break;
      opts.onRetry?.(i + 1, err);
      await new Promise((r) => setTimeout(r, base * 2 ** i));
    }
  }
  throw new Error(
    `${opts.label ? opts.label + ": " : ""}${tries}회 시도 후 실패 — ${last?.message ?? "unknown"}`,
  );
}
