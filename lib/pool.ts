import { setTimeout as sleep } from "node:timers/promises";

/** Transient failure (429, 529, 5xx, network): the pool pauses every worker, then retries. */
export class RetryableError extends Error {
  readonly retryAfterMs?: number;
  /** HTTP status that caused the retry; undefined for network failures. */
  readonly status?: number;
  constructor(message: string, retryAfterMs?: number, status?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** Failure that makes every remaining item pointless (bad key, no credits): stops the whole run. */
export class FatalError extends Error {}

/**
 * Shared across runs on purpose: the provider rate limit is per account, so a 429 seen by one
 * job must slow down every job in the process.
 */
export const sharedGate = { pausedUntil: 0 };

export interface PoolOptions<R> {
  /** Upper bound for calls in flight; the adaptive limit moves between 1 and this. */
  concurrency: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  gate?: { pausedUntil: number };
  /** First retry backoff; doubles per attempt up to 30 s. Tests shrink it. */
  baseDelayMs?: number;
  /** Minimum time between two halvings, so one burst of 429s from the same wave halves once. */
  decreaseCooldownMs?: number;
  onStart?: (index: number) => void;
  onResult?: (index: number, result: R) => void;
  onError?: (index: number, error: unknown) => void;
  /** Called on every retry, with the backoff that item waits. */
  onRetry?: (index: number, error: RetryableError, delayMs: number) => void;
  /** Cut the limit when the recent p95 latency passes this multiple of the best p50 seen. */
  latencyFactor?: number;
  /** Called when the adaptive limit changes, with what moved it. */
  onLimit?: (limit: number, reason: LimitReason) => void;
}

export type LimitReason = "error" | "latency" | "increase";

// AIMD (the TCP congestion rule): halve on errors, add one after a run of successes. A provider can
// also queue requests without any error, so latency is a second congestion signal: when the recent
// p95 passes `latencyFactor` × the best p50 seen in this run, cut by a quarter.
// ponytail: fixed constants, tuned on one OpenRouter account; make them options if another
// provider behaves differently.
const SUCCESSES_PER_INCREASE = 10;
const LATENCY_WINDOW = 20;
const LATENCY_CUT = 0.75;

/**
 * Runs `worker` over `items`. Workers pull from a shared cursor, so one slow item never blocks the
 * others. Calls in flight are capped by an adaptive limit: any retryable error (429, 5xx, network)
 * halves it, a recent p95 latency above `latencyFactor` × the best p50 cuts it by a quarter, and
 * every 10 healthy successes add one, up to `concurrency`. The retried item waits its own
 * backoff; only a server-sent Retry-After pauses every worker through the shared gate. Per-item
 * failures go to `onError` and the run continues; a FatalError or an abort stops new work and
 * aborts in-flight calls.
 */
export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, signal: AbortSignal) => Promise<R>,
  {
    concurrency, maxAttempts = 5, signal, gate = sharedGate, baseDelayMs = 1_000, decreaseCooldownMs = 1_000,
    latencyFactor = 3, onStart, onResult, onError, onRetry, onLimit,
  }: PoolOptions<R>,
): Promise<void> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });

  let next = 0;
  let fatal: unknown;

  // Semaphore with a limit that can move while calls are in flight.
  let limit = concurrency;
  let active = 0;
  let successes = 0;
  let lastDecrease = -Infinity;
  // Latency control: a window of recent call times, and the best window p50 seen so far.
  const window: number[] = [];
  let baseP50 = Infinity;
  // Latency alone never cuts below 1/8 of the cap: if the provider slows down as a whole, the best
  // p50 stays low and every window looks congested, which would otherwise drive the limit to 1.
  const latencyFloor = Math.max(1, Math.ceil(concurrency / 8));
  const waiters: (() => void)[] = [];
  const wake = () => {
    while (waiters.length && active < limit) {
      active++;
      waiters.shift()!();
    }
  };
  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (ctrl.signal.aborted) return reject(ctrl.signal.reason);
      if (active < limit) {
        active++;
        return resolve();
      }
      const onAbort = () => {
        waiters.splice(waiters.indexOf(grant), 1);
        reject(ctrl.signal.reason);
      };
      const grant = () => {
        ctrl.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      waiters.push(grant);
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
    });
  const release = () => {
    active--;
    wake();
  };
  const setLimit = (value: number, reason: LimitReason) => {
    if (value === limit) return;
    limit = value;
    onLimit?.(limit, reason);
    wake();
  };
  // Runs every SUCCESSES_PER_INCREASE successes: cut on high latency, otherwise add one.
  const adjust = () => {
    if (window.length >= LATENCY_WINDOW) {
      const sorted = [...window].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      baseP50 = Math.min(baseP50, p50);
      if (p95 > latencyFactor * baseP50 && limit > latencyFloor) {
        setLimit(Math.max(latencyFloor, Math.floor(limit * LATENCY_CUT)), "latency");
        window.length = 0; // judge the next cut on calls made under the new limit
        return;
      }
    }
    if (limit < concurrency) setLimit(limit + 1, "increase");
  };

  const attempt = async (item: T, index: number): Promise<R> => {
    for (let n = 1; ; n++) {
      // A slot can be granted after a Retry-After pause started, so check the gate again once holding it.
      for (;;) {
        while (gate.pausedUntil > Date.now()) {
          await sleep(gate.pausedUntil - Date.now(), undefined, { signal: ctrl.signal });
        }
        await acquire();
        if (gate.pausedUntil <= Date.now()) break;
        release();
      }
      let result: R;
      const started = Date.now();
      try {
        result = await worker(item, ctrl.signal);
      } catch (error) {
        release(); // the backoff below must not hold a slot
        if (!(error instanceof RetryableError) || ctrl.signal.aborted) throw error;
        if (Date.now() - lastDecrease >= decreaseCooldownMs) {
          lastDecrease = Date.now();
          setLimit(Math.max(1, Math.floor(limit / 2)), "error");
        }
        if (n >= maxAttempts) throw error;
        const delay = error.retryAfterMs ?? Math.min(30_000, baseDelayMs * 2 ** (n - 1)) + Math.random() * baseDelayMs;
        if (error.retryAfterMs !== undefined) gate.pausedUntil = Math.max(gate.pausedUntil, Date.now() + delay);
        onRetry?.(index, error, delay);
        await sleep(delay, undefined, { signal: ctrl.signal });
        continue;
      }
      release();
      window.push(Date.now() - started);
      if (window.length > LATENCY_WINDOW) window.shift();
      if (++successes % SUCCESSES_PER_INCREASE === 0) adjust();
      return result;
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!ctrl.signal.aborted && next < items.length) {
          const index = next++;
          onStart?.(index);
          try {
            const result = await attempt(items[index]!, index); // not inlined: `onResult?.(…)` skips evaluating its args
            onResult?.(index, result);
          } catch (error) {
            if (error instanceof FatalError) {
              fatal ??= error;
              ctrl.abort(error);
            } else if (!ctrl.signal.aborted) {
              onError?.(index, error);
            }
          }
        }
      }),
    );
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  if (fatal) throw fatal;
}
