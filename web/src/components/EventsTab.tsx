"use client";

// Events tab (demo spec Section 10.5): load a set of raw events, watch what each one becomes,
// and see the story emerge, its journey in the graph, and the tree branches it updates.
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import BrowseSubjects from "./BrowseSubjects";
import ConnectSource from "./ConnectSource";
import DeleteScenario from "./DeleteScenario";
import type { ViewNode, ViewRel } from "./GraphView";

const GraphView = dynamic(() => import("./GraphView"), { ssr: false });
const GraphTable = dynamic(() => import("./GraphTable"), { ssr: false });

type SetStatus = {
  set: number; loaded: boolean; outcomesLoaded: boolean;
  story: { key: string; title: string; point: string; customer: { name: string; email: string } } | null;
};
type StreamEvent = { event_id: string; source_system: string; event_type: string; occurred_at: string;
                     payload: Record<string, unknown>; became: string[] };
type Stats = { support: number; dispute_rate: number | null; churn_rate: number | null; win_rate: number | null };
type Branch = { point_id: string; tree: string; kind: string; branch: string; before: Stats; after: Stats };
type LoadResult = { set: number; phase: string; events: StreamEvent[]; branches: Branch[];
                    story: { title: string; point: string; customer: { name: string; email: string; plan: string; tenure_months: number } } };

const SOURCE: Record<string, { label: string; cls: string }> = {
  stripe: { label: "Stripe", cls: "bg-violet-600 text-white" },
  zendesk: { label: "Zendesk", cls: "bg-emerald-600 text-white" },
  mcp_gateway: { label: "Agent", cls: "bg-sky-600 text-white" },
  fraudguard: { label: "FraudGuard", cls: "bg-amber-600 text-white" },
  subscriptions: { label: "Subscriptions", cls: "bg-zinc-600 text-white" },
};

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function eventName(e: StreamEvent): string {
  return e.source_system === "mcp_gateway" ? `tool call · ${String(e.payload.tool)}` : e.event_type;
}

function chipClass(text: string): string {
  if (text.includes("OVERRIDES")) return "border-red-700 bg-red-950 text-red-200";
  if (text.startsWith("Decision")) return "border-emerald-800 bg-emerald-950 text-emerald-200";
  if (text.startsWith("Outcome")) return "border-amber-800 bg-amber-950 text-amber-200";
  return "border-violet-800 bg-violet-950 text-violet-200";
}

export default function EventsTab({ active, onChanged }: { active: boolean; onChanged: () => void }) {
  const [sets, setSets] = useState<SetStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [shown, setShown] = useState(0);       // events revealed so far (streaming effect)
  const [history, setHistory] = useState<StreamEvent[]>([]);   // earlier phase's events for the current set
  const [graph, setGraph] = useState<{ nodes: ViewNode[]; rels: ViewRel[] }>({ nodes: [], rels: [] });
  const [mode, setMode] = useState<"graph" | "table">("graph");
  const [connect, setConnect] = useState(false);
  const [browse, setBrowse] = useState(false);   // Browse loaded subjects (any domain, §23.8)
  const panel = connect || browse;               // a panel replaces the events and journey columns
  const [setsOpen, setSetsOpen] = useState(true);
  const [graphExpanded, setGraphExpanded] = useState(false);
  useEffect(() => {   // Esc closes the expanded journey graph
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setGraphExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [uploads, setUploads] = useState<{ scenario: string; events: number; decisions: number; customers: number }[]>([]);
  const [live, setLive] = useState<{ decisions: number; proposals: number; finals: number; overrides: number; tickets: number;
                                     with_outcomes?: number } | null>(null);

  const refresh = () => Promise.all([
    fetch("/api/stories").then((r) => r.json()).then(setSets),
    fetch("/api/upload").then((r) => r.json()).then(setUploads),
    fetch("/api/live").then((r) => r.json()).then(setLive),
  ]);
  useEffect(() => {
    let alive = true;
    fetch("/api/stories").then((r) => r.json()).then((s) => { if (alive) setSets(s); });
    fetch("/api/upload").then((r) => r.json()).then((u) => { if (alive) setUploads(u); });
    fetch("/api/live").then((r) => r.json()).then((l) => { if (alive) setLive(l); });
    return () => { alive = false; };
  }, []);

  async function removeUpload(scenario: string) {
    setBusy(`remove-${scenario}`);
    await fetch(`/api/upload?scenario=${encodeURIComponent(scenario)}`, { method: "DELETE" });
    await refresh();
    onChanged();
    setBusy(null);
  }

  // Reveal streamed events one at a time.
  useEffect(() => {
    if (!result || shown >= result.events.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 450);
    return () => clearTimeout(t);
  }, [result, shown]);
  const streaming = !!result && shown < result.events.length;

  async function loadGraph(email: string) {
    const res = await fetch(`/api/graph/customer?email=${encodeURIComponent(email)}`);
    if (res.ok) setGraph(await res.json());
  }

  async function load(n: number, phase: 0 | 1) {
    setBusy(`load-${n}-${phase}`);
    if (phase === 0 && sets.find((s) => s.set === n)?.loaded) {
      await fetch(`/api/stories/${n}`, { method: "DELETE" });   // reload fresh
    }
    const res = await fetch(`/api/stories/${n}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phase }),
    });
    const data = (await res.json()) as LoadResult;
    setHistory(phase === 1 && result?.set === n ? result.events : []);
    setResult(data);
    setShown(0);
    await loadGraph(data.story.customer.email);
    await refresh();
    onChanged();
    setBusy(null);
  }

  // What the MCP gateway and the Zendesk webhook captured, shown like a set's events.
  async function showLive() {
    setBusy("live");
    setConnect(false);
    const data = await (await fetch("/api/live?events=1")).json() as { customer_email: string | null; events: StreamEvent[] };
    setHistory([]);
    setResult({ set: 0, phase: "live", events: data.events, branches: [],
                story: { title: "Captured live", point: "The agent's tool calls came through Rationode's MCP gateway and the rep's " +
                         "decisions through the Zendesk webhook; the detector turned them into the decisions shown.",
                         customer: { name: "", email: data.customer_email ?? "", plan: "", tenure_months: 0 } } });
    setShown(data.events.length);
    if (data.customer_email) await loadGraph(data.customer_email);
    await refresh();
    setBusy(null);
  }

  async function remove(n: number) {
    setBusy(`remove-${n}`);
    await fetch(`/api/stories/${n}`, { method: "DELETE" });
    if (result?.set === n) { setResult(null); setHistory([]); setGraph({ nodes: [], rels: [] }); }
    await refresh();
    onChanged();
    setBusy(null);
  }

  // Newest phase on top: after "60 days later", its events lead and the earlier ones follow below a divider.
  const incoming = result ? result.events.slice(0, shown) : [];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr_1fr] gap-3">
      {/* Sets */}
      <section className="flex min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
        <header className="rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Sources</h2>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className={`rounded-lg border p-3 ${connect ? "border-emerald-700 bg-emerald-950/30" : "border-zinc-800 bg-zinc-950"}`}>
            <p className="font-semibold">Connect a source</p>
            <p className="mt-1 text-xs text-zinc-500">Upload exports; Claude maps them onto the event contract and you see the mapping.</p>
            <button onClick={() => { setConnect(!connect); setBrowse(false); setSetsOpen(connect); }} disabled={streaming}
                    className="mt-2 rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
              {connect ? "Back to events" : "Open"}</button>
            {uploads.map((u) => (
              <div key={u.scenario} className="mt-2 flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono text-zinc-300" title={`${u.events} events · ${u.decisions} decisions`}>
                  {u.scenario} <span className="text-zinc-500">· {u.customers} customers</span></span>
                <button onClick={() => removeUpload(u.scenario)} disabled={!!busy}
                        className="rounded-md bg-zinc-800 px-2 py-0.5 disabled:opacity-40">
                  {busy === `remove-${u.scenario}` ? "…" : "Remove"}</button>
              </div>
            ))}
          </div>
          <div className={`rounded-lg border p-3 ${browse ? "border-sky-700 bg-sky-950/30" : "border-zinc-800 bg-zinc-950"}`}>
            <p className="font-semibold">Browse loaded subjects</p>
            <p className="mt-1 text-xs text-zinc-500">Any domain&apos;s loaded records (e.g. loan applications): pick one to see its decisions and what they led to.</p>
            <button onClick={() => { setBrowse(!browse); setConnect(false); }} disabled={streaming}
                    className="mt-2 rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
              {browse ? "Back to events" : "Open"}</button>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex items-baseline justify-between">
              <p className="font-semibold">Live · MCP gateway</p>
              <button onClick={() => refresh()} className="text-[10px] text-zinc-400 hover:text-zinc-200">refresh</button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">The live agent&apos;s tool calls pass through Rationode&apos;s gateway; the rep&apos;s
              Approve comes in by Zendesk webhook. Both land in the graph as they happen.</p>
            <p className="mt-1 text-xs">{live && live.decisions
              ? <>{live.proposals} AI proposal(s), {live.finals} rep decision(s), {live.overrides} override(s) across {live.tickets} ticket(s).{" "}
                  Rep decisions with outcomes (60 days later): {live.with_outcomes ?? 0}; awaiting outcomes: {live.finals - (live.with_outcomes ?? 0)}.</>
              : <span className="text-zinc-500">Nothing captured yet: run a case on the Streamly live tab.</span>}</p>
            {live && live.decisions > 0 && (
              <button onClick={showLive} disabled={!!busy || streaming}
                      className="mt-2 rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
                {busy === "live" ? "Loading…" : "Show live events"}</button>
            )}
          </div>
          <div className="rounded-lg border border-zinc-800">
            <button onClick={() => setSetsOpen(!setsOpen)} className="flex w-full items-center justify-between px-3 py-2 text-left">
              <span className="font-semibold">Event sets <span className="text-xs font-normal text-zinc-500">· {sets.filter((x) => x.loaded).length} of {sets.length} loaded</span></span>
              <span className="text-xs text-zinc-400">{setsOpen ? "▾" : "▸"}</span>
            </button>
            {setsOpen && <div className="space-y-3 border-t border-zinc-800 p-3">
          <p className="text-xs text-zinc-500">Raw events from Stripe, Zendesk, the fraud tool, and the support agent.
            Load a set and see what it brings in.</p>
          {sets.map((s) => (
            <div key={s.set} className={`rounded-lg border p-3 ${s.loaded ? "border-sky-800 bg-sky-950/30" : "border-zinc-800 bg-zinc-950"}`}>
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">Set {s.set}</p>
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                  {s.outcomesLoaded ? "events + outcomes" : s.loaded ? "events loaded" : "not loaded"}
                </span>
              </div>
              {s.story && <p className="mt-1 text-sm">{s.story.customer.name} · <span className="text-zinc-400">{s.story.title}</span></p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => load(s.set, 0)} disabled={!!busy || streaming}
                        className="rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
                  {busy === `load-${s.set}-0` ? "Loading…" : s.loaded ? "Reload" : "Load events"}
                </button>
                {s.loaded && !s.outcomesLoaded && (
                  <button onClick={() => load(s.set, 1)} disabled={!!busy || streaming}
                          className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
                    {busy === `load-${s.set}-1` ? "Loading…" : "60 days later →"}
                  </button>
                )}
                {s.loaded && (
                  <button onClick={() => remove(s.set)} disabled={!!busy || streaming}
                          className="rounded-md bg-zinc-800 px-3 py-1 text-xs disabled:opacity-40">
                    {busy === `remove-${s.set}` ? "Removing…" : "Remove"}
                  </button>
                )}
              </div>
            </div>
          ))}
            </div>}
          </div>
          <DeleteScenario refreshKey={uploads.length + sets.filter((x) => x.loaded).length}
                          onDeleted={() => { setResult(null); setHistory([]); setGraph({ nodes: [], rels: [] }); refresh(); onChanged(); }} />
        </div>
      </section>

      <div className={connect ? "col-span-2 flex min-h-0" : "hidden"}>
        <ConnectSource active={active && connect} onClose={() => setConnect(false)} onChanged={() => { refresh(); onChanged(); }} />
      </div>
      {browse && (
        <div className="col-span-2 flex min-h-0">
          <BrowseSubjects active={active && browse} onClose={() => setBrowse(false)} />
        </div>
      )}

      {/* Incoming events */}
      <section className={`${panel ? "hidden" : "flex"} min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60`}>
        <header className="flex items-center justify-between rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Incoming events</h2>
          {result && <span className="text-xs text-zinc-500">{result.set ? `Set ${result.set} · ${result.phase}` : "Live · newest first"}</span>}
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {!result && <p className="text-sm text-zinc-500">Load a set to see its events arrive.</p>}
          {history.length > 0 && (
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">60 days later · new events</p>
          )}
          {[...incoming, ...(history.length && !streaming ? [null] : []), ...(streaming ? [] : history)].map((e, i) => e === null ? (
            <p key="divider" className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Earlier events</p>
          ) : (
            <div key={e.event_id + i} className={`rounded-lg border bg-zinc-950 p-2.5 text-sm ${
              history.length && incoming.includes(e) ? "border-amber-700" : "border-zinc-800"} ${
              e.became.length ? "" : "opacity-60"}`}>
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE[e.source_system]?.cls ?? ""}`}>
                  {SOURCE[e.source_system]?.label ?? e.source_system}</span>
                <span className="font-mono text-xs">{eventName(e)}</span>
                <span className="ml-auto text-[10px] text-zinc-500">{e.occurred_at.slice(0, 16).replace("T", " ")}</span>
              </div>
              {e.became.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {e.became.map((b) => (
                    <span key={b} className={`rounded border px-2 py-0.5 text-[11px] ${chipClass(b)}`}>→ {b}</span>
                  ))}
                </div>
              ) : <p className="mt-1 text-[11px] text-zinc-500">context event (feeds identity and decision context)</p>}
            </div>
          ))}
          {streaming && <p className="text-xs text-zinc-500">receiving…</p>}
          {result && !streaming && (
            <p className="pt-1 text-[11px] text-zinc-500">Decisions and outcomes above are the Rationode pipeline&apos;s output
              for these events; they are now written to Neo4j.</p>
          )}
        </div>
      </section>

      {/* Story, journey, trees */}
      <section className={`${panel ? "hidden" : "flex"} min-h-0 flex-col gap-3`}>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          {result && !streaming ? (
            <>
              <p className="text-xs uppercase tracking-wider text-sky-400">{result.set ? `The story in Set ${result.set}` : "Live · MCP gateway"}</p>
              <p className="text-lg font-semibold">{result.set ? `${result.story.customer.name}: ${result.story.title}` : result.story.title}</p>
              <p className="text-sm text-zinc-400">{result.story.point}</p>
              <p className="mt-1 text-xs text-zinc-500">{result.set ? "Now selectable on the Streamly live tab."
                : `Journey below: ${result.story.customer.email} (latest ticket).`}</p>
            </>
          ) : <p className="text-sm text-zinc-500">{streaming ? "Reading the events…" : "The story appears once a set is loaded."}</p>}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
          <header className="flex items-center justify-between rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Journey · live from Neo4j</h2>
            <span className="flex items-center gap-2">
              <span className="flex overflow-hidden rounded-md border border-zinc-700 text-xs">
                {(["graph", "table"] as const).map((m) => (
                  <button key={m} onClick={() => setMode(m)}
                          className={`px-2 py-0.5 capitalize ${mode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-400"}`}>{m}</button>
                ))}
              </span>
              <button onClick={() => setGraphExpanded(true)} disabled={!graph.nodes.length} title="Expand"
                      className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">⤢ Expand</button>
            </span>
          </header>
          <div className="min-h-0 flex-1">
            {active && !panel && !graphExpanded && graph.nodes.length > 0 && !streaming &&
              (mode === "graph" ? <GraphView nodes={graph.nodes} rels={graph.rels} /> : <GraphTable nodes={graph.nodes} rels={graph.rels} />)}
          </div>
        </div>

        <div className="max-h-[38%] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <header className="rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Decision trees updated</h2>
          </header>
          <div className="space-y-2 p-4 text-xs">
            {(!result || streaming) && <p className="text-zinc-500">Branches the new decisions land in appear here.</p>}
            {result && !streaming && result.branches.map((b) => (
              <div key={b.point_id} className="rounded-md bg-zinc-950 p-2">
                <p className="text-zinc-400">{b.tree}</p>
                <p className="mb-1">{b.branch}</p>
                <p className="text-zinc-300">
                  decisions <b>{b.before.support.toLocaleString()} → {b.after.support.toLocaleString()}</b>
                  {" · "}disputes {pct(b.before.dispute_rate)} → {pct(b.after.dispute_rate)}
                  {" · "}churn {pct(b.before.churn_rate)} → {pct(b.after.churn_rate)}
                  {(b.before.win_rate || b.after.win_rate) ? <>{" · "}won {pct(b.before.win_rate)} → {pct(b.after.win_rate)}</> : null}
                </p>
              </div>
            ))}
            {result && !streaming && result.branches.length === 0 && (
              <p className="text-zinc-500">{result.set ? "No tree branches changed: new options stay out of trees until approved."
                : "Live decisions join the trees once their outcomes arrive (without outcomes they would skew the rates)."}</p>
            )}
          </div>
        </div>
      </section>
      {graphExpanded && active && (
        <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 p-4 backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
              Journey · live from Neo4j <span className="font-normal normal-case text-zinc-500">
                {result ? `· ${result.set ? `Set ${result.set}` : "live"}${result.story.customer.email ? ` · ${result.story.customer.email}` : ""}` : ""}</span></h2>
            <span className="flex items-center gap-2">
              <span className="flex overflow-hidden rounded-md border border-zinc-700 text-xs">
                {(["graph", "table"] as const).map((m) => (
                  <button key={m} onClick={() => setMode(m)}
                          className={`px-2 py-0.5 capitalize ${mode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-400"}`}>{m}</button>
                ))}
              </span>
              <button onClick={() => setGraphExpanded(false)} title="Close (Esc)"
                      className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">✕ Close</button>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
            {mode === "graph" ? <GraphView nodes={graph.nodes} rels={graph.rels} /> : <GraphTable nodes={graph.nodes} rels={graph.rels} />}
          </div>
        </div>
      )}
    </div>
  );
}
