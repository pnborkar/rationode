// The generic decision agent for the Live tab (demo spec §23.8, refined option C): a case (a subject needing a decision
// of some type, with its facts) -> Claude looks at similar past cases in the graph and proposes a decision (option,
// amount, details, reasoning) for a person to approve or override. Any domain: the decision type, its options and the
// facts come from the data. For a replayed case, the case and every decision about the same subject are kept out of
// precedent, so the agent can't see how it really ended.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { outcomeRates, RatesInput } from "./ask";
import type { Case } from "./cases";
import type { Context } from "./features";
import { baseScenario } from "./neo4j";
import { checkBeforeAct } from "./precedent";
import { aiSettings, anthropicClient } from "./settings";

export type DecideEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; is_error?: boolean; ms: number }
  | { type: "proposal"; option: string; amount: number | null; details: Record<string, unknown>; rationale: string }
  | { type: "done"; stop_reason: string | null; model: string }
  | { type: "error"; message: string };

const words = (s: string) => s.replaceAll("_", " ");

export async function* decide(c: Case): AsyncGenerator<DecideEvent> {
  const [{ agentModel }, client] = await Promise.all([aiSettings(), anthropicClient()]);
  const options = c.options.map((o) => o.option);
  const tools: Anthropic.Beta.BetaTool[] = [
    { name: "similar_cases", description: "The most similar past decisions of this type (by the case's facts): what was chosen, the amounts, and what followed, per option (outcome rates; good_rate / bad_rate = share of decisions that ended good / bad for the organisation, where any bad outcome makes a decision bad) and for the nearest cases.",
      input_schema: { type: "object", properties: {} } },
    { name: "outcome_rates", description: "Outcome rates for this decision type's past final decisions, overall or grouped by one fact (numbers in quartile bands; \"option\" for the option chosen), optionally filtered (op =, !=, >=, <=, in).",
      input_schema: { type: "object", properties: { group_by: { type: "string" },
        filters: { type: "array", items: { type: "object", properties: { fact: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">=", "<=", "in"] }, value: {} }, required: ["fact", "op", "value"] } } } } },
    { name: "propose_decision", description: "Propose the decision for a person to review. Call exactly once, at the end.",
      input_schema: { type: "object", properties: {
        option: { type: "string", enum: options.length ? options : undefined, description: "one of the options chosen for this decision type" },
        amount: { type: "number", description: "the amount, if the decision has one (e.g. the amount offered)" },
        details: { type: "object", additionalProperties: true, description: c.details.length ? `optional details, e.g. ${c.details.join(", ")}` : "optional details" },
        rationale: { type: "string", description: "two or three sentences: the evidence from similar cases behind the proposal" } },
        required: ["option", "rationale"] } },
  ];
  const system = `You are the AI decision assistant for an organisation (Rationode; workspace "${baseScenario()}"). A case needs a
"${c.decision_type}" decision${c.subject ? ` about ${c.subject.label} ${c.subject.key}` : ""}. A person reviews your proposal and approves or overrides it.

Options chosen for this decision type in the past: ${c.options.map((o) => `${o.option} (${o.n})`).join(", ") || "unknown"}.
${c.details.length ? `Past decisions also recorded these details: ${c.details.map(words).join(", ")}.` : ""}

Aim for the decision most likely to end well for the organisation, judged by what followed similar past decisions (their
outcomes, good or bad). Look at similar cases first; check a fact's effect with outcome_rates when it matters. Every number
you cite must come from a tool. If the evidence is thin or a fact looks like it was recorded after the outcome, say so. Then
call propose_decision once.`;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content:
    `The case: ${c.subject.label} ${c.subject.key}${c.parent ? ` (part of ${c.parent.label} ${c.parent.key})` : ""}.\nFacts known now:\n` +
    Object.entries(c.facts).map(([k, v]) => `- ${words(k.split(".").slice(1).join("."))}: ${v}`).join("\n") }];
  const exclude = [c.id, ...c.related];

  for (let turn = 0; turn < 8; turn++) {
    const stream = client.beta.messages.stream({
      model: agentModel, max_tokens: 16000, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", system, tools, messages,
    });
    const buffered: DecideEvent[] = [];
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
    let proposed = false;
    for (const call of uses) {
      yield { type: "tool_call", id: call.id, name: call.name, input: call.input };
      const t0 = Date.now();
      try {
        let result: unknown, summary = "done";
        if (call.name === "similar_cases") {
          const r = await checkBeforeAct(c.decision_type, c.facts as Context, 150, undefined, exclude);
          result = { ...r, neighbours: r.neighbours.slice(0, 10) };
          summary = `${r.similar_decisions} similar decisions (this case and ${exclude.length - 1} related kept out)`;
        } else if (call.name === "outcome_rates") {
          const i = RatesInput.omit({ decision_type: true }).parse(call.input ?? {});
          const r = await outcomeRates({ ...i, decision_type: c.decision_type });
          result = r;
          summary = `${r.all.n} decisions${i.group_by ? `, by ${i.group_by}` : ""}`;
        } else if (call.name === "propose_decision") {
          const p = z.object({ option: z.string(), amount: z.number().nullish(), details: z.record(z.string(), z.unknown()).nullish(), rationale: z.string() }).parse(call.input);
          if (options.length && !options.includes(p.option)) throw new Error(`option must be one of ${options.join(", ")}`);
          yield { type: "proposal", option: p.option, amount: p.amount ?? null, details: p.details ?? {}, rationale: p.rationale };
          result = { ok: true, note: "Sent to a person for review." };
          summary = `proposed ${words(p.option)}${p.amount != null ? ` (${p.amount})` : ""}`;
          proposed = true;
        } else throw new Error(`unknown tool ${call.name}`);
        yield { type: "tool_result", id: call.id, name: call.name, summary, ms: Date.now() - t0 };
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result).slice(0, 60000) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "tool_result", id: call.id, name: call.name, summary: `error: ${msg}`, is_error: true, ms: Date.now() - t0 };
        results.push({ type: "tool_result", tool_use_id: call.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
    if (proposed) { yield { type: "done", stop_reason: "proposed", model: message.model }; return; }
  }
  yield { type: "error", message: "No proposal within 8 steps" };
}
