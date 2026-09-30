// "Ask" (demo spec §23.8, option B): plain-English questions about the decisions in this tenant's graph, answered by
// Claude with tools over the graph itself: what decisions exist, outcome rates by any fact, precedent, one subject's
// story, the learned trees. Generic: nothing here knows a domain; it reads decision types, options, outcomes and
// facts from the data. Scoped to this app's own scenario (a tenant never sees another's data).
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { subjectGraph } from "./caseGraph";
import { attributes, prefixOf, type Context } from "./features";
import { findPrecedent } from "./findPrecedent";
import neo4j from "neo4j-driver";
import { query, baseScenario } from "./neo4j";
import { checkBeforeAct } from "./precedent";
import { ownScenario } from "./scenarios";
import { aiSettings, anthropicClient } from "./settings";

export type AskEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; is_error?: boolean; ms: number }
  | { type: "done"; stop_reason: string | null; model: string }
  | { type: "error"; message: string };

const round = (v: number) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ tools (reads only)
async function describeDecisions() {
  const types = await query<{ type: string; n: number; stages: string[] }>(
    `MATCH (d:Decision {scenario_id: $s}) RETURN d.decision_type AS type, count(*) AS n, collect(DISTINCT d.stage) AS stages ORDER BY n DESC`,
    { s: baseScenario() });
  const attrs = await attributes();
  return Promise.all(types.map(async (t) => {
    const options = await query<{ option: string; n: number }>(
      `MATCH (d:Decision {scenario_id: $s, decision_type: $t})-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
       RETURN o.option_key AS option, count(*) AS n ORDER BY n DESC`, { s: baseScenario(), t: t.type });
    const outcomes = await query<{ outcome: string; n: number; polarity: string | null }>(
      `MATCH (d:Decision {scenario_id: $s, decision_type: $t})-[:LED_TO]->(o:Outcome)
       RETURN o.outcome_type AS outcome, count(DISTINCT o) AS n, head(collect(o.polarity)) AS polarity ORDER BY n DESC`, { s: baseScenario(), t: t.type });
    const prefix = prefixOf(t.type);
    return { decision_type: t.type, decisions: t.n, stages: t.stages, options, outcomes,
             facts: attrs.filter((a) => a.key.startsWith(prefix))
               .map((a) => ({ name: a.key, kind: a.encoding === "NUMERIC" ? "number" : a.datatype === "BOOLEAN" ? "yes/no" : "category",
                              values: a.values ?? undefined, max: a.scale_max ?? undefined })) };
  }));
}

const Filter = z.object({ fact: z.string(), op: z.enum(["=", "!=", ">=", "<=", "in"]), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]) });
export const RatesInput = z.object({ decision_type: z.string(), group_by: z.string().optional(), filters: z.array(Filter).optional() });

// Outcome rates for a decision type (FINAL decisions), overall or grouped by one fact (numbers in quartile bands) or
// by the option chosen ("option"), optionally filtered. The workhorse for "what leads to what" questions.
export async function outcomeRates(input: z.infer<typeof RatesInput>) {
  const rows = await query<{ option: string | null; ctx: Record<string, unknown>; outcomes: string[]; polarities: (string | null)[] }>(
    `MATCH (d:Decision {scenario_id: $s, decision_type: $t, stage: 'FINAL'})-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (d)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     WITH d, c, head(collect(o.option_key)) AS option
     OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
     RETURN option, properties(c) AS ctx, collect(out.outcome_type) AS outcomes, collect(out.polarity) AS polarities
     LIMIT 50000`, { s: baseScenario(), t: input.decision_type });
  // Fact names as the model writes them: "loan.requested_amount", "requested_amount" or "requested amount" all work.
  const prefix = prefixOf(input.decision_type);
  const keyOf = (fact: string) => {
    if (fact === "option" || rows.some((r) => fact in r.ctx)) return fact;
    const bare = fact.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "_").replace(/^_|_$/g, "");
    return bare.startsWith(prefix) ? bare : `${prefix}${bare}`;
  };
  const value = (r: (typeof rows)[number], fact: string) => (fact === "option" ? r.option : r.ctx[keyOf(fact)]);
  const kept = rows.filter((r) => (input.filters ?? []).every((f) => {
    const v = value(r, f.fact);
    if (f.op === "in") return Array.isArray(f.value) && f.value.map(String).includes(String(v));
    if (f.op === "=") return String(v) === String(f.value);
    if (f.op === "!=") return String(v) !== String(f.value);
    return typeof v === "number" && (f.op === ">=" ? v >= Number(f.value) : v <= Number(f.value));
  }));
  const summarise = (rs: typeof rows) => {
    const n = rs.length;
    const types = [...new Set(rs.flatMap((r) => r.outcomes))].sort();
    return { n, outcome_rates: Object.fromEntries(types.map((t) => [t, round(rs.filter((r) => r.outcomes.includes(t)).length / (n || 1))])),
             good_rate: round(rs.filter((r) => r.polarities.includes("good")).length / (n || 1)),
             bad_rate: round(rs.filter((r) => r.polarities.includes("bad")).length / (n || 1)),
             options: Object.fromEntries([...new Set(rs.map((r) => r.option ?? "(none)"))].map((o) => [o, rs.filter((r) => (r.option ?? "(none)") === o).length])) };
  };
  if (!input.group_by) return { decision_type: input.decision_type, filters: input.filters ?? [], all: summarise(kept) };
  const g = input.group_by;
  const nums = kept.map((r) => value(r, g)).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  let groupOf: (r: (typeof rows)[number]) => string;
  if (nums.length > kept.length / 2 && new Set(nums).size > 6) {   // a number: quartile bands
    const q = [0.25, 0.5, 0.75].map((p) => nums[Math.floor(p * (nums.length - 1))]);
    const bands = [...new Set(q)];
    groupOf = (r) => {
      const v = value(r, g);
      if (typeof v !== "number") return "(no value)";
      const i = bands.findIndex((b) => v <= b);
      return i === -1 ? `> ${bands[bands.length - 1]}` : i === 0 ? `≤ ${bands[0]}` : `${bands[i - 1]} – ${bands[i]}`;
    };
  } else groupOf = (r) => String(value(r, g) ?? "(no value)");
  const groups = new Map<string, typeof rows>();
  for (const r of kept) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  return { decision_type: input.decision_type, group_by: g, filters: input.filters ?? [], all: summarise(kept),
           groups: [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([k, rs]) => ({ group: k, ...summarise(rs) })) };
}

// One subject's story: find it by ID, name or email, then its decisions (with who, when, facts known, outcomes).
async function subjectStory(search: string) {
  const found = await query<{ id: string; s: string }>(
    `MATCH (e:Entity) WHERE toLower(e.source_key) ENDS WITH toLower($q) OR toLower(e.source_key) CONTAINS toLower($q)
          OR toLower(coalesce(e.email, '')) = toLower($q)
     RETURN e.entity_id AS id, e.scenario_id AS s LIMIT 20`, { q: search.trim() });
  const hit = found.find((f) => ownScenario(f.s));
  if (!hit) return { found: false, search };
  const g = await subjectGraph(hit.id);
  if (!g) return { found: false, search };
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  return {
    found: true, subject: label(hit.id),
    related: g.nodes.filter((n) => n.kind === "subject").map((n) => n.label),
    decisions: g.nodes.filter((n) => n.kind === "decision").map((d) => ({
      decision: d.label, option: d.option, about: label(g.rels.find((r) => r.type === "ABOUT" && r.from === d.id)?.to ?? ""), detail: d.detail,
      outcomes: g.rels.filter((r) => r.type === "LED_TO" && r.from === d.id).map((r) => label(r.to)) })),
  };
}

// The subjects with the most recent decisions (as the Browse tab lists them), to pick a case to look at.
async function recentSubjects(limit: number) {
  return query<{ subject: string; type: string; last: string; decisions: number }>(
    `MATCH (d:Decision {scenario_id: $s})-[:ABOUT]->(x:Entity)
     WHERE x.subject_type IS NOT NULL OR (x:Customer AND x.source_system = 'stripe')
     OPTIONAL MATCH (x)-[:PART_OF]->(p:Entity)
     WITH coalesce(p, x) AS s, d
     WITH s, max(d.decided_at) AS last, count(DISTINCT d) AS decisions ORDER BY last DESC LIMIT $limit
     RETURN coalesce(s.name, split(s.source_key, ':')[1], s.source_key) + coalesce(' <' + s.email + '>', '') AS subject,
            coalesce(s.subject_type, 'customer') AS type, toString(last) AS last, decisions`,
    { s: baseScenario(), limit: neo4j.int(Math.min(Math.max(Math.trunc(limit), 1), 25)) });
}

// The learned trees for a decision type: each leaf's path, size, most likely label and outcome rates.
async function decisionTrees(decisionType: string) {
  const trees = await query<{ id: string; title: string; kind: string; n: number }>(
    `MATCH (t:DecisionTree {scenario_id: $s, decision_type: $t}) RETURN t.tree_id AS id, t.title AS title, t.kind AS kind, t.n_decisions AS n`,
    { s: baseScenario(), t: decisionType });
  return Promise.all(trees.map(async (t) => {
    const points = await query<{ id: string; depth: number; leaf: boolean; cond: string | null; props: Record<string, unknown> }>(
      `MATCH (p:DecisionPoint {tree_id: $id}) OPTIONAL MATCH (:DecisionPoint)-[b:BRANCH]->(p)
       RETURN p.point_id AS id, p.depth AS depth, p.is_leaf AS leaf, b.label AS cond, properties(p) AS props ORDER BY id`, { id: t.id });
    const leaves = points.filter((p) => p.leaf).map((p) => {
      const path = points.filter((x) => p.id.startsWith(x.id) && x.cond).sort((a, b) => a.depth - b.depth).map((x) => x.cond);
      const rates = Object.fromEntries(Object.entries(p.props).filter(([k, v]) => k.startsWith("rate_") && v).map(([k, v]) => [k.slice(5), v]));
      return { path: path.join(" AND ") || "all", support: p.props.support, most_likely: p.props.top_label, share: p.props.top_share, rates };
    });
    return { title: t.title, kind: t.kind, decisions: t.n, leaves };
  }));
}

// ------------------------------------------------------------------ tool definitions
const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "describe_decisions", description: "What decisions are recorded in this organisation's graph: each decision type with its count, stages, the options chosen (with counts), the outcomes that followed (with counts and whether each is good or bad for the organisation), and the facts known at decision time (names, kinds, values). Call this first.",
    input_schema: { type: "object", properties: {} } },
  { name: "outcome_rates", description: "Outcome rates for a decision type's final decisions: the rate of each outcome, good/bad rates and the options chosen, overall or grouped by one fact (numbers are grouped in quartile bands; use \"option\" to group by the option chosen), optionally filtered (op =, !=, >=, <=, in). Use it for 'what leads to what' and comparisons.",
    input_schema: { type: "object", properties: { decision_type: { type: "string" }, group_by: { type: "string", description: "a fact name from describe_decisions, or \"option\"" },
      filters: { type: "array", items: { type: "object", properties: { fact: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">=", "<=", "in"] }, value: {} }, required: ["fact", "op", "value"] } } },
      required: ["decision_type"] } },
  { name: "find_precedent", description: "Full-text search over past decisions' context descriptions: returns matching decisions with their summary, options and outcomes.",
    input_schema: { type: "object", properties: { query: { type: "string" }, decision_type: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "check_before_act", description: "For a hypothetical new case (a decision type and its facts, named as in describe_decisions), the most similar past decisions: what was chosen and what followed, per option.",
    input_schema: { type: "object", properties: { decision_type: { type: "string" }, context: { type: "object", additionalProperties: true } }, required: ["decision_type", "context"] } },
  { name: "subject_story", description: "One subject's full story (e.g. an application, a customer), found by its ID, name or email: related subjects, every decision about it (who, when, amount, reason) and what each led to.",
    input_schema: { type: "object", properties: { search: { type: "string" } }, required: ["search"] } },
  { name: "recent_subjects", description: "The subjects (e.g. applications, customers) with the most recent decisions, newest first, with their type, last decision date and number of decisions. Use it to pick a case to look at with subject_story.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "decision_trees", description: "The decision trees learned from the data for a decision type: each leaf's conditions, how many decisions, the most likely label and the outcome rates there.",
    input_schema: { type: "object", properties: { decision_type: { type: "string" } }, required: ["decision_type"] } },
];

async function runTool(name: string, raw: unknown): Promise<unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  switch (name) {
    case "describe_decisions": return describeDecisions();
    case "outcome_rates": return outcomeRates(RatesInput.parse(input));
    case "find_precedent": {
      const i = z.object({ query: z.string(), decision_type: z.string().optional(), limit: z.number().optional() }).parse(input);
      return findPrecedent(i.query, i.decision_type, Math.min(i.limit ?? 8, 20));
    }
    case "check_before_act": {
      const i = z.object({ decision_type: z.string(), context: z.record(z.string(), z.unknown()) }).parse(input);
      const r = await checkBeforeAct(i.decision_type, i.context as Context);
      return { ...r, neighbours: r.neighbours.slice(0, 8), examples: r.examples };
    }
    case "subject_story": return subjectStory(z.object({ search: z.string().min(1) }).parse(input).search);
    case "recent_subjects": return recentSubjects(z.object({ limit: z.number().optional() }).parse(input).limit ?? 10);
    case "decision_trees": return decisionTrees(z.object({ decision_type: z.string() }).parse(input).decision_type);
    default: throw new Error(`unknown tool ${name}`);
  }
}

const summaryOf = (name: string, r: unknown): string => {
  const x = r as Record<string, unknown>;
  if (name === "describe_decisions") return `${(r as unknown[]).length} decision types`;
  if (name === "outcome_rates") return `${(x.all as { n: number })?.n ?? 0} decisions${x.group_by ? `, grouped by ${x.group_by}` : ""}`;
  if (name === "find_precedent") return `${(r as unknown[]).length} matches`;
  if (name === "check_before_act") return `${x.similar_decisions ?? 0} similar decisions`;
  if (name === "subject_story") return x.found ? `${x.subject}: ${(x.decisions as unknown[]).length} decisions` : "not found";
  if (name === "decision_trees") return `${(r as unknown[]).length} trees`;
  if (name === "recent_subjects") return `${(r as unknown[]).length} subjects`;
  return "done";
};

// ------------------------------------------------------------------ the loop
const system = () => `You answer questions about the decisions recorded in an organisation's decision graph (Rationode; this
workspace: "${baseScenario() === "history" ? "demo" : baseScenario()}"). A decision is a choice among options by a person, an AI agent or a system;
each has the facts known at the time and the outcomes that followed.

How to answer:
- Use the tools; start with describe_decisions to learn what is recorded. Never invent numbers, names or IDs: every figure
  comes from a tool result.
- Give counts with rates (e.g. "61% of 243 offers"). Say when the evidence is thin (under ~30 decisions in a group).
- These are observed associations, not proof of cause. If one fact splits outcomes almost perfectly, say it may be recorded
  after the outcome (information from the future) and should be checked.
- If the data can't answer the question, say so and say what would be needed.
- Be brief: a direct answer first, then the supporting numbers; a small table (| a | b |) when comparing groups; bullets
  with "- ". No headings.`;

export async function* ask(question: string, history: { role: "user" | "assistant"; content: string }[] = []): AsyncGenerator<AskEvent> {
  const [{ agentModel }, client] = await Promise.all([aiSettings(), anthropicClient()]);
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history.slice(-8), { role: "user", content: question }];
  for (let turn = 0; turn < 10; turn++) {
    const stream = client.beta.messages.stream({
      model: agentModel, max_tokens: 16000, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",   // as the support agent: a refusal falls back, not ends
      system: system(), tools: TOOLS, messages,
    });
    const buffered: AskEvent[] = [];
    stream.on("thinking", (delta) => buffered.push({ type: "thinking", text: delta }));
    stream.on("text", (delta) => buffered.push({ type: "text", text: delta }));
    const done = stream.finalMessage();
    while (true) {
      const settled = await Promise.race([done.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 50))]);
      while (buffered.length) yield buffered.shift()!;
      if (settled) break;
    }
    let message: Anthropic.Beta.BetaMessage;
    try { message = await done; } catch (err) { yield { type: "error", message: err instanceof Error ? err.message : String(err) }; return; }
    const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || !uses.length) { yield { type: "done", stop_reason: message.stop_reason, model: message.model }; return; }
    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of uses) {
      yield { type: "tool_call", id: call.id, name: call.name, input: call.input };
      const t0 = Date.now();
      try {
        const r = await runTool(call.name, call.input);
        yield { type: "tool_result", id: call.id, name: call.name, summary: summaryOf(call.name, r), ms: Date.now() - t0 };
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(r).slice(0, 60000) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "tool_result", id: call.id, name: call.name, summary: `error: ${msg}`, is_error: true, ms: Date.now() - t0 };
        results.push({ type: "tool_result", tool_use_id: call.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  yield { type: "error", message: "Didn't finish within 10 steps" };
}
