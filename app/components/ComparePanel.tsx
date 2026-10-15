"use client";

import { useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/data";
import type { Variant } from "@/lib/audience";
import type { ItemState, JobEvent, Progress } from "@/lib/jobs";

type Filter = "all" | "diff" | "agree" | "error";

const BANDS = [
  { label: "< 0.5", min: 0, max: 0.5 },
  { label: "0.5 – 0.8", min: 0.5, max: 0.8 },
  { label: "≥ 0.8", min: 0.8, max: Infinity },
];

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

export default function ComparePanel({ set }: { set: string }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [variant, setVariant] = useState<Variant>("generic");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch(`/api/products/${set}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setProducts)
      .catch((e) => setError(`Falha ao carregar produtos: ${e.message}. Rodou npm run import?`));

    // EventSource reconnects by itself; the server re-sends a full snapshot on every connect.
    const es = new EventSource(`/api/classify/${set}/stream`);
    es.onmessage = (msg) => {
      const e: JobEvent = JSON.parse(msg.data);
      if (e.type === "snapshot") {
        setItems(e.items);
        setProgress(e.progress);
      } else if (e.type === "item") {
        setItems((prev) => ({ ...prev, [e.id]: e.item }));
      } else {
        setProgress(e.progress);
      }
    };
    return () => es.close();
  }, [set]);

  const running = progress?.status === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  async function start() {
    setError(null);
    setStarting(true);
    try {
      const r = await fetch(`/api/classify/${set}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant }),
      });
      if (!r.ok) setError((await r.json()).error ?? `HTTP ${r.status}`);
    } finally {
      setStarting(false);
    }
  }

  const cancel = () => fetch(`/api/classify/${set}`, { method: "DELETE" });

  const stats = useMemo(() => {
    const rows = (products ?? []).flatMap((p) => {
      const r = items[p.id]?.result;
      return r ? [{ p, r, agree: r.category === p.category_name }] : [];
    });
    const pairs = new Map<string, number>();
    for (const { p, r, agree } of rows) {
      if (agree) continue;
      const key = `${p.category_name || "(vazio)"} → ${r.category}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    return {
      n: rows.length,
      agree: rows.filter((x) => x.agree).length,
      avgConfidence: rows.length ? rows.reduce((s, x) => s + x.r.confidence, 0) / rows.length : 0,
      bands: BANDS.map((b) => {
        const inBand = rows.filter((x) => x.r.confidence >= b.min && x.r.confidence < b.max);
        return { ...b, n: inBand.length, agree: inBand.filter((x) => x.agree).length };
      }),
      pairs: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 6),
      avgMs: rows.length ? rows.reduce((s, x) => s + x.r.ms, 0) / rows.length : 0,
      model: rows[0]?.r.model,
    };
  }, [products, items]);

  const visible = (products ?? []).filter((p) => {
    const it = items[p.id];
    if (filter === "all") return true;
    if (filter === "error") return it?.status === "error";
    if (!it?.result) return false;
    return (it.result.category === p.category_name) === (filter === "agree");
  });

  const total = progress?.total || products?.length || 0;
  const done = progress?.done ?? 0;
  const elapsed = progress?.startedAt ? ((progress.finishedAt ?? now) - progress.startedAt) / 1000 : 0;

  return (
    <section className="space-y-4">
      {/* control + loading bar */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value as Variant)}
            disabled={running}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            aria-label="Pergunta de idade"
          >
            <option value="off">Sem pergunta de idade</option>
            <option value="generic">Pergunta de idade: pistas genéricas</option>
            <option value="brands">Pergunta de idade: pistas + marcas</option>
            <option value="image">Imagem primeiro, texto como fallback</option>
          </select>
          <button
            onClick={start}
            disabled={running || starting || !products}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {(running || starting) && <Spinner className="text-white" />}
            {running ? "Classificando…" : stats.n ? "Reclassificar com Jev" : "Classificar com Jev"}
          </button>
          {running && (
            <button
              onClick={cancel}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancelar
            </button>
          )}
          <span className="text-sm text-zinc-500">
            {products ? `${products.length} produtos` : "carregando produtos…"}
            {progress && progress.status !== "idle" && (
              <>
                {" · "}
                {statusLabel(progress.status)} · {elapsed.toFixed(1)}s · US$ {progress.cost.toFixed(4)}
                {running && ` · ${progress.inFlight} em andamento, limite ${progress.limit ?? progress.concurrency}/${progress.concurrency}`}
                {progress.errors > 0 && <span className="text-red-600"> · {progress.errors} erros</span>}
                {Object.keys(progress.retries ?? {}).length > 0 && (
                  <span className="text-amber-600">
                    {" · retries "}
                    {Object.entries(progress.retries).map(([k, n]) => `${k}×${n}`).join(", ")}
                  </span>
                )}
              </>
            )}
          </span>
        </div>
        {progress && progress.status !== "idle" && (
          <div className="mt-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all duration-300 ${running ? "animate-pulse bg-indigo-500" : "bg-emerald-500"}`}
                style={{ width: `${total ? (done / total) * 100 : 0}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {done}/{total} ({pct(done, total)})
            </div>
          </div>
        )}
        {(error || progress?.error) && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error ?? progress?.error}
          </p>
        )}
      </div>

      {/* live metrics */}
      {stats.n > 0 && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="Concordância Jev × atual">
            <div className="text-3xl font-semibold">{pct(stats.agree, stats.n)}</div>
            <div className="text-sm text-zinc-500">
              {stats.agree}/{stats.n} iguais · confiança média {stats.avgConfidence.toFixed(2)} · {Math.round(stats.avgMs)}ms/req
            </div>
            {stats.model && <div className="mt-1 text-xs text-zinc-400">modelo: {stats.model}</div>}
          </Card>
          <Card title="Concordância por faixa de confiança">
            <table className="w-full text-sm">
              <tbody>
                {stats.bands.map((b) => (
                  <tr key={b.label}>
                    <td className="py-0.5 text-zinc-500">{b.label}</td>
                    <td className="py-0.5 text-right tabular-nums">{b.n} itens</td>
                    <td className="py-0.5 text-right font-medium tabular-nums">{pct(b.agree, b.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Principais divergências (atual → Jev)">
            {stats.pairs.length ? (
              <ul className="space-y-0.5 text-sm">
                {stats.pairs.map(([pair, n]) => (
                  <li key={pair} className="flex justify-between gap-2">
                    <span className="truncate" title={pair}>{pair}</span>
                    <span className="tabular-nums text-zinc-500">{n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Nenhuma divergência.</p>
            )}
          </Card>
        </div>
      )}

      {/* filter */}
      <div className="flex gap-1 text-sm">
        {(["all", "diff", "agree", "error"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1 ${filter === f ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}
          >
            {{ all: "Todos", diff: "Divergentes", agree: "Iguais", error: "Erros" }[f]}
          </button>
        ))}
        <span className="ml-auto self-center text-zinc-500">{visible.length} exibidos</span>
      </div>

      {/* comparison table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
            <tr>
              <th className="w-16 px-3 py-2" />
              <th className="px-3 py-2">Produto</th>
              <th className="w-56 px-3 py-2">Categoria atual</th>
              <th className="w-72 px-3 py-2">Categoria Jev</th>
              <th className="w-20 px-3 py-2 text-center">Match</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {!products &&
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i}>
                  <td colSpan={5} className="px-3 py-3">
                    <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                  </td>
                </tr>
              ))}
            {visible.map((p) => (
              <Row key={p.id} p={p} item={items[p.id]} jobRunning={running} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ p, item, jobRunning }: { p: Product; item?: ItemState; jobRunning: boolean }) {
  const r = item?.result;
  const agree = r && r.category === p.category_name;
  return (
    <tr className={r && !agree ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined}>
      <td className="px-3 py-2">
        {p.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image_url} alt="" loading="lazy" className="h-12 w-12 rounded object-cover" />
        ) : (
          <div className="h-12 w-12 rounded bg-zinc-100 dark:bg-zinc-800" />
        )}
      </td>
      <td className="px-3 py-2">
        <div className="line-clamp-2 font-medium" title={p.description || p.title}>{p.title}</div>
        <div className="text-xs text-zinc-500">
          {p.advertiser_name || p.marketplace_name}
          {p.validation_mode === "manual" && <span className="ml-2 rounded bg-zinc-100 px-1 dark:bg-zinc-800">manual</span>}
        </div>
      </td>
      <td className="px-3 py-2">{p.category_name || <span className="text-zinc-400">(vazio)</span>}</td>
      <td className="px-3 py-2">
        {r ? (
          <details>
            <summary className="cursor-pointer list-none">
              <div className="font-medium">{r.category}</div>
              <ConfidenceBar value={r.confidence} />
              {r.path && (
                <div className="mt-1 text-xs text-zinc-500">
                  {r.path === "image" ? `imagem · grupo ${r.group} (${r.groupConfidence?.toFixed(2)})` : `texto · ${r.fallbackReason}`}
                </div>
              )}
              {r.children !== undefined && (
                <div className="mt-1 text-xs text-zinc-500">
                  criança: {(r.children * 100).toFixed(0)}%
                  {r.adjustedFrom && <span className="ml-1 text-indigo-600 dark:text-indigo-400">· ajustado de {r.adjustedFrom}</span>}
                </div>
              )}
            </summary>
            <ol className="mt-1 space-y-0.5 text-xs text-zinc-500">
              {r.top.map((t) => (
                <li key={t.category} className="flex justify-between gap-2">
                  <span className="truncate">{t.category}</span>
                  <span className="tabular-nums">{(t.p * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ol>
          </details>
        ) : item?.status === "running" ? (
          <span className="inline-flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
            <Spinner /> classificando…
          </span>
        ) : item?.status === "error" ? (
          <span className="text-xs text-red-600" title={item.error}>erro: {item.error}</span>
        ) : jobRunning ? (
          <div className="h-4 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" title="na fila" />
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        {r && (
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
              agree
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            }`}
          >
            {agree ? "✓ igual" : "≠ difere"}
          </span>
        )}
      </td>
    </tr>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 0.8 ? "bg-emerald-500" : value >= 0.5 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className={`h-full ${color}`} style={{ width: `${value * 100}%` }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-500">{value.toFixed(2)}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </div>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function statusLabel(s: Progress["status"]) {
  return { idle: "", running: "rodando", done: "concluído", cancelled: "cancelado", failed: "falhou" }[s];
}
