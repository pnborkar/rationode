"use client";

// "Streamly live" (demo spec Section 10.1): customer chat, the agent's thinking, the rep console,
// and the live decision graph.
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { ViewNode, ViewRel } from "@/components/GraphView";
import EventsTab from "@/components/EventsTab";
import SettingsTab from "@/components/SettingsTab";
import ThemeToggle from "@/components/ThemeToggle";
import { LIVE_CASES, type LiveCase } from "@/lib/liveCases";

// The tenant this app serves (demo spec §21). The Streamly demo ("history") has prepared live customers
// and Events-tab sets; another tenant (e.g. loaded from Databricks) shows only its own customers.
const DEMO = (process.env.NEXT_PUBLIC_RATIONODE_TENANT ?? "history") === "history";
const PREPARED: LiveCase[] = DEMO ? LIVE_CASES : [];
const EMPTY: LiveCase = {
  key: "none", name: "No customers yet", email: "", ticket_id: "", message: "",
  blurb: "This tenant has no customers yet: load its data on the Events tab (Connect a source), then build its trees.",
};
import { MACRO_OPTION } from "@/lib/nativeAdapter";

// The Zendesk macro for each option (the rep's action, sent through the Zendesk webhook).
const MACRO_FOR = Object.fromEntries(Object.entries(MACRO_OPTION).map(([title, option]) => [option, title]));
type Recorded = { decisions: { id: string; type: string; stage: string }[]; overrides: number;
                  ticket_decisions?: { id: string; stage: string }[] };

const GraphView = dynamic(() => import("@/components/GraphView"), { ssr: false });
const GraphTable = dynamic(() => import("@/components/GraphTable"), { ssr: false });

type AgentEvent = { type: string; [key: string]: unknown };
type Option = { option: string; n: number; dispute_rate: number; churn_rate: number; avg_cost: number };
type WhatIf = { action: string; branch: string; support: number; dispute_rate: number; churn_rate: number };
type Precedent = {
  similar_decisions: number; search: string; options: Option[]; what_if: WhatIf[];
  neighbours: { decision_id: string; score: number; option: string | null; outcomes: string[] }[];
  usage_link?: {
    basis: string;
    dispute_precedent: { question: string; disputes: number; win_rate: number | null };
    if_denied: { dispute_rate: number | null; cost_if_disputed: number; expected_dispute_cost: number; assumes: string } | null;
  } | null;
};
type Proposal = { ticket_id: string; option: string; amount_usd: number; rationale: string };
type Usage = {
  usage_data: boolean; note?: string;
  weeks?: { week_start: string; hours: number; titles: number; after_charge: boolean }[];
  latest_charge?: { date: string; amount_usd: number };
  hours_since_charge?: number; weeks_since_charge?: number; last_watched_week?: string | null; trend?: string;
};
type Step = ({
    kind: "customer"; data: Record<string, unknown> }
  | { kind: "usage"; data: Usage }
  | { kind: "precedent"; data: Precedent }
  | { kind: "fraud"; data: FraudPatterns }
  | { kind: "proposal"; data: Proposal }) & { via?: string; ms?: number };
type FraudPatterns = { facts: string[]; cluster: { accounts: number; unauthorized_disputes: number };
                       history_baseline: { unauthorized_dispute_rate: number } };

const REP = { name: "Maya Chen", team: "Team A" };
const OPTIONS = ["full_refund", "partial_refund", "voucher", "deny", "pause_subscription"];

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const words = (s: string) => s.replaceAll("_", " ");

function Panel({ title, badge, children, className = "" }: {
  title: string; badge?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 ${className}`}>
      <header className="flex items-center justify-between rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
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
          last charge ${String(c.charge_amount_usd)}, {String(c.prior_refunds_90d)} refunds in 90 days
          {Number(c.latest_charge_refunded_usd) > 0 && <> · <b>latest charge already refunded ${String(c.latest_charge_refunded_usd)}</b></>}.</p>
      </div>
    );
  }
  if (step.kind === "usage") {
    const u = step.data;
    if (!u.usage_data) {
      return (
        <div className="rounded-lg border border-teal-900 bg-teal-950/30 p-3 text-sm">
          <p className="text-xs text-teal-400">check_usage_patterns · Streamly app</p>
          <p>{u.note}</p>
        </div>
      );
    }
    const max = Math.max(1, ...u.weeks!.map((w) => w.hours));
    return (
      <div className="rounded-lg border border-teal-900 bg-teal-950/30 p-3 text-sm">
        <p className="text-xs text-teal-400">check_usage_patterns · Streamly app</p>
        <div className="mt-2 flex h-16 items-end gap-1.5">
          {u.weeks!.map((w) => (
            <div key={w.week_start} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[10px] text-zinc-400">{w.hours}h</span>
              <div className={`w-full rounded-t ${w.after_charge ? "bg-teal-400" : "bg-zinc-600"}`}
                   style={{ height: `${Math.max(3, (w.hours / max) * 40)}px` }}
                   title={`week of ${w.week_start}: ${w.hours} h, ${w.titles} titles`} />
              <span className="text-[9px] text-zinc-500">{w.week_start.slice(5)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2">
          Since the ${u.latest_charge!.amount_usd} charge on {u.latest_charge!.date}: <b>{u.hours_since_charge} h</b> across
          {" "}{u.weeks_since_charge} weeks · last watched {u.last_watched_week ? `week of ${u.last_watched_week}` : "—"} ·
          trend: {u.trend}
        </p>
        <p className="text-[10px] text-zinc-500">Highlighted bars: weeks after the latest charge.</p>
      </div>
    );
  }
  if (step.kind === "fraud") {
    const f = step.data;
    const alarming = (t: string) => /[1-9]\d* with unauthorized|[1-9]\d* had unauthorized|added \d+ day|login came from|written policy says|different cards/.test(t);
    return (
      <div className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm">
        <p className="text-xs text-rose-400">check_fraud_patterns · Neo4j identity graph (cards, devices, shared accounts)</p>
        <ul className="mt-2 space-y-1 text-xs">
          {f.facts.map((t) => (
            <li key={t} className={alarming(t) ? "text-rose-200" : "text-zinc-300"}>{alarming(t) ? "▲ " : "· "}{t}</li>
          ))}
        </ul>
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
        {p.usage_link && (
          <div className="mt-3 rounded-md border border-teal-800 bg-teal-950/40 p-2 text-xs">
            <p className="text-teal-300">Linked with viewing · customer {p.usage_link.basis}</p>
            <p className="mt-1">
              {p.usage_link.dispute_precedent.question}: <b>won {pct(p.usage_link.dispute_precedent.win_rate)}</b>
              <span className="text-zinc-500"> ({p.usage_link.dispute_precedent.disputes} disputes)</span>
            </p>
            {p.usage_link.if_denied && (
              <p className="mt-1">
                If denied: {pct(p.usage_link.if_denied.dispute_rate)} dispute chance × ${p.usage_link.if_denied.cost_if_disputed} if
                disputed = <b>${p.usage_link.if_denied.expected_dispute_cost} expected</b>
                <span className="text-zinc-500"> ({p.usage_link.if_denied.assumes})</span>
              </p>
            )}
          </div>
        )}
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

// Customers from sets loaded on the Events tab, as live-tab cases.
type SetInfo = { set: number; loaded: boolean;
                 story: { key: string; title: string; point: string; message: string; via_bank: boolean;
                          customer: { name: string; email: string } } | null };
const toCases = (sets: SetInfo[]): LiveCase[] => sets.filter((s) => s.loaded && s.story).map((s) => ({
  key: `set-${s.set}`, name: s.story!.customer.name, email: s.story!.customer.email, ticket_id: `51000${s.set}`,
  blurb: `Loaded from Events · Set ${s.set}: ${s.story!.title}. ${s.story!.point}`, message: s.story!.message,
  setNumber: s.set,
  note: s.story!.via_bank
    ? `${s.story!.customer.name.split(" ")[0]} went to their bank, not support. Sending this message here asks: what if they had contacted support first? (Their real story is a card dispute.)`
    : undefined,
}));

// Customers from batches uploaded on the Events tab ("Connect a source") who have a case in the files.
type UploadedCase = { scenario: string; email: string; name: string; message: string; via_bank: boolean; case_in_files: string };
const toUploadCases = (rows: UploadedCase[]): LiveCase[] => rows.map((u, i) => ({
  key: `up-${u.email}`, name: u.name, email: u.email, ticket_id: `52${String(i + 1).padStart(4, "0")}`,
  blurb: `Uploaded (${u.scenario}). Their case in the files: ${u.case_in_files}.`, message: u.message, scenario: u.scenario,
  question: u.case_in_files,
  note: u.via_bank
    ? `${u.name.split(" ")[0]} went to their bank, not support. Sending this message here asks: what if they had contacted support first?`
    : undefined,
}));

// A tenant's customers grouped by their case (hundreds of customers, a handful of questions), largest
// group first: the dropdown lists the questions, the chat box the customers who asked the one chosen.
// Names repeat, so a repeated name within a group shows the email's name part too.
function byQuestion(cases: LiveCase[]): [string, (LiveCase & { sameName: boolean })[]][] {
  const groups = new Map<string, LiveCase[]>();
  for (const c of cases) groups.set(c.question ?? "", [...(groups.get(c.question ?? "") ?? []), c]);
  return [...groups].sort((a, b) => b[1].length - a[1].length).map(([q, cs]) => {
    const count = new Map<string, number>();
    cs.forEach((c) => count.set(c.name, (count.get(c.name) ?? 0) + 1));
    return [q, [...cs].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, sameName: count.get(c.name)! > 1 }))];
  });
}
const capital = (s: string) => s.replace(/^./, (x) => x.toUpperCase());

export default function StreamlyLive() {
  const [tab, setTab] = useState<"live" | "events" | "settings">("live");
  const [storyCases, setStoryCases] = useState<LiveCase[]>([]);
  const [uploadCases, setUploadCases] = useState<LiveCase[]>([]);
  const cases = [...PREPARED, ...storyCases, ...uploadCases];
  const [caseKey, setCaseKey] = useState((PREPARED[0] ?? EMPTY).key);
  // Another tenant: the question chosen in the dropdown; caseKey "pick" until a customer who asked it is picked.
  const [question, setQuestion] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const groups = DEMO ? [] : byQuestion(uploadCases);
  const asked = groups.find(([q]) => q === question)?.[1] ?? [];
  const current = cases.find((c) => c.key === caseKey)
    ?? (caseKey === "pick" ? { ...EMPTY, key: "pick", name: "", blurb: `${asked.length} customers asked this. Pick one to answer.` }
      : PREPARED[0] ?? cases[0] ?? EMPTY);
  const TICKET = current.ticket_id;
  const [graphOn, setGraphOn] = useState(true);
  const [message, setMessage] = useState((PREPARED[0] ?? EMPTY).message);
  const [chat, setChat] = useState<{ from: "sam" | "agent"; text: string }[]>([]);
  const [thinking, setThinking] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [final, setFinal] = useState<{ option: string; overridden: boolean } | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [liveOfCustomer, setLiveOfCustomer] = useState<{ tickets: string[]; decisions: number }>({ tickets: [], decisions: 0 });
  const proposalVia = useRef<{ via?: string; ms?: number }>({});
  const [overrideTo, setOverrideTo] = useState("full_refund");
  const [running, setRunning] = useState(false);
  const [base, setBase] = useState<{ nodes: ViewNode[]; rels: ViewRel[] }>({ nodes: [], rels: [] });
  const [live, setLive] = useState<{ nodes: ViewNode[]; rels: ViewRel[] }>({ nodes: [], rels: [] });
  const [graphMode, setGraphMode] = useState<"graph" | "table">("graph");
  const [expanded, setExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [agentModel, setAgentModel] = useState("");   // from Settings (or the environment)

  // Customers from sets loaded, and batches uploaded, on the Events tab join the dropdown.
  const caseKeyRef = useRef(caseKey);
  useEffect(() => { caseKeyRef.current = caseKey; }, [caseKey]);
  const refreshStories = async () => {
    const [sets, rows]: [SetInfo[], UploadedCase[]] = await Promise.all([
      fetch("/api/stories").then((r) => r.json()), fetch("/api/upload/cases").then((r) => r.json())]);
    const s = toCases(sets), u = toUploadCases(rows);
    setStoryCases(s);
    setUploadCases(u);
    // The selected customer's set or batch was removed: start over on the first live case.
    if (caseKeyRef.current !== "pick" && ![...PREPARED, ...s, ...u].some((c) => c.key === caseKeyRef.current)) {
      const first = PREPARED[0] ?? u[0] ?? EMPTY;
      setCaseKey(first.key);
      setMessage(first.message);
      setBase({ nodes: [], rels: [] });
      reset();
    }
  };
  useEffect(() => {
    fetch("/api/settings/ai").then((r) => r.json()).then((a) => setAgentModel(a.agentModel)).catch(() => {});
  }, [tab]);
  useEffect(() => {
    let alive = true;
    fetch("/api/stories").then((r) => r.json()).then((sets: SetInfo[]) => { if (alive) setStoryCases(toCases(sets)); });
    fetch("/api/upload/cases").then((r) => r.json()).then((rows: UploadedCase[]) => {
      if (!alive) return;
      const u = toUploadCases(rows);
      setUploadCases(u);
      // Another tenant has no prepared customers: start on its most-asked question.
      const [first] = byQuestion(u);
      if (!DEMO && first && caseKeyRef.current === "none") { setQuestion(first[0]); setCaseKey("pick"); setMessage(""); }
    });
    return () => { alive = false; };
  }, []);

  async function removeStory(n: number) {
    await fetch(`/api/stories/${n}`, { method: "DELETE" });
    await refreshStories();
    pickCase((PREPARED[0] ?? EMPTY).key);
  }

  // Esc closes the expanded graph or thinking panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setExpanded(false); setThinkingExpanded(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The customer's existing neighbourhood in the graph (charges, past decisions), read from AuraDB,
  // and how many live decisions (gateway + webhook) are recorded for them.
  useEffect(() => {
    let alive = true;
    fetch(`/api/graph/customer?email=${encodeURIComponent(current.email)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((graph) => { if (alive && graph) setBase(graph); });
    fetch(`/api/live?email=${encodeURIComponent(current.email)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((l) => { if (alive && l) setLiveOfCustomer(l); });
    return () => { alive = false; };
  }, [current.email]);

  const refreshLiveOfCustomer = async () => {
    const res = await fetch(`/api/live?email=${encodeURIComponent(current.email)}`);
    if (res.ok) setLiveOfCustomer(await res.json());
  };

  // "Clear <customer>'s live decisions": all their live tickets in Neo4j; history, sets, uploads untouched.
  async function clearLive() {
    const first = current.name.split(" ")[0];
    if (!window.confirm(`Delete ${first}'s live decisions from Neo4j (${liveOfCustomer.decisions} decisions on ` +
                        `${liveOfCustomer.tickets.length} ticket(s))? Their history, other customers, sets and uploads stay.`)) return;
    const res = await fetch(`/api/live?email=${encodeURIComponent(current.email)}`, { method: "DELETE" });
    if (!res.ok) return;
    reset();
    setLiveOfCustomer({ tickets: [], decisions: 0 });
    const g = await fetch(`/api/graph/customer?email=${encodeURIComponent(current.email)}`);
    if (g.ok) setBase(await g.json());
  }

  const customerId = base.nodes.find((n) => n.kind === "customer")?.id;
  const addLive = (nodes: ViewNode[], rels: ViewRel[]) =>
    setLive((g) => ({ nodes: [...g.nodes, ...nodes.filter((n) => !g.nodes.some((x) => x.id === n.id))],
                      rels: [...g.rels, ...rels.filter((r) => !g.rels.some((x) => x.id === r.id))] }));

  function pickCase(key: string) {
    const next = cases.find((c) => c.key === key) ?? PREPARED[0] ?? cases[0] ?? EMPTY;
    setCaseKey(key);
    setMessage(next.message);
    setBase({ nodes: [], rels: [] });
    reset();
  }

  function pickQuestion(q: string) {
    setQuestion(q);
    setCustomerFilter("");
    setCaseKey("pick");
    setMessage("");
    setBase({ nodes: [], rels: [] });
    reset();
  }

  function reset() {
    setChat([]); setThinking(""); setSteps([]); setProposal(null); setFinal(null); setRecorded(null);
    setLive({ nodes: [], rels: [] });
  }

  async function send() {
    reset();
    setRunning(true);
    setChat([{ from: "sam", text: message }]);
    const caseId = `case:${TICKET}`;
    addLive([{ id: caseId, kind: "case", label: `${current.name.split(" ")[0]}'s complaint`, live: true }], []);

    // The chat opens a Zendesk ticket (webhook); re-running a case starts its ticket afresh.
    await fetch("/api/webhooks/zendesk", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ticket.created", ticket: {
        id: TICKET, subject: message.split(/[.?!]/)[0].slice(0, 60), description: message,
        requester: { email: current.email, name: current.name }, via: { channel: "chat" }, tags: [], custom_fields: [] } }),
    }).catch(() => {});
    proposalVia.current = {};
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket_id: TICKET, customer_email: current.email, channel: "chat", message, graph: graphOn }),
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
          setSteps((s) => [...s, { kind: "customer", data: e.result as Record<string, unknown>, via: e.via as string, ms: e.ms as number }]);
        } else if (e.type === "tool_result" && e.name === "check_usage_patterns" && !e.is_error) {
          setSteps((s) => [...s, { kind: "usage", data: e.result as Usage, via: e.via as string, ms: e.ms as number }]);
        } else if (e.type === "tool_result" && e.name === "propose_resolution" && !e.is_error) {
          proposalVia.current = { via: e.via as string, ms: e.ms as number };
        } else if (e.type === "tool_result" && e.name === "check_fraud_patterns" && !e.is_error) {
          setSteps((s) => [...s, { kind: "fraud", data: e.result as FraudPatterns }]);
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
          const via = proposalVia.current;
          setSteps((s) => [...s, { kind: "proposal", data: p, ...via }]);
          addLive([{ id: `proposal:${TICKET}`, kind: "proposal", label: `AI: ${words(p.option)}`, option: p.option,
                     detail: `AI proposal · $${p.amount_usd}`, live: true }],
                  [{ id: `${caseId}->proposal`, from: caseId, to: `proposal:${TICKET}`, type: "PROPOSED" }]);
        }
      }
    }
    setRunning(false);
    setTimeout(refreshLiveOfCustomer, 1500);   // the gateway records after replying
  }

  async function decide(option: string) {
    if (!proposal) return;
    const overridden = option !== proposal.option;
    setFinal({ option, overridden });
    // The rep's macro goes to Zendesk; its webhook brings the human decision into the graph.
    const res = await fetch("/api/webhooks/zendesk", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "macro.applied", ticket_id: TICKET, macro: { id: 0, title: MACRO_FOR[option] },
                             actor: { id: "zd_live_rep", name: REP.name, group: REP.team, role: "agent" } }),
    }).catch(() => null);
    if (res?.ok) {
      const rec = await res.json() as Recorded;
      setRecorded(rec);
      refreshLiveOfCustomer();
      // Show what the graph now holds, read back from Neo4j: the recorded AI proposal and the rep's decision
      // (linked APPROVED or OVERRIDES). The drawn complaint and its precedent stay, now pointing at the
      // recorded proposal instead of the one drawn in the browser.
      const g = await fetch(`/api/graph/customer?email=${encodeURIComponent(current.email)}`);
      if (g.ok) {
        const recordedProposal = rec.ticket_decisions?.find((d) => d.stage === "PROPOSAL")?.id;
        const caseId = `case:${TICKET}`;
        setBase(await g.json());
        setLive((l) => ({
          nodes: l.nodes.filter((n) => n.kind === "case" || n.kind === "precedent"),
          rels: [...l.rels.filter((r) => r.type === "SIMILAR_TO"),
                 ...(recordedProposal ? [{ id: `${caseId}->recorded`, from: caseId, to: recordedProposal, type: "PROPOSED" }] : [])],
        }));
      }
      return;
    }
    const finalId = `final:${TICKET}`;
    addLive([{ id: finalId, kind: "final", label: words(option).replace(/^./, (c) => c.toUpperCase()), option,
               detail: `${overridden ? "overrode the AI proposal" : "approved the AI proposal"} · ${REP.name} (${REP.team})`,
               live: true }],
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
  const thinkingBody = (
          <div className="space-y-3">
            {thinking && <p className="text-sm italic text-zinc-400">“{thinking.trim()}”</p>}
            {!graphOn && steps.length > 0 && (
              <p className="text-xs text-zinc-500">Decision graph off: the agent has only its instructions.</p>
            )}
            {steps.map((s, i) => (
              <div key={i}>
                <StepCard step={s} />
                {s.via && <p className="mt-0.5 text-right text-[10px] text-zinc-500">
                  via {s.via}{s.ms != null ? ` · ${s.ms} ms` : ""}{s.via === "Rationode gateway" ? " · recorded for the decision graph" : ""}</p>}
              </div>
            ))}
            {!steps.length && !running && <p className="text-sm text-zinc-500">
              {current.key === "pick" ? "Pick a customer in the help chat to start." : <>Send {current.name.split(" ")[0]}&apos;s message to start.</>}</p>}
          </div>
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
      {/* Brand bar: fixed colours (not theme variables) so it looks the same in dark and light mode. */}
      <header className="flex items-center justify-between rounded-xl bg-gradient-to-r from-[#4c1d95] via-[#5b21b6] to-[#0369a1] px-4 py-2.5 text-white shadow-lg">
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-lg font-semibold">Rationode <span className="font-normal text-white/70">· Streamly</span></h1>
            <p className="text-xs text-white/70">Every decision from AI, humans, and systems, in one Neo4j graph</p>
          </div>
          <nav className="flex rounded-full bg-white/10 p-1 text-sm">
            {([["live", "Streamly live"], ["events", "Events"], ["settings", "Settings"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                      className={`rounded-full px-4 py-1 font-semibold ${tab === k ? "bg-white text-[#4c1d95]" : "text-white/80"}`}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {tab === "live" && <>
          <button onClick={() => setGraphOn((g) => !g)} disabled={running}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                    graphOn ? "bg-white text-[#0369a1]" : "bg-white/15 text-white"}`}>
            Decision graph: {graphOn ? "ON" : "OFF"}
          </button>
          <button onClick={reset} disabled={running}
                  className="rounded-full bg-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/25">Reset</button>
          </>}
          <ThemeToggle />
        </div>
      </header>

      <div className={tab === "events" ? "flex min-h-0 flex-1" : "hidden"}>
        <EventsTab active={tab === "events"} onChanged={refreshStories} />
      </div>

      {tab === "settings" && <SettingsTab />}

      <div className={tab === "live" ? "grid min-h-0 flex-1 grid-cols-2 grid-rows-6 gap-3" : "hidden"}>
        <Panel title="Streamly help chat" className="col-start-1 row-span-4 row-start-1" badge={
          DEMO ? (
          <select value={caseKey} onChange={(e) => pickCase(e.target.value)} disabled={running}
                  className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-200">
            {current.key === "none" && <option value="none">No customers yet</option>}
            {[...PREPARED, ...storyCases].map((c) => <option key={c.key} value={c.key}>{c.name}{c.setNumber ? ` (Set ${c.setNumber})` : ""}</option>)}
            {[...new Set(uploadCases.map((c) => c.scenario))].map((sc) => (
              <optgroup key={sc} label={`Uploaded · ${sc}`}>
                {uploadCases.filter((c) => c.scenario === sc).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
          ) : (
          <select value={question} onChange={(e) => pickQuestion(e.target.value)} disabled={running}
                  className="max-w-[26rem] rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-200">
            {!groups.length && <option value="">No customers yet</option>}
            {groups.map(([q, cs]) => <option key={q} value={q}>{capital(q)} ({cs.length})</option>)}
          </select>
          )}>
          <div className="flex h-full flex-col">
            <div className="mb-3 flex items-start gap-2 rounded-md bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <div className="flex-1">
                <p>{current.blurb}</p>
                {current.note && <p className="mt-1 text-amber-300">{current.note}</p>}
              </div>
              {current.setNumber && (
                <button onClick={() => removeStory(current.setNumber!)} disabled={running}
                        className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">
                  Remove {current.name.split(" ")[0]}&apos;s story</button>
              )}
              {liveOfCustomer.decisions > 0 && (
                <button onClick={clearLive} disabled={running}
                        title={`Live tickets: ${liveOfCustomer.tickets.join(", ")}`}
                        className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                  Clear {current.name.split(" ")[0]}&apos;s live decisions ({liveOfCustomer.decisions})</button>
              )}
            </div>
            {!DEMO && !running && chat.length === 0 && asked.length > 0 && (
              <div className="mb-3 flex min-h-0 flex-1 flex-col rounded-md border border-zinc-800">
                <input value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)}
                       placeholder={`Filter ${asked.length} customers by name or email`}
                       className="border-b border-zinc-800 bg-transparent px-3 py-1.5 text-xs outline-none" />
                <ul className="min-h-0 flex-1 overflow-y-auto py-1 text-sm">
                  {asked.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(customerFilter.trim().toLowerCase())).map((c) => (
                    <li key={c.key}>
                      <button onClick={() => pickCase(c.key)}
                              className={`flex w-full items-baseline justify-between gap-3 px-3 py-1 text-left hover:bg-zinc-800 ${
                                c.key === caseKey ? "bg-violet-600/20 text-violet-200" : ""}`}>
                        <span>{c.name}</span>
                        <span className="text-xs text-zinc-500">{c.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className={`space-y-3 ${!DEMO && chat.length === 0 ? "" : "flex-1"}`}>
              {chat.map((m, i) => (
                <div key={i} className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                  m.from === "sam" ? "ml-auto bg-violet-600 text-white" : "bg-zinc-800"}`}>
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
              <button onClick={send} disabled={running || current.key === "none" || current.key === "pick"}
                      className="rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">Send</button>
            </div>
          </div>
        </Panel>

        <Panel title="Agent's thinking" className="col-start-2 row-span-3 row-start-1" badge={
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            {agentModel} · prompt v2 · graph {graphOn ? "on" : "off"}
            <button onClick={() => setThinkingExpanded(true)} title="Expand"
                    className="rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">⤢ Expand</button>
          </span>}>
          {!thinkingExpanded && thinkingBody}
        </Panel>

        <Panel title="Support rep console" className="col-start-1 row-span-2 row-start-5" badge={<span className="text-xs text-zinc-500">{REP.name} · {REP.team}</span>}>
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
                <div className={`space-y-1 rounded-lg p-3 ${final.overridden ? "bg-red-950 text-red-100" : "bg-emerald-950 text-emerald-100"}`}>
                  <p className="text-lg font-semibold">Decision: {words(final.option).replace(/^./, (c) => c.toUpperCase())}</p>
                  <p>
                    Approved AI proposal: <b>{final.overridden ? "No" : "Yes"}</b>
                    {final.overridden && <> · the AI proposed {words(proposal.option)}</>} · by {REP.name}
                  </p>
                  <p className="text-xs opacity-60">
                    {recorded
                      ? `Recorded in Neo4j (scenario ${DEMO ? "live" : `${process.env.NEXT_PUBLIC_RATIONODE_TENANT}:live`}): the AI proposal via the Rationode gateway, and this decision via ` +
                        `the Zendesk webhook${recorded.overrides ? ", with OVERRIDES on the AI proposal" : ""}. The graph now shows it.`
                      : "Recording…"}
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => decide(proposal.option)}
                          className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white">Approve</button>
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

        <Panel title="Decision graph · live from Neo4j" className="col-start-2 row-span-3 row-start-4 overflow-hidden" badge={graphControls}>
          <div className="-m-4 h-[calc(100%+2rem)]">{!expanded && graphBody}</div>
        </Panel>
      </div>

      {thinkingExpanded && tab === "live" && (
        <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 p-4 backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
              Agent&apos;s thinking <span className="font-normal normal-case text-zinc-500">· {current.name} · {agentModel} · graph {graphOn ? "on" : "off"}</span></h2>
            <button onClick={() => setThinkingExpanded(false)} title="Close (Esc)"
                    className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">✕ Close</button>
          </div>
          <div className="mx-auto min-h-0 w-full max-w-4xl flex-1 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-base">
            {thinkingBody}
          </div>
        </div>
      )}

      {expanded && tab === "live" && (
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
