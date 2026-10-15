import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FatalError, RetryableError, runPool } from "./pool.ts";

const items = Array.from({ length: 60 }, (_, i) => i);

test("bounded concurrency, retries 429s with a shared pause, completes every item", async () => {
  let inFlight = 0;
  let peak = 0;
  const failedOnce = new Set<number>();
  const pauses: number[] = [];
  const gate = { pausedUntil: 0 };
  const results = new Map<number, number>();
  const retries: number[] = [];

  await runPool(
    items,
    async (n) => {
      if (gate.pausedUntil > Date.now()) pauses.push(n); // a worker started during a pause = bug
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5 + Math.random() * 10);
      inFlight--;
      if (n % 7 === 0 && !failedOnce.has(n)) {
        failedOnce.add(n);
        throw new RetryableError("429", 20);
      }
      return n * 2;
    },
    { concurrency: 8, gate, onResult: (i, r) => results.set(i, r), onRetry: (i, e) => retries.push(e.retryAfterMs!) },
  );

  assert.equal(retries.length, failedOnce.size); // one retry per item that threw a 429 once
  assert.ok(retries.every((ms) => ms === 20));

  assert.equal(peak, 8);
  assert.equal(results.size, items.length);
  assert.ok(items.every((i) => results.get(i) === i * 2));
  assert.deepEqual(pauses, []);
});

test("item errors are isolated, fatal stops the run", async () => {
  const errors: number[] = [];
  const done: number[] = [];
  await runPool(items.slice(0, 10), async (n) => {
    if (n === 3) throw new Error("bad item");
    return n;
  }, { concurrency: 4, gate: { pausedUntil: 0 }, onResult: (i) => done.push(i), onError: (i) => errors.push(i) });
  assert.deepEqual(errors, [3]);
  assert.equal(done.length, 9);

  let started = 0;
  await assert.rejects(
    runPool(items, async (n, signal) => {
      started++;
      if (n === 5) throw new FatalError("401");
      await sleep(50, undefined, { signal });
      return n;
    }, { concurrency: 4, gate: { pausedUntil: 0 } }),
    FatalError,
  );
  assert.ok(started < items.length, `stopped early (started ${started})`);
});

test("abort stops quickly and aborts in-flight work", async () => {
  const ctrl = new AbortController();
  let completed = 0;
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 30);
  await runPool(items, async (_n, signal) => {
    await sleep(20, undefined, { signal });
    return 0;
  }, { concurrency: 4, signal: ctrl.signal, gate: { pausedUntil: 0 }, onResult: () => completed++ });
  assert.ok(Date.now() - t0 < 100);
  assert.ok(completed < items.length);
});

test("adaptive limit: halves under 429s, settles near the server capacity, finishes every item", async () => {
  const CAPACITY = 10; // the fake server accepts at most 10 calls at once
  let inFlight = 0;
  let rejected = 0;
  const limits: number[] = [];
  const done = new Set<number>();
  const many = Array.from({ length: 400 }, (_, i) => i);

  await runPool(many, async (n) => {
    if (++inFlight > CAPACITY) {
      inFlight--;
      rejected++;
      throw new RetryableError("429", undefined, 429); // no Retry-After, like OpenRouter
    }
    await sleep(5);
    inFlight--;
    return n;
  }, {
    concurrency: 64, gate: { pausedUntil: 0 }, baseDelayMs: 5, decreaseCooldownMs: 10, maxAttempts: 50,
    onResult: (i) => done.add(i), onLimit: (l) => limits.push(l),
  });

  assert.equal(done.size, many.length);
  assert.ok(Math.min(...limits) <= CAPACITY, `limit went down to ${Math.min(...limits)}`);
  // With the limit adapting, the server should reject less than once per item on average.
  assert.ok(rejected < many.length, `${rejected} rejections`);
});

test("adaptive limit climbs back to the configured concurrency after the congestion ends", async () => {
  const limits: number[] = [];
  let first = true;
  await runPool(Array.from({ length: 200 }, (_, i) => i), async (n) => {
    if (first) {
      first = false;
      throw new RetryableError("429", undefined, 429);
    }
    await sleep(1);
    return n;
  }, { concurrency: 8, gate: { pausedUntil: 0 }, baseDelayMs: 1, onLimit: (l) => limits.push(l) });
  assert.equal(limits[0], 4); // halved once
  assert.equal(limits.at(-1), 8); // +1 every 10 successes, back to the cap
});

test("abort also releases workers waiting for a slot", async () => {
  const ctrl = new AbortController();
  let first = true;
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 40);
  await runPool(items, async (_n, signal) => {
    if (first) {
      first = false;
      throw new RetryableError("429", undefined, 429); // limit 8 → 4: 4 workers now wait for a slot
    }
    await sleep(30, undefined, { signal });
    return 0;
  }, { concurrency: 8, signal: ctrl.signal, gate: { pausedUntil: 0 }, baseDelayMs: 1 });
  assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0} ms`);
});

test("latency control: a server that queues without errors makes the limit come down", async () => {
  const CAPACITY = 8; // above 8 calls at once, every extra call adds queueing delay
  let inFlight = 0;
  const reasons: string[] = [];
  const limits: number[] = [];
  const done = new Set<number>();
  const many = Array.from({ length: 600 }, (_, i) => i);

  await runPool(many, async (n) => {
    inFlight++;
    await sleep(4 + 3 * Math.max(0, inFlight - CAPACITY));
    inFlight--;
    return n;
  }, {
    concurrency: 64, gate: { pausedUntil: 0 },
    onResult: (i) => done.add(i), onLimit: (l, r) => { limits.push(l); reasons.push(r); },
  });

  assert.equal(done.size, many.length);
  assert.ok(reasons.includes("latency"), "cut by latency");
  assert.ok(!reasons.includes("error"), "no error cuts");
  assert.ok(Math.min(...limits) <= 16, `limit went down to ${Math.min(...limits)}`);
});

test("latency control: steady latency never cuts the limit", async () => {
  const reasons: string[] = [];
  await runPool(Array.from({ length: 300 }, (_, i) => i), async (n) => {
    await sleep(5 + Math.random() * 3);
    return n;
  }, { concurrency: 16, gate: { pausedUntil: 0 }, onLimit: (_l, r) => reasons.push(r) });
  assert.deepEqual(reasons.filter((r) => r !== "increase"), []);
});
