"use client";

import { useState } from "react";
import ComparePanel from "./components/ComparePanel";

const TABS = [
  { set: "baseline", label: "1. Baseline", hint: "100 produtos já classificados (amostra estratificada, sem Posthaus)" },
  { set: "posthaus", label: "2. Posthaus", hint: "Todos os produtos Posthaus, onde o classificador atual falha" },
  { set: "validacao", label: "3. Validação idade", hint: "150 roupas e calçados de outras lojas: 75 infantis e 75 adultos pela categoria atual" },
] as const;

export default function Home() {
  const [tab, setTab] = useState<(typeof TABS)[number]["set"]>("baseline");
  const current = TABS.find((t) => t.set === tab)!;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Classificação com Jev</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Jev (TypeSafe System One via OpenRouter) vs classificação atual (embeddings + rerank).
        </p>
      </header>
      <nav className="mb-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.set}
            onClick={() => setTab(t.set)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === t.set
                ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <p className="mb-4 text-sm text-zinc-500">{current.hint}</p>
      {/* both panels stay mounted so each keeps its live stream while you switch tabs */}
      {TABS.map((t) => (
        <div key={t.set} hidden={tab !== t.set}>
          <ComparePanel set={t.set} />
        </div>
      ))}
    </main>
  );
}
