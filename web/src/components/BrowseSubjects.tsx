"use client";
// The Browse tab (demo spec §23.8): pick one of this app's scenarios, then a subject in it (a loan application, a
// Streamly customer…) and see its decision graph: its parts, the decisions about them, what they led to, who decided.
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { ViewNode, ViewRel } from "./GraphView";

const GraphView = dynamic(() => import("./GraphView"), { ssr: false });

type Subject = { id: string; label: string; key: string; type: string; email?: string | null; parts: number; decisions: number; outcomes: number };

export default function BrowseSubjects({ active }: { active: boolean }) {
  const [scenarios, setScenarios] = useState<{ scenario: string; n: number }[]>([]);
  const [scenario, setScenario] = useState("");
  const [types, setTypes] = useState<{ type: string; n: number }[]>([]);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [graph, setGraph] = useState<{ nodes: ViewNode[]; rels: ViewRel[] } | null>(null);

  useEffect(() => {
    let current = true;   // a slower, older request must not overwrite a newer search's results
    const t = setTimeout(() => {
      const url = `/api/subjects?${new URLSearchParams({ ...(scenario ? { scenario } : {}), ...(type ? { type } : {}),
                                                          ...(q.trim() ? { q: q.trim() } : {}) })}`;
      fetch(url).then((r) => r.json()).then((d) => {
        if (current) { setScenarios(d.scenarios ?? []); setScenario(d.scenario ?? ""); setTypes(d.types ?? []); setSubjects(d.subjects ?? []); }
      }).catch(() => {});
    }, 250);   // a pause after typing before searching
    return () => { current = false; clearTimeout(t); };
  }, [scenario, type, q]);

  async function open(id: string) {
    setPicked(id); setGraph(null);
    const res = await fetch(`/api/graph/subject?id=${encodeURIComponent(id)}`);
    if (res.ok) setGraph(await res.json());
  }

  const decisions = (graph?.nodes ?? []).filter((n) => n.kind === "decision");
  const outcomesOf = (id: string) => (graph?.rels ?? []).filter((r) => r.type === "LED_TO" && r.from === id)
    .map((r) => graph!.nodes.find((n) => n.id === r.to)).filter(Boolean) as ViewNode[];
  const current = subjects.find((s) => s.id === picked);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center gap-3 rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Browse</h2>
        <select value={scenario} onChange={(e) => { setScenario(e.target.value); setType(""); setQ(""); setPicked(null); setGraph(null); }}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs" title="The scenarios this app can see">
          {!scenarios.length && <option value="">nothing loaded</option>}
          {scenarios.map((x) => <option key={x.scenario} value={x.scenario}>{x.scenario} · {x.n.toLocaleString()} subjects</option>)}
        </select>
        <span className="text-xs text-zinc-500">{types.map((t) => `${t.n.toLocaleString()} ${t.type}${t.n === 1 ? "" : "s"}`).join(" · ")}</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
        <nav className="flex min-h-0 flex-col border-r border-zinc-800">
          <div className="space-y-2 border-b border-zinc-800 p-2">
            {types.length > 1 && (
              <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs">
                <option value="">All types</option>
                {types.map((t) => <option key={t.type} value={t.type}>{t.type} ({t.n})</option>)}
              </select>
            )}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by ID, name or email"
                   className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs" />
            <p className="text-[10px] text-zinc-500">{subjects.length === 200 ? "First 200 shown: search to narrow" : `${subjects.length} shown`}</p>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1 text-xs">
            {subjects.map((s) => (
              <li key={s.id}>
                <button onClick={() => open(s.id)}
                        className={`w-full px-3 py-1.5 text-left hover:bg-zinc-800 ${picked === s.id ? "bg-sky-950 text-sky-100" : ""}`}>
                  <span className="block truncate font-mono">{s.key}</span>
                  {s.email && <span className="block truncate text-[10px] text-zinc-400">{s.email}</span>}
                  <span className="text-[10px] text-zinc-500">{s.parts} part{s.parts === 1 ? "" : "s"} · {s.decisions} decision{s.decisions === 1 ? "" : "s"} · {s.outcomes} outcome{s.outcomes === 1 ? "" : "s"}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="grid min-h-0 grid-rows-[1fr_auto]">
          <div className="min-h-0">{!picked ? <p className="p-6 text-sm text-zinc-500">Pick a subject on the left to see its decisions and what they led to.</p>
            : active && graph && graph.nodes.length > 0 ? <GraphView nodes={graph.nodes} rels={graph.rels} />
            : <p className="p-6 text-sm text-zinc-500">{graph ? "No decisions about this subject." : "Loading…"}</p>}</div>
          {picked && graph && (
            <div className="max-h-56 overflow-y-auto border-t border-zinc-800 p-3 text-xs">
              <p className="mb-1 font-semibold text-zinc-300">{current ? (current.key.toLowerCase().startsWith(current.label.toLowerCase()) ? current.key : `${current.label} ${current.key}`) : ""} · {decisions.length} decision{decisions.length === 1 ? "" : "s"}</p>
              {decisions.map((d) => (
                <p key={d.id} className="text-zinc-400">
                  <span className="text-zinc-200">{d.label} → {(d.option ?? "").replaceAll("_", " ")}</span> · {d.detail}
                  {" → "}{outcomesOf(d.id).map((o) => o.label).join(", ") || "no outcome recorded"}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
