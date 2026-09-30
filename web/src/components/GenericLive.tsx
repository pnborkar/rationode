"use client";
// The generic Live tab (demo spec §23.8, refined option C) for workspaces without the Streamly support demo: a case
// replayed from the loaded data (only what was known then) -> the AI proposes from similar past cases -> a person
// approves or overrides -> "reveal what really happened": the real decision and its outcome, beside the AI's and yours.
import dynamic from "next/dynamic";
import { useState } from "react";
import type { ViewNode, ViewRel } from "./GraphView";

const GraphView = dynamic(() => import("./GraphView"), { ssr: false });

type Case = { id: string; decision_type: string; decided_at: string; subject: { id: string; label: string; key: string };
              parent: { id: string; label: string; key: string } | null; facts: Record<string, unknown>;
              options: { option: string; n: number }[]; details: string[]; related: string[] };
type Proposal = { option: string; amount: number | null; details: Record<string, unknown>; rationale: string };
type Reveal = { option: string | null; amount: number | null; details: Record<string, unknown> | null; actor: string | null; kind: string | null;
                at: string; outcomes: { type: string; polarity: string | null; value: number | null }[] };

const words = (s: string) => s.replaceAll("_", " ");
const factName = (k: string) => words(k.split(".").slice(1).join("."));

function Panel({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center justify-between rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>{badge}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

export default function GenericLive({ workspace }: { workspace: string }) {
  const [c, setCase] = useState<Case | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [overrideTo, setOverrideTo] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<{ option: string; amount: number | null; reason: string; overridden: boolean } | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [graph, setGraph] = useState<{ nodes: ViewNode[]; rels: ViewRel[] } | null>(null);

  function clear() {
    setThinking(""); setSteps([]); setProposal(null); setDecision(null); setReveal(null); setGraph(null); setReason(""); setError(null);
  }

  async function nextCase() {
    clear(); setCase(null);
    const res = await fetch("/api/cases");
    const data = await res.json();
    if (res.ok) setCase(data); else setError(data.error ?? res.statusText);
  }

  async function askAI() {
    if (!c) return;
    clear(); setRunning(true);
    const res = await fetch("/api/cases/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
    if (!res.ok || !res.body) { setError((await res.json().catch(() => ({}))).error ?? res.statusText); setRunning(false); return; }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        const e = JSON.parse(p.slice(6));
        if (e.type === "thinking") setThinking((t) => t + e.text);
        else if (e.type === "tool_result") setSteps((s) => [...s, `${words(e.name)} → ${e.summary}`]);
        else if (e.type === "proposal") {
          setProposal(e);
          setOverrideTo(c.options.find((o) => o.option !== e.option)?.option ?? e.option);
          setAmount(e.amount != null ? String(e.amount) : "");
        } else if (e.type === "error") setError(e.message);
      }
    }
    setRunning(false);
  }

  function decide(approve: boolean) {
    if (!proposal) return;
    const n = Number(amount);
    setDecision(approve ? { option: proposal.option, amount: proposal.amount, reason: "", overridden: false }
      : { option: overrideTo, amount: amount.trim() && Number.isFinite(n) ? n : null, reason: reason.trim(), overridden: true });
  }

  async function showReveal() {
    if (!c) return;
    const r = await fetch(`/api/cases/reveal?id=${encodeURIComponent(c.id)}`);
    if (r.ok) setReveal(await r.json());
    const g = await fetch(`/api/graph/subject?id=${encodeURIComponent(c.parent?.id ?? c.subject.id)}`);
    if (g.ok) setGraph(await g.json());
  }

  const tone = (p: string | null) => (p === "good" ? "text-emerald-400" : p === "bad" ? "text-red-400" : "text-zinc-300");
  const ended = reveal ? (reveal.outcomes.some((o) => o.polarity === "bad") ? "bad" : reveal.outcomes.some((o) => o.polarity === "good") ? "good" : null) : null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
      <Panel title="Case" badge={
        <button onClick={nextCase} disabled={running} className="rounded-md bg-zinc-700 px-3 py-1 text-xs font-semibold disabled:opacity-40">
          {c ? "Next case" : "Replay a past case"}</button>}>
        {!c ? (
          <div className="space-y-2 text-sm text-zinc-400">
            <p>Live for <b className="text-zinc-200">{workspace}</b>: a real past case from the loaded data, shown as if it were new: only the facts known then. Its real decision and outcome stay hidden until you reveal them.</p>
            <p>The AI proposes from similar past cases (this case and others about the same subject are kept out), you approve or override, then see what really happened.</p>
            {error && <p className="text-red-400">{error}</p>}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-zinc-500">Replayed from the loaded data · decision needed: <b className="text-zinc-300">{words(c.decision_type)}</b></p>
            <p className="font-semibold">{c.subject.label} {c.subject.key}{c.parent && <span className="font-normal text-zinc-400"> · part of {c.parent.label} {c.parent.key}</span>}</p>
            <table className="text-sm"><tbody>{Object.entries(c.facts).map(([k, v]) => (
              <tr key={k}><td className="pr-4 text-zinc-500">{factName(k)}</td><td className="font-mono">{String(v)}</td></tr>
            ))}</tbody></table>
            <p className="text-xs text-zinc-500">Options chosen for this decision in the past: {c.options.map((o) => `${words(o.option)} (${o.n})`).join(", ")}</p>
            <button onClick={askAI} disabled={running} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {running ? "The AI is looking at similar cases…" : proposal ? "Ask the AI again" : "Ask the AI for a decision"}</button>
          </div>
        )}
      </Panel>

      <Panel title="AI's reasoning">
        {!thinking && !steps.length ? <p className="text-sm text-zinc-500">Ask the AI to see its reasoning and the graph queries behind it.</p> : (
          <div className="space-y-3 text-sm">
            {thinking && <p className="whitespace-pre-wrap italic text-zinc-300">“{thinking.trim()}”</p>}
            <ul className="space-y-1 text-xs text-zinc-400">{steps.map((s, i) => <li key={i}>• {s}</li>)}</ul>
            <p className="text-[11px] text-zinc-500">Aggregate outcome rates include this case as one of all past decisions; the similar-case search leaves it and related decisions out.</p>
          </div>
        )}
      </Panel>

      <Panel title="Decision">
        {!proposal ? <p className="text-sm text-zinc-500">Waiting for the AI&apos;s proposal…</p> : (
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs text-zinc-500">AI proposes</p>
              <p className="text-lg font-semibold">{words(proposal.option)}{proposal.amount != null ? ` · ${proposal.amount}` : ""}</p>
              {Object.keys(proposal.details).length > 0 && <p className="text-xs text-zinc-400">{Object.entries(proposal.details).map(([k, v]) => `${words(k)} ${v}`).join(" · ")}</p>}
              <p className="mt-1 text-zinc-400">{proposal.rationale}</p>
            </div>
            {!decision ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => decide(true)} className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white">Approve</button>
                  <span className="text-zinc-500">or</span>
                  {c && c.options.length > 1 && (
                    <select value={overrideTo} onChange={(e) => setOverrideTo(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2">
                      {c.options.map((o) => <option key={o.option} value={o.option}>{words(o.option)}</option>)}
                    </select>
                  )}
                  <label className="flex items-center gap-1 text-zinc-400">amount
                    <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                           className="w-24 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-100" /></label>
                  <button onClick={() => decide(false)} className="rounded-lg bg-zinc-700 px-4 py-2 font-semibold">Override</button>
                </div>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for overriding (optional)"
                       className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm" />
              </div>
            ) : (
              <div className={`space-y-1 rounded-lg p-3 ${decision.overridden ? "bg-red-950 text-red-100" : "bg-emerald-950 text-emerald-100"}`}>
                <p className="font-semibold">Your decision: {words(decision.option)}{decision.amount != null ? ` · ${decision.amount}` : ""}</p>
                <p className="text-xs">Approved AI proposal: <b>{decision.overridden ? "No" : "Yes"}</b>{decision.reason ? ` · reason: ${decision.reason}` : ""}</p>
                <p className="text-[11px] opacity-60">Replay: not recorded in the graph.</p>
                {!reveal && <button onClick={showReveal} className="mt-1 rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white">Reveal what really happened →</button>}
              </div>
            )}
            {reveal && (
              <div className="space-y-1 rounded-lg border border-zinc-700 bg-zinc-950/70 p-3 text-xs">
                <p className="font-semibold text-zinc-200">What really happened</p>
                <p>The real decision: <b>{words(reveal.option ?? "?")}{reveal.amount != null ? ` · ${reveal.amount}` : ""}</b> by {reveal.actor} ({(reveal.kind ?? "").toLowerCase()}) on {reveal.at.slice(0, 10)}
                  {reveal.details && Object.keys(reveal.details).length ? ` · ${Object.entries(reveal.details).map(([k, v]) => `${words(k)} ${v}`).join(" · ")}` : ""}</p>
                <p>It led to: {reveal.outcomes.length ? reveal.outcomes.map((o, i) => (
                  <span key={i} className={tone(o.polarity)}>{i ? ", " : ""}{words(o.type)}{o.value != null ? ` ${o.value}` : ""}</span>)) : "no outcome recorded"}</p>
                <p className="text-zinc-400">AI proposed {words(proposal.option)}{proposal.amount != null ? ` · ${proposal.amount}` : ""}; you chose {words(decision?.option ?? "")}{decision?.amount != null ? ` · ${decision.amount}` : ""};
                  the real decision was {words(reveal.option ?? "?")}{reveal.amount != null ? ` · ${reveal.amount}` : ""}, and it ended <b className={tone(ended)}>{ended ?? "without a recorded outcome"}</b>.</p>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Decision graph · live from Neo4j">
        {graph && graph.nodes.length ? <div className="-m-4 h-[calc(100%+2rem)]"><GraphView nodes={graph.nodes} rels={graph.rels} /></div>
          : <p className="text-sm text-zinc-500">{reveal ? "Loading…" : "Hidden until you reveal what happened (it would show the ending)."}</p>}
      </Panel>
    </div>
  );
}
