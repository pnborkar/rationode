"use client";

// "Streamly live" (demo spec Section 10.1): customer chat, the agent's thinking, the rep console,
// and the live decision graph.
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { ViewNode, ViewRel } from "@/components/GraphView";

const GraphView = dynamic(() => import("@/components/GraphView"), { ssr: false });
const GraphTable = dynamic(() => import("@/components/GraphTable"), { ssr: false });

type AgentEvent = { type: string; [key: string]: unknown };
type Option = { option: string; n: number; dispute_rate: number; churn_rate: number; avg_cost: number };
type WhatIf = { action: string; branch: string; support: number; dispute_rate: number; churn_rate: number };
type Precedent = {
  similar_decisions: number; search: string; options: Option[]; what_if: WhatIf[];
  neighbours: { decision_id: string; score: number; option: string | null; outcomes: string[] }[];
};
type Proposal = { ticket_id: string; option: string; amount_usd: number; rationale: string };
type Step =
  | { kind: "customer"; data: Record<string, unknown> }
  | { kind: "precedent"; data: Precedent }
  | { kind: "proposal"; data: Proposal };

const SAM = { name: "Sam Okafor", email: "sam.okafor26002@example.com" };
const TICKET = "500001";
const REP = { name: "Maya Chen", team: "Team A" };
const OPTIONS = ["full_refund", "partial_refund", "voucher", "deny", "pause_subscription"];
const DEFAULT_MESSAGE =
  "Hi, I was charged $180 for my annual renewal but I haven't used Streamly at all this year. Can I get a refund?";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const words = (s: string) => s.replaceAll("_", " ");

function Panel({ title, badge, children, className = "" }: {
  title: string; badge?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 ${className}`}>
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
        {badge}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-2 w-full rounded bg-zinc-800">
      <div className={`h-2 rounded ${color}`} style={{ width: `${Math.max(2, Math.round(value * 100))}%` }} />
    </div>
  );
}

function StepCard({ step }: { step: Step }) {
  if (step.kind === "customer") {
    const c = step.data;
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm">
        <p className="text-xs text-zinc-500">get_customer</p>
        <p>Looked up <b>{String(c.name)}</b>: {String(c.tenure_months)} months, {words(String(c.plan))},
          last charge ${String(c.charge_amount_usd)}, {String(c.prior_refunds_90d)} refunds in 90 days.</p>
      </div>
    );
  }
  if (step.kind === "precedent") {
    const p = step.data;
    return (
      <div className="rounded-lg border border-sky-900 bg-sky-950/40 p-3 text-sm">
        <p className="text-xs text-sky-400">check_before_act · Neo4j {p.search}</p>
        <p className="mb-3">Asked the decision graph: <b>{p.similar_decisions} similar decisions</b></p>
        <div className="grid grid-cols-[110px_40px_1fr_1fr] items-center gap-x-3 gap-y-2 text-xs">
          <span className="text-zinc-500">option</span><span className="text-zinc-500">n</span>
          <span className="text-zinc-500">disputes</span><span className="text-zinc-500">churn</span>
          {p.options.map((o) => (
            <div key={o.option} className="contents">
              <span>{words(o.option)}</span><span className="text-zinc-400">{o.n}</span>
              <div className="flex items-center gap-2"><Bar value={o.dispute_rate} color="bg-red-500" />
                <span className="w-8 text-right">{pct(o.dispute_rate)}</span></div>
              <div className="flex items-center gap-2"><Bar value={o.churn_rate} color="bg-amber-500" />
                <span className="w-8 text-right">{pct(o.churn_rate)}</span></div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-500">What-if, through the learned outcome tree</p>
        <ul className="mt-1 space-y-1 text-xs">
          {p.what_if.map((w) => (
            <li key={w.action} className={w.dispute_rate > 0.2 ? "text-red-300" : "text-zinc-300"}>
              If <b>{words(w.action)}</b> → {pct(w.dispute_rate)} disputes · {pct(w.churn_rate)} churn
              <span className="text-zinc-500"> ({w.support} cases)</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const p = step.data;
  return (
    <div className="rounded-lg border border-emerald-700 bg-emerald-950/50 p-3 text-sm">
      <p className="text-xs text-emerald-400">propose_resolution</p>
      <p className="text-base font-semibold">{words(p.option)}{p.amount_usd ? ` · $${p.amount_usd}` : ""}</p>
      <p className="mt-1 text-zinc-300">{p.rationale}</p>
    </div>
  );
}

export default function StreamlyLive() {
  const [graphOn, setGraphOn] = useState(true);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [chat, setChat] = useState<{ from: "sam" | "agent"; text: string }[]>([]);
  const [thinking, setThinking] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [final, setFinal] = useState<{ option: string; overridden: boolean } | null>(null);
  const [overrideTo, setOverrideTo] = useState("full_refund");
  const [running, setRunning] = useState(false);
  const [base, setBase] = useState<{ nodes: ViewNode[]; rels: ViewRel[] }>({ nodes: [], rels: [] });
  const [live, setLive] = useState<{ nodes: ViewNode[]; rels: ViewRel[] }>({ nodes: [], rels: [] });
  const [graphMode, setGraphMode] = useState<"graph" | "table">("graph");
  const [expanded, setExpanded] = useState(false);

  // Esc closes the expanded graph.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sam's existing neighbourhood in the graph (charges, past decisions), read from AuraDB.
  useEffect(() => {
    let alive = true;
    fetch(`/api/graph/customer?email=${encodeURIComponent(SAM.email)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((graph) => { if (alive && graph) setBase(graph); });
    return () => { alive = false; };
  }, []);

  const customerId = base.nodes.find((n) => n.kind === "customer")?.id;
  const addLive = (nodes: ViewNode[], rels: ViewRel[]) =>
    setLive((g) => ({ nodes: [...g.nodes, ...nodes.filter((n) => !g.nodes.some((x) => x.id === n.id))],
                      rels: [...g.rels, ...rels.filter((r) => !g.rels.some((x) => x.id === r.id))] }));

  function reset() {
    setChat([]); setThinking(""); setSteps([]); setProposal(null); setFinal(null);
    setLive({ nodes: [], rels: [] });
  }

  async function send() {
    reset();
    setRunning(true);
    setChat([{ from: "sam", text: message }]);
    const caseId = `case:${TICKET}`;
    addLive([{ id: caseId, kind: "case", label: "Sam's complaint", live: true }], []);

    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket_id: TICKET, customer_email: SAM.email, channel: "chat", message, graph: graphOn }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reply = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const e = JSON.parse(part.slice(6)) as AgentEvent;
        if (e.type === "thinking") setThinking((t) => t + (e.text as string));
        else if (e.type === "text") {
          reply += e.text as string;
          setChat([{ from: "sam", text: message }, { from: "agent", text: reply }]);
        } else if (e.type === "tool_call") {
          // Text before a tool call is the agent narrating, not the reply to Sam.
          reply = "";
          setChat([{ from: "sam", text: message }]);
        } else if (e.type === "tool_result" && e.name === "get_customer" && !e.is_error) {
          setSteps((s) => [...s, { kind: "customer", data: e.result as Record<string, unknown> }]);
        } else if (e.type === "tool_result" && e.name === "check_before_act" && !e.is_error) {
          const p = e.result as Precedent;
          setSteps((s) => [...s, { kind: "precedent", data: p }]);
          addLive(p.neighbours.map((n) => ({ id: n.decision_id, kind: "precedent", label: "past decision",
                                             option: n.option, outcomes: n.outcomes,
                                             detail: `similarity ${n.score.toFixed(3)} · ${n.decision_id}` })),
                  p.neighbours.map((n) => ({ id: `${caseId}~${n.decision_id}`, from: caseId, to: n.decision_id,
                                             type: "SIMILAR_TO" })));
        } else if (e.type === "proposal") {
          const p = e as unknown as Proposal;
          setProposal(p);
          setSteps((s) => [...s, { kind: "proposal", data: p }]);
          addLive([{ id: `proposal:${TICKET}`, kind: "proposal", label: `AI proposal\n${words(p.option)}`, live: true }],
                  [{ id: `${caseId}->proposal`, from: caseId, to: `proposal:${TICKET}`, type: "PROPOSED" }]);
        }
      }
    }
    setRunning(false);
  }

  function decide(option: string) {
    if (!proposal) return;
    const overridden = option !== proposal.option;
    setFinal({ option, overridden });
    const finalId = `final:${TICKET}`;
    addLive([{ id: finalId, kind: "final", label: `${REP.name}\n${words(option)}`, live: true }],
            [{ id: `${finalId}->proposal`, from: finalId, to: `proposal:${TICKET}`, type: overridden ? "OVERRIDES" : "APPROVED" }]);
  }

  const nodes = [...base.nodes, ...live.nodes];
  // Link the live case to Sam at render time, so it holds even if Sam's history loads after Send.
  const caseLink: ViewRel[] = customerId && live.nodes.some((n) => n.kind === "case")
    ? [{ id: `case:${TICKET}->${customerId}`, from: `case:${TICKET}`, to: customerId, type: "ABOUT" }] : [];
  const rels = [...base.rels, ...live.rels, ...caseLink];

  const legend = (
    <span className="flex gap-3 text-[10px] text-zinc-400">
      <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-green-500" />no dispute</span>
      <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />churned</span>
      <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500" />disputed</span>
    </span>
  );
  const graphControls = (
    <span className="flex items-center gap-3">
      {graphMode === "graph" && legend}
      <span className="flex overflow-hidden rounded-md border border-zinc-700 text-xs">
        {(["graph", "table"] as const).map((m) => (
          <button key={m} onClick={() => setGraphMode(m)}
                  className={`px-2 py-0.5 capitalize ${graphMode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-400"}`}>
            {m}
          </button>
        ))}
      </span>
      <button onClick={() => setExpanded((x) => !x)} title={expanded ? "Close (Esc)" : "Expand"}
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">
        {expanded ? "✕ Close" : "⤢ Expand"}
      </button>
    </span>
  );
  const graphBody = nodes.length === 0 ? null
    : graphMode === "graph" ? <GraphView nodes={nodes} rels={rels} /> : <GraphTable nodes={nodes} rels={rels} />;

  return (
    <main className="flex h-screen flex-col gap-3 p-3">
      <header className="flex items-center justify-between px-1">
        <div>
          <h1 className="text-lg font-semibold">Rationode <span className="text-zinc-500">· Streamly live</span></h1>
          <p className="text-xs text-zinc-500">Every decision from AI, humans, and systems, in one Neo4j graph</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setGraphOn((g) => !g)} disabled={running}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                    graphOn ? "bg-sky-500 text-zinc-950" : "bg-zinc-800 text-zinc-300"}`}>
            Decision graph: {graphOn ? "ON" : "OFF"}
          </button>
          <button onClick={reset} disabled={running} className="rounded-full bg-zinc-800 px-3 py-1.5 text-sm">Reset</button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
        <Panel title="Streamly help chat" badge={<span className="text-xs text-zinc-500">{SAM.name}</span>}>
          <div className="flex h-full flex-col">
            <div className="flex-1 space-y-3">
              {chat.map((m, i) => (
                <div key={i} className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                  m.from === "sam" ? "ml-auto bg-violet-600" : "bg-zinc-800"}`}>
                  {m.text}
                </div>
              ))}
              {running && !chat.some((m) => m.from === "agent") && (
                <div className="w-fit rounded-2xl bg-zinc-800 px-4 py-2 text-sm text-zinc-400">Streamly assistant is typing…</div>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2}
                        className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm" />
              <button onClick={send} disabled={running}
                      className="rounded-lg bg-violet-600 px-4 text-sm font-semibold disabled:opacity-50">Send</button>
            </div>
          </div>
        </Panel>

        <Panel title="Agent's thinking" badge={<span className="text-xs text-zinc-500">
          claude-opus-5 · prompt v2 · graph {graphOn ? "on" : "off"}</span>}>
          <div className="space-y-3">
            {thinking && <p className="text-sm italic text-zinc-400">“{thinking.trim()}”</p>}
            {!graphOn && steps.length > 0 && (
              <p className="text-xs text-zinc-500">Decision graph off: the agent has only its instructions.</p>
            )}
            {steps.map((s, i) => <StepCard key={i} step={s} />)}
            {!steps.length && !running && <p className="text-sm text-zinc-500">Send Sam&apos;s message to start.</p>}
          </div>
        </Panel>

        <Panel title="Support rep console" badge={<span className="text-xs text-zinc-500">{REP.name} · {REP.team}</span>}>
          {!proposal ? (
            <p className="text-sm text-zinc-500">Waiting for the AI&apos;s proposal on ticket #{TICKET}…</p>
          ) : (
            <div className="space-y-4 text-sm">
              <div>
                <p className="text-xs text-zinc-500">Ticket #{TICKET} · AI suggests</p>
                <p className="text-xl font-semibold">{words(proposal.option)}
                  {proposal.amount_usd ? ` · $${proposal.amount_usd}` : ""}</p>
                <p className="mt-1 text-zinc-400">{proposal.rationale}</p>
              </div>
              {final ? (
                <p className={`rounded-lg p-3 ${final.overridden ? "bg-red-950 text-red-200" : "bg-emerald-950 text-emerald-200"}`}>
                  {final.overridden ? `Overridden → ${words(final.option)}` : "Approved"} by {REP.name}.
                  Shown in the graph view{final.overridden ? ", linked to the AI proposal it overrides" : ""}
                  <span className="opacity-60"> (written to Neo4j once the live pipeline is connected)</span>.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => decide(proposal.option)}
                          className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold">Approve</button>
                  <span className="text-zinc-500">or</span>
                  <select value={overrideTo} onChange={(e) => setOverrideTo(e.target.value)}
                          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2">
                    {OPTIONS.filter((o) => o !== proposal.option).map((o) => <option key={o} value={o}>{words(o)}</option>)}
                  </select>
                  <button onClick={() => decide(overrideTo)} className="rounded-lg bg-zinc-700 px-4 py-2 font-semibold">
                    Override</button>
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Decision graph · live from Neo4j" className="overflow-hidden" badge={graphControls}>
          <div className="-m-4 h-[calc(100%+2rem)]">{!expanded && graphBody}</div>
        </Panel>
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 p-4 backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Decision graph · live from Neo4j</h2>
            {graphControls}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">{graphBody}</div>
        </div>
      )}
    </main>
  );
}
