// Streamly's AI support agent: a manual, streaming tool-use loop whose steps are
// reported as events (thinking, tool calls, results, text) for the demo UI.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getCustomer } from "./customer";
import type { Context } from "./features";
import { checkBeforeAct } from "./precedent";

const client = new Anthropic();
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";
export const AGENT_VERSION = "v2";

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; is_error?: boolean }
  | { type: "proposal"; ticket_id: string; option: string; amount_usd: number; rationale: string }
  | { type: "done"; stop_reason: string | null; model: string }
  | { type: "error"; message: string };

// Prompt v2 ("reduce refunds"): the same instructions whether the graph is on or off.
const SYSTEM = `You are Streamly's customer support agent (prompt v2).

Streamly is a subscription streaming service. You resolve refund and billing complaints by proposing one resolution, which a human support rep reviews.

Resolution options:
- full_refund: refund the whole charge
- partial_refund: refund 50% of the charge
- voucher: account credit worth 20% of the charge
- deny: no refund
- pause_subscription: pause the subscription instead of refunding

Guidance (v2): refunds are costly, so reduce refunds where possible. Decline requests where the customer simply didn't use the service or changed their mind: no refund and no voucher. Always issue a full refund for a genuine billing error.

Your goal is the best overall outcome for Streamly: the cost of refunds, disputes the customer might file with their bank (the charge plus fees), and customers who cancel. The guidance is a default. If you have strong evidence that another option leads to better outcomes, choose it and say what the evidence is.

How to work:
1. Look up the customer with get_customer.
2. Use any other tools available to you to understand what has happened in similar cases.
3. Call propose_resolution exactly once, with a one-sentence rationale that cites your evidence.
4. Then reply to the customer in two or three friendly sentences. Say a teammate will confirm shortly; don't promise the outcome.`;

const GetCustomer = z.object({ email: z.string() });
const CheckBeforeAct = z.object({
  decision_type: z.literal("support.complaint_resolution"),
  context: z.object({
    "support.tenure_months": z.number(),
    "support.plan": z.string(),
    "support.amount_usd": z.number(),
    "support.complaint_category": z.enum(["too_expensive", "didnt_use", "billing_error", "content_issue"]),
    "support.prior_refunds_90d": z.number(),
    "support.channel": z.enum(["chat", "email"]),
  }),
});
const ProposeResolution = z.object({
  ticket_id: z.string(),
  option: z.enum(["full_refund", "partial_refund", "voucher", "deny", "pause_subscription"]),
  amount_usd: z.number(),
  rationale: z.string(),
});

const TOOLS: Record<string, Anthropic.Beta.BetaTool> = {
  get_customer: {
    name: "get_customer",
    description: "Look up a customer by email: tenure in months, plan, latest charge, refunds in the last 90 days, " +
      "and hours watched in the last 30 days from the Streamly app (null when there is no usage data).",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
  check_before_act: {
    name: "check_before_act",
    description:
      "Before deciding, ask Rationode's decision graph what happened in similar past cases: the options chosen, " +
      "and the dispute, churn, and cost outcomes that followed, plus a what-if for each possible option. " +
      "Pass the case context using these attribute names.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        decision_type: { type: "string", enum: ["support.complaint_resolution"] },
        context: {
          type: "object",
          properties: {
            "support.tenure_months": { type: "number" },
            "support.plan": { type: "string" },
            "support.amount_usd": { type: "number" },
            "support.complaint_category": { type: "string", enum: ["too_expensive", "didnt_use", "billing_error", "content_issue"] },
            "support.prior_refunds_90d": { type: "number" },
            "support.channel": { type: "string", enum: ["chat", "email"] },
          },
          required: ["support.tenure_months", "support.plan", "support.amount_usd", "support.complaint_category",
                     "support.prior_refunds_90d", "support.channel"],
        },
      },
      required: ["decision_type", "context"],
    },
  },
  propose_resolution: {
    name: "propose_resolution",
    description: "Propose a resolution for the ticket. A human support rep reviews it before anything happens.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        option: { type: "string", enum: ["full_refund", "partial_refund", "voucher", "deny", "pause_subscription"] },
        amount_usd: { type: "number", description: "Refund or credit amount in USD; 0 for deny or pause" },
        rationale: { type: "string" },
      },
      required: ["ticket_id", "option", "amount_usd", "rationale"],
    },
  },
};

type ToolRun = { result: unknown; is_error?: boolean; proposal?: z.infer<typeof ProposeResolution> };

async function runTool(name: string, input: unknown): Promise<ToolRun> {
  if (name === "get_customer") {
    const p = GetCustomer.safeParse(input);
    if (!p.success) return { result: { INVALID_INPUT: p.error.message }, is_error: true };
    const customer = await getCustomer(p.data.email);
    return customer ? { result: customer } : { result: "No customer with that email", is_error: true };
  }
  if (name === "check_before_act") {
    const p = CheckBeforeAct.safeParse(input);
    if (!p.success) return { result: { INVALID_INPUT: p.error.message }, is_error: true };
    return { result: await checkBeforeAct(p.data.decision_type, p.data.context as Context) };
  }
  if (name === "propose_resolution") {
    const p = ProposeResolution.safeParse(input);
    if (!p.success) return { result: { INVALID_INPUT: p.error.message }, is_error: true };
    // Milestone 8 turns this into an MCP-gateway event that the live pipeline ingests.
    return { result: { status: "pending_review" }, proposal: p.data };
  }
  return { result: `Unknown tool ${name}`, is_error: true };
}

export type ChatInput = {
  ticket_id: string;
  customer_email: string;
  channel: "chat" | "email";
  message: string;
  graph: boolean;
};

export async function* runSupportAgent(input: ChatInput): AsyncGenerator<AgentEvent> {
  // Graph off removes only the graph tool; the prompt and everything else stay the same.
  const tools = input.graph
    ? [TOOLS.get_customer, TOOLS.check_before_act, TOOLS.propose_resolution]
    : [TOOLS.get_customer, TOOLS.propose_resolution];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{
    role: "user",
    content: `New ${input.channel} ticket ${input.ticket_id} from ${input.customer_email}:\n\n${input.message}`,
  }];

  for (let turn = 0; turn < 8; turn++) {
    const stream = client.beta.messages.stream({
      model: AGENT_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: (process.env.AGENT_EFFORT as "low" | "medium" | "high") ?? "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools,
      messages,
    });

    const buffered: AgentEvent[] = [];
    stream.on("thinking", (delta) => buffered.push({ type: "thinking", text: delta }));
    stream.on("text", (delta) => buffered.push({ type: "text", text: delta }));
    const done = stream.finalMessage();
    // Relay deltas while the turn streams.
    while (true) {
      const settled = await Promise.race([done.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);
      while (buffered.length) yield buffered.shift()!;
      if (settled) break;
    }

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await done;
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }
    while (buffered.length) yield buffered.shift()!;

    if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
      yield { type: "done", stop_reason: message.stop_reason, model: message.model };
      return;
    }
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      yield { type: "done", stop_reason: message.stop_reason, model: message.model };
      return;
    }

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      yield { type: "tool_call", id: call.id, name: call.name, input: call.input };
      const run = await runTool(call.name, call.input);
      yield { type: "tool_result", id: call.id, name: call.name, result: run.result, is_error: run.is_error };
      if (run.proposal) yield { type: "proposal", ...run.proposal };
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(run.result),
                     is_error: run.is_error });
    }
    messages.push({ role: "user", content: results });
  }
  yield { type: "error", message: "Agent did not finish within 8 turns" };
}
