import { EventEmitter } from "node:events";
import { classifyCascade } from "./cascade";
import { loadProducts, type Product, type SetName } from "./data";
import type { Variant } from "./audience";
import { classify, type Classification } from "./jev";
import { runPool } from "./pool";

export type JobStatus = "idle" | "running" | "done" | "cancelled" | "failed";

export interface ItemState {
  status: "running" | "done" | "error";
  result?: Classification;
  error?: string;
}

export interface Progress {
  status: JobStatus;
  total: number;
  done: number;
  errors: number;
  inFlight: number;
  cost: number;
  startedAt: number | null;
  finishedAt: number | null;
  concurrency: number;
  variant: Variant;
  /** Retries by cause ("429", "529", "rede", ...) and the pause they pushed onto the shared gate. */
  retries: Record<string, number>;
  retryPauseMs: number;
  maxRetryAfterMs: number | null;
  /** Adaptive limit of calls in flight (≤ concurrency), and the lowest it reached in this run. */
  limit: number;
  minLimit: number;
  /** How many times the limit was cut, by cause. */
  limitCuts: { error: number; latency: number };
  error?: string;
}

export type JobEvent =
  | { type: "snapshot"; progress: Progress; items: Record<string, ItemState> }
  | { type: "item"; id: string; item: ItemState }
  | { type: "progress"; progress: Progress };

interface Job {
  progress: Progress;
  items: Map<string, ItemState>;
  ctrl: AbortController;
}

const CONCURRENCY = Number(process.env.JEV_CONCURRENCY) || 8;

// Survives Next dev HMR so a running job and its listeners aren't orphaned by a reload.
const g = globalThis as typeof globalThis & { __jev?: { jobs: Map<SetName, Job>; bus: EventEmitter } };
g.__jev ??= { jobs: new Map(), bus: new EventEmitter().setMaxListeners(0) };
const { jobs, bus } = g.__jev;

const idle = (): Progress => ({
  status: "idle", total: 0, done: 0, errors: 0, inFlight: 0, cost: 0,
  startedAt: null, finishedAt: null, concurrency: CONCURRENCY, variant: "off",
  retries: {}, retryPauseMs: 0, maxRetryAfterMs: null, limit: CONCURRENCY, minLimit: CONCURRENCY, limitCuts: { error: 0, latency: 0 },
});

export function snapshot(set: SetName): Extract<JobEvent, { type: "snapshot" }> {
  const job = jobs.get(set);
  return {
    type: "snapshot",
    progress: job ? { ...job.progress } : idle(),
    items: job ? Object.fromEntries(job.items) : {},
  };
}

/** Listen to one set's events; returns the unsubscribe function. */
export function subscribe(set: SetName, fn: (e: JobEvent) => void): () => void {
  bus.on(set, fn);
  return () => bus.off(set, fn);
}

export class JobRunningError extends Error {}

export async function startJob(set: SetName, variant: Variant = "off", concurrency = CONCURRENCY): Promise<Progress> {
  if (jobs.get(set)?.progress.status === "running") throw new JobRunningError(`${set} already running`);
  // Claim the slot synchronously, before any await, so two concurrent POSTs can't both start.
  const job: Job = {
    progress: { ...idle(), status: "running", startedAt: Date.now(), variant, concurrency, limit: concurrency, minLimit: concurrency },
    items: new Map(),
    ctrl: new AbortController(),
  };
  jobs.set(set, job);
  try {
    const products = await loadProducts(set);
    job.progress.total = products.length;
    bus.emit(set, snapshot(set));
    void run(set, job, products);
    return { ...job.progress };
  } catch (error) {
    finish(set, job, "failed", error);
    throw error;
  }
}

export function cancelJob(set: SetName): boolean {
  const job = jobs.get(set);
  if (job?.progress.status !== "running") return false;
  job.ctrl.abort();
  return true;
}

async function run(set: SetName, job: Job, products: Awaited<ReturnType<typeof loadProducts>>) {
  const p = job.progress;
  const emitItem = (id: string, item: ItemState) => {
    job.items.set(id, item);
    bus.emit(set, { type: "item", id, item });
    bus.emit(set, { type: "progress", progress: { ...p } });
  };
  try {
    const worker = p.variant === "image" ? classifyCascade : (product: Product, signal: AbortSignal) => classify(product, signal, p.variant);
    await runPool(products, worker, {
      concurrency: p.concurrency,
      signal: job.ctrl.signal,
      onRetry: (_i, error, delayMs) => {
        const cause = error.status ? String(error.status) : "rede";
        p.retries[cause] = (p.retries[cause] ?? 0) + 1;
        p.retryPauseMs += delayMs;
        if (error.retryAfterMs !== undefined) p.maxRetryAfterMs = Math.max(p.maxRetryAfterMs ?? 0, error.retryAfterMs);
        bus.emit(set, { type: "progress", progress: { ...p } });
      },
      onLimit: (limit, reason) => {
        if (reason !== "increase") p.limitCuts[reason]++;
        p.limit = limit;
        p.minLimit = Math.min(p.minLimit, limit);
        bus.emit(set, { type: "progress", progress: { ...p } });
      },
      onStart: (i) => {
        p.inFlight++;
        emitItem(products[i]!.id, { status: "running" });
      },
      onResult: (i, result) => {
        p.inFlight--;
        p.done++;
        p.cost += result.cost;
        emitItem(products[i]!.id, { status: "done", result });
      },
      onError: (i, error) => {
        p.inFlight--;
        p.done++;
        p.errors++;
        emitItem(products[i]!.id, { status: "error", error: String((error as Error)?.message ?? error) });
      },
    });
    finish(set, job, job.ctrl.signal.aborted ? "cancelled" : "done");
  } catch (error) {
    finish(set, job, "failed", error); // only FatalError reaches here; aborts are absorbed by the pool
  }
}

function finish(set: SetName, job: Job, status: JobStatus, error?: unknown) {
  // Items still marked running were aborted mid-request; drop them so the UI shows them as pending.
  for (const [id, item] of job.items) if (item.status === "running") job.items.delete(id);
  Object.assign(job.progress, {
    status,
    inFlight: 0,
    finishedAt: Date.now(),
    error: error ? String((error as Error)?.message ?? error) : undefined,
  });
  bus.emit(set, snapshot(set));
}
