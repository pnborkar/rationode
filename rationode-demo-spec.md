# Rationode — Flagship Neo4j Demo Spec

**Card disputes: a decision graph that finds what's broken, changes the decision, and proves the fix**
*Draft v2.0 · September 2026 · Builds on `rationode-v41-business-case.md` (schema in Section 8.4)*

**Changes from v1.0:** graph is pre-loaded from mocked raw events; interactive Vercel app replaces Streamlit; "Graph on/off" switch; three levels of decision change; "the next Dana" live chat; checkout screening renamed to charge screening; prepared correlation answer; loop numbers corrected (~27% → ~63%, measured); prompt-drift side note; stack is TypeScript (app) + Python (data work) on AuraDB Professional.

---

## 1. Goal

A flagship Neo4j demo (about 9 minutes) showing that decisions made by AI agents, humans, and systems can be captured in one graph, analyzed with Cypher, GDS, and vector search, and used to change the next decision.

**The demo must prove three things:**
1. **Capture:** decisions from different actors and systems, weeks apart, land on one connected structure.
2. **Discover:** the graph reveals decision logic nobody wrote down, and what each branch costs.
3. **Act:** the graph changes decisions — one decision in the moment, human judgment recorded, and all future decisions through policy — and proves the change worked.

**Audience:** Neo4j audiences (developers, field teams, customers at events). Every Neo4j capability gets one clear on-screen moment.

**Honesty rule:** the six months of history and all outcomes come from a simulated world model; the pipeline, graph, analysis, and live agent are real. Say so on screen.

---

## 2. The Story World

**Merchant:** *Streamly*, a subscription streaming service. Merchant side only — no banks, card networks, or dispute reason-code jargon on screen.

**Systems observed:**

| System | Role | Events emitted (real formats, mocked) |
|---|---|---|
| Fraud tool (rules engine) | Screens every charge (signups and renewals) | `charge.screened` |
| AI support agent | Handles complaints and disputes | Tool calls via MCP gateway: `propose_resolution` (options `full_refund`, `partial_refund`, `voucher`, `deny`, `pause_subscription`), `respond_to_dispute` |
| Zendesk (human support) | Human reps approve or override the AI | `ticket.created`, `ticket.updated`, `macro.applied` |
| Stripe | Payments, refunds, disputes | `charge.succeeded`, `refund.created`, `charge.dispute.created`, `charge.dispute.closed` |
| Subscription system | Renewals and cancellations | `subscription.renewed`, `subscription.canceled` |

**Plans:** monthly ($15, $25, $49) and annual ($180, $300, $480). **Fees:** $15 dispute fee on every dispute, win or lose; $15 contest fee when contesting, refunded if won.

---

## 3. The Decision Chain

Four decision points per case, spread over weeks, made by different actors in different systems.

```
1. Charge            2. Complaint            3. Dispute arrives       4. Evidence
   (fraud tool)   →     (AI proposes,     →     (AI decides)       →     (AI decides)
                         human may override)
   approve /            full / partial refund,  accept / contest         usage_logs, tos_acceptance,
   review / decline     voucher, deny,                                   cancellation_emails,
                        pause_subscription*                              delivery_confirmation
   day 0                day ~20                 day ~35                  day ~36
                                                                         → won / lost (day ~95)
                                                                         → renew / churn
```
\* `pause_subscription` first appears in May as a new, `PROPOSED` schema element (step 9).

### 3.1 Mapping to the v4.1 schema

The v4.1 MVP scope named only `refund.resolution`. The demo extends it to four decision types; all use the fixed core unchanged.

| Decision type | Actor(s) | Stage(s) | Options | Context attributes |
|---|---|---|---|---|
| `charge.fraud_screen` | Fraud tool (`SYSTEM`) | `FINAL` | `approve`, `review`, `decline` | `charge.risk_score`, `charge.plan`, `charge.is_renewal`, `charge.country_match`, `charge.card_age_days` |
| `support.complaint_resolution` | AI agent (`PROPOSAL`), human rep (`FINAL`) | Both | `full_refund`, `partial_refund`, `voucher`, `deny`, `pause_subscription`* | `support.tenure_months`, `support.plan`, `support.amount_usd`, `support.complaint_category`, `support.prior_refunds_90d`, `support.channel` |
| `dispute.response` | AI agent | `FINAL` | `accept`, `contest` | `dispute.amount_usd`, `dispute.category`, `dispute.tenure_months`, `dispute.prior_complaint` |
| `dispute.evidence` | AI agent | `FINAL` | Multi-select: `usage_logs`, `tos_acceptance`, `cancellation_emails`, `delivery_confirmation` (each a `CONSIDERED` edge with `CHOSEN` or `AVAILABLE`) | Inherits `dispute.*`; plus `dispute.usage_logs_available` |

**Entities:** `:Customer`, `:Subscription`, `:Charge`, `:Ticket`, `:Dispute`, linked across systems with `SAME_AS`.
**Case path:** decisions for one charge are chained with `PRECEDED_BY` (charge screen → complaint → dispute response → evidence).
**Complaint categories:** `too_expensive`, `didnt_use`, `billing_error`, `content_issue`.
**Dispute categories (plain labels):** `subscription_canceled`, `not_recognized`, `unauthorized`, `duplicate_charge`.

### 3.2 Outcome types

| Outcome | Source | Typical timing | Attached to |
|---|---|---|---|
| `dispute_filed` | Stripe | 5–60 days after complaint | Complaint decision |
| `dispute_won` / `dispute_lost` (`value_usd` = amount + fee) | Stripe | 45–75 days after response | Dispute response and evidence decisions |
| `refund_cost` (`value_usd`) | Stripe | Immediate | Complaint decision |
| `renewal` / `churn` | Subscription system | Next billing date | Complaint and dispute decisions |

---

## 4. Planted Truths (the World Model)

The simulator's hidden world model decides outcomes from these probabilities. **The agent and the pipeline never see it.** Rationode must rediscover each truth from the data.

| # | Truth | Mechanism | Where it shows |
|---|---|---|---|
| **T1** | **Tenure rule:** refunding long-tenure customers pays off | Complaint, tenure ≥ 24 months: deny → 25% file a dispute, 40% churn; refund → 3% dispute, 8% churn. Tenure < 24: deny → 8% dispute; refund → 2% dispute but refund cost rarely recovered | Reveal 2; "the next Dana" |
| **T2** | **Evidence gap:** usage logs win "subscription canceled" disputes | Contested **with** `usage_logs`: 70% win; **without**: 20% win. AI v2 includes usage logs only 15% of the time (so v2's overall win rate on this category is ~27%, measured) | Reveal 3; the loop |
| **T3** | **Policy vs reality:** contesting small disputes loses money | Written policy: "contest disputes over $50; accept $50 and under." AI v2 contests ~90% of disputes, including under $50, where the $15 fee exceeds expected recovery | Reveal 1; live disputes |
| **T4** | **Prompt drift:** AI v2 denies more | AI v1 (Jan–Mar) proposes deny in 30% of complaints; AI v2 (Apr–Jun, prompt updated to "reduce refunds") proposes deny in 55% | Side note in reveal 2 |
| **T5** | **Fraud threshold gap** | Fraud tool approves risk scores 60–75 without review; 12% of those become `unauthorized` disputes (won ~4%), versus 1% below 60 | Live disputes (dispute 3) |
| **T6** | **New option works** | From May, AI v2 sometimes proposes `pause_subscription` for `too_expensive` complaints: 2% dispute, 15% churn (vs deny: 12% dispute, 45% churn) | Schema extends |

**Human behavior:** reps override AI deny proposals for tenure ≥ 24 in ~60% of cases, and otherwise mostly approve the AI proposal. Two teams: Team A (baseline) and Team B (overrides more generously, including for short-tenure customers — visible via GDS as a deviating group).

**Hero case (seeded, fixed):** customer **Dana**, tenure 31 months, annual $180 plan. Renewal charge approved by the fraud tool → complaint `didnt_use` → AI proposes deny, human approves it → dispute `subscription_canceled` → AI contests **without** usage logs → **lost: $180 + $15 dispute fee + $15 contest fee = $210** → Dana churns.

**Live customer (for the chat):** **Sam**, tenure 28 months, annual $180 plan, same complaint as Dana. Exists in the graph as a customer with charge history but no complaint yet.

---

## 5. Data

### 5.1 Mock raw events, not decisions

The six months of history are generated as **raw events in real formats** (Stripe webhook payloads, Zendesk ticket events, MCP gateway tool-call logs, fraud-tool screening records, subscription events) and run through the **real pipeline** before the demo. The graph is genuinely built by Rationode, and any decision can be traced back to the event that produced it (`EVIDENCED_BY`).

### 5.2 Volumes

| Item | Volume (Jan–Jun) |
|---|---|
| Customers | ~20,000 |
| Charges screened | ~26,000 |
| Complaints | ~5,000 (AI proposals ~5,000; finals ~5,000, of which ~4,500 by humans; overrides ~660) |
| Disputes | ~1,600 |
| Decisions total | ~38,000 |
| Raw events | ~129,000 |
| Loop month (July, agent v3) | 6,500 cases; ~33,000 events (~28,000 decision-phase, ~4,800 outcome-phase) |

Sized so every planted truth is statistically clear at tree-leaf level (minimum ~100 decisions per leaf that carries a reveal). Fits AuraDB Professional's smallest size.

### 5.3 Graph state at demo start

**Pre-loaded:** Jan–Jun history, all trees built (policy, all, AI v1, AI v2, human, Team A, Team B), GDS results written back, vector index populated, `pause_subscription` sitting as `PROPOSED` since May, Sam present with no complaint.

**Prepared but not yet ingested:** July events for agent v3 (Section 8.3), the 3 live disputes.

**Reset:** a single script restores this exact state between runs.

---

## 6. How the Graph Changes Decisions

The graph never makes the decision itself. It changes decisions at three levels, and the demo shows all three.

| Level | What changes | Mechanism | Demo moment |
|---|---|---|---|
| **1. In the moment** | One decision | Before acting, the agent calls `check_before_act`; precedent changes its choice | "The next Dana" with the **Graph on/off** switch; live disputes |
| **2. By a human** | One decision, recorded as judgment | The rep overrides the AI's proposal in the console; the override lands in the graph linked to the proposal (`OVERRIDES`) | Rep console |
| **3. By policy** | All future decisions | A rule discovered in the graph is approved and becomes the agent's new instructions (v3); outcomes prove whether it worked | The loop |

**Level 1 must be honest:** with the graph off, the agent decides from its instructions alone (v2 prompt, "reduce refunds") — it is not scripted to decide badly. With the graph on, the only difference is access to `check_before_act`.

---

## 7. Components

| # | Component | Where | Responsibility |
|---|---|---|---|
| 1 | **World model + simulator** | Python, offline | Generates customers, cases, actor behavior (fraud rules, AI v1/v2/v3 policies, human teams); samples outcomes from planted truths; writes raw event files |
| 2 | **Pipeline** (ingest, identity, detection, schema registry, outcome attribution) | Python package; batch offline, and deployed as a Vercel Python function for live events | Turns events into the graph (Section 7.1); same code for batch and live |
| 3 | **Tree builder** | Python, offline | Learns trees per decision type and scope; writes `DecisionTree`, `DecisionPoint`, `BRANCH` (Section 7.2) |
| 4 | **Branch scorer** | Cypher (callable from Python and the app) | Recomputes `BRANCH.outcome_rates` from `LED_TO` edges; runs live when new outcomes arrive |
| 5 | **Graph analytics** | Python, offline, Aura Graph Analytics sessions | kNN, Leiden, deviating groups (Section 7.3); results written back |
| 6 | **Embeddings + vector index** | Python, offline (Jan–Jun); app server for live contexts | Embeds `Context.summary_text` |
| 7 | **Agent tools** | TypeScript, Next.js server routes, Neo4j JavaScript driver | `check_before_act`, `find_precedent`, `why`, `propose_resolution`, `respond_to_dispute` (Section 8) |
| 8 | **MCP server** | Same tools exposed over MCP from the app | Keeps "any agent can ask the graph" true |
| 9 | **Agent runner** | TypeScript, Anthropic SDK with tool use | Runs the chat agent and the disputes agent |
| 10 | **Loop controller** | App server + pipeline function | Apply rule → agent v3 → stream July events → fast-forward outcomes → re-score (Section 8.3) |
| 11 | **Demo app** | Next.js on Vercel | Screens in Section 10 |

### 7.1 Decision detection rules

| Event(s) | Creates |
|---|---|
| `charge.screened` | `charge.fraud_screen` `FINAL` by fraud tool |
| AI tool call `propose_resolution` | `support.complaint_resolution` `PROPOSAL` by AI agent (with prompt version) |
| Zendesk `macro.applied` or Stripe `refund.created` on the same ticket | `support.complaint_resolution` `FINAL` by human; `OVERRIDES` the proposal if option or amount differs |
| No human action within 24h of proposal | Proposal's option executed; `FINAL` by AI agent with `role: DECIDER` |
| AI tool call `respond_to_dispute` | `dispute.response` `FINAL` and, if contested, `dispute.evidence` `FINAL` |
| Unknown tool name or option value | New `SchemaElement` with status `PROPOSED` (how `pause_subscription` appears) |

### 7.2 Tree building

- **Learner:** Rationode's own lightweight classification tree (pure Python, so it also runs live in the Scenario lab): a shallow classification tree (depth ≤ 4, minimum leaf ~100) per decision type and scope, predicting the chosen option from `APPROVED` context attributes (encoded per `SchemaElement.encoding`).
- **Scopes:** `POLICY` (entered by hand), `ALL`, `AI_AGENT` v1 and v2, `HUMAN`, Team A, Team B. **v3 reuses v2's tree structure** so the loop compares the same branches.
- **Written to Neo4j:** each split is a `DecisionPoint`; each branch a `BRANCH` with `attribute`, `operator`, `value`, `support`, `share`; leaves point to `Option` nodes; decisions attach with `AT_POINT`.
- **Comparisons:** `COMPARED_TO` edges store divergence between policy vs `ALL`, AI vs human, v1 vs v2, v2 vs v3.
- **`pause_subscription`:** two versions of the complaint tree are prepared — without it (active while `PROPOSED`) and with it (activated on approval). *Stretch goal:* rebuild live via a background job.

### 7.3 GDS usage (narrate accurately)

| Algorithm | Purpose | Demo moment |
|---|---|---|
| **kNN** on encoded decision context | "Similar decisions" graph; used with vector search in `check_before_act` | Live chat, live disputes |
| **Leiden** over the kNN graph | Groups decisions into clusters; checked against tree leaves | Supporting |
| **Node similarity / degree comparison** by actor | Finds Team B as the deviating group | Supporting |

The tree learner finds branch conditions; GDS finds similarity, clusters, and deviating groups.

---

## 8. Agent, Tools, Loop

### 8.1 Model and tools

- **Model:** `claude-sonnet-5` (latency); `claude-opus-5-5` optional if quality needs it.
- **Tools** (Next.js server routes; also exposed over MCP):

| Tool | Returns / does |
|---|---|
| `check_before_act(decision_type, context)` | Top similar past decisions (vector + kNN), options chosen, outcome rates, the matching tree branch |
| `find_precedent(query)` | Similar decisions by free-text description |
| `why(decision_id)` | Path, branch conditions, and outcomes for a past decision |
| `propose_resolution(ticket_id, option, amount_usd, rationale)` | Emits the gateway event that becomes a `PROPOSAL` |
| `respond_to_dispute(dispute_id, action, evidence[], rationale)` | Emits the gateway event that becomes `dispute.response` / `dispute.evidence` |

- **Graph on/off:** "off" removes `check_before_act`, `find_precedent`, and `why` from the agent's tool list. Nothing else changes.
- **Instructions:** the agent uses the v2 prompt ("reduce refunds where possible") in the live chat, so "graph off" reliably proposes deny for Sam.

### 8.2 Live events

Every action in the app (agent tool call, rep approve/override, dispute response) emits an event in the same format as the mocked history and is sent to the pipeline function. The resulting decision appears in the graph panel within ~2 seconds.

### 8.3 Closed loop

1. Reveal 3 highlights a branch with poor outcomes and a sibling branch with good outcomes.
2. The app turns the difference into a **candidate rule**: "For `dispute.category = subscription_canceled` and `dispute.usage_logs_available = true`, include `usage_logs`."
3. **Apply rule** creates agent **v3**: an `Actor {version: 'v3'}` node with `(:Actor {version:'v3'})-[:DERIVED_FROM {rule, source_branch, applied_at}]->(:Actor {version:'v2'})`. *(`DERIVED_FROM` is a demo-level extension; register it in a future schema version.)*
4. **July streams in:** July events for v3 were sampled beforehand from the **same world model** (improvement is earned by sampling, not scripted), and are now ingested live through the pipeline.
5. **Fast-forward 90 days:** July outcomes are released over ~10 seconds; the branch scorer re-scores; the app shows v2 vs v3 at the same decision point.

Expected result (seed 42): usage logs included ~15% → ~97%; win rate ~27% → ~63%; monthly losses on this branch down by more than half. Show confidence ranges; they should not overlap.

---

## 9. Demo Script (about 9 minutes)

| # | Step | Time | On screen | Graph state | Neo4j moment | Line |
|---|---|---|---|---|---|---|
| 1 | **Opening** | 20s | Full graph zoom-out; counters (decisions, overrides, outcomes linked, systems) | Pre-loaded | Scale | "Six months of Streamly — Zendesk, Stripe, the fraud tool, and the AI agent — already captured as decisions." |
| 2 | **Dana's story** | 60s | Search "Dana"; her path across four decisions and systems, ending in a $210 loss and churn | Pre-loaded | Cypher path query | "Four decisions, four systems, three months apart. No single system saw this story. Neo4j does." |
| 3 | **Reveal 1: policy vs reality** | 60s | Policy tree vs actual `dispute.response` tree; AI contests small disputes the policy says to accept (T3) | Pre-loaded | Tree comparison | "This is the decision logic you actually run. Nobody wrote it down." |
| 4 | **Reveal 2: AI vs human** | 60s | Complaint step: humans override AI deny for tenure ≥ 24; refunded 3% dispute vs denied 25%, **within the same tenure group** (T1). Side note: "AI deny rate rose from 30% to 55% after prompt v2 in April" (T4) | Pre-loaded | `OVERRIDES` traversal; v1 vs v2 tree | "Your people were right. Here's the proof, 60 days later." |
| 5 | **The next Dana** | 90s | Chat as **Sam**. Graph **off**: agent proposes deny. Switch **on**: agent calls `check_before_act`, sees the tenure precedent, proposes refund (or pause). Rep approves in the console; decision appears in the graph | **Live** | Vector + kNN + live write | "Same customer, same message. The only difference is the graph." |
| 6 | **Reveal 3: hidden cost** | 60s | Evidence tree: `subscription_canceled` without usage logs, 20% win, ~$25k per quarter lost (T2). Show the 5-line Cypher | Pre-loaded | Path query + tree learner | "One missing piece of evidence costs $25k a quarter." |
| 7 | **Close the loop** | 75s | **Apply rule** → agent v3. July streams in; **fast-forward 90 days**; v2 vs v3: win rate ~27% → ~63% | **Live** | Version comparison; bi-temporal re-scoring | "The graph found it, we changed it, and the graph proved it worked." |
| 8 | **Live disputes** | 60s | Disputes queue: agent handles 3 disputes, each with `check_before_act` (Section 9.1) | **Live** | Vector + kNN + MCP | "Every dispute, checked against every decision before it." |
| 8b | **Scenario lab** *(optional, phase 2)* | 90s | Audience plants a rule; new month generated, ingested, tree built live; planted rule appears (Section 10.3) | **Live** | Live ingest + tree discovery | "You just made that rule up. Nobody told Rationode. It found it." |
| 9 | **Schema extends** | 30s | Schema registry: `pause_subscription` `PROPOSED` since May, 214 uses. Approve; complaint tree redraws with the new branch (T6) | Pre-loaded + switch | Self-extending schema | "Your agent started doing something new in May. Nobody modelled it." |
| 10 | **Close** | 15s | Full graph | — | — | "Every decision, from AI, humans, and systems — captured, connected, queryable, and changing the next decision. A decision graph, on Neo4j." |

### 9.1 Live disputes (step 8)

| Dispute | Precedent returned | Expected decision |
|---|---|---|
| `subscription_canceled`, $300, usage logs available | Contest with usage logs won 70%; without, 21% | Contest; include usage logs and ToS |
| `not_recognized`, $15 | Contesting under $50 loses money on average ($15 fee) | Accept |
| `unauthorized`, $480, charge approved at risk score 68 | Unauthorized disputes after approvals at risk 60–75 won ~4% | Accept; flag the fraud threshold for review (T5) |

### 9.2 Prepared answers

- **"Isn't that just correlation? Long-tenure customers might dispute less anyway."** We compare within the same tenure group: same kind of customer, different decision. In this simulated data that holds by construction; with real data, Rationode reports confidence ranges and "not enough data" rather than weak verdicts, and deeper causal methods are on the roadmap.
- **"Is the data real?"** The history and outcomes are simulated from a hidden world model; the events are in real Stripe, Zendesk, and gateway formats, and the pipeline, graph, analysis, and agent are real. The system rediscovered the patterns without being told them.
- **"Would the agent really deny without the graph?"** Yes: with the graph off it only has its instructions ("reduce refunds"). Nothing is scripted.

---

## 10. Demo App (Vercel)

**Access:** protected by an access code (the app spends API credit).

### 10.1 Main screen — "Streamly live" (four panels)

```
┌────────────────────────┬────────────────────────┐
│ STREAMLY HELP CHAT     │ AGENT'S THINKING       │
│ (customer's view)      │ tool calls + results   │
│                        │ proposal + rationale   │
│                        │ [Graph: ON | off]      │
├────────────────────────┼────────────────────────┤
│ SUPPORT REP CONSOLE    │ DECISION GRAPH (live)  │
│ AI suggestion          │ new nodes appear as    │
│ [Approve] [Override ▼] │ decisions land         │
└────────────────────────┴────────────────────────┘
```

### 10.2 Other screens

| Screen | Content |
|---|---|
| **Overview** | Full graph and counters (step 1) |
| **Case explorer** | Search a customer; case path as a graph with a timeline (Dana) |
| **Tree view** | One decision tree; branch widths by `share`, colored by outcome rate; scope toggle |
| **Tree compare** | Two trees side by side (policy vs actual, AI vs human, v1 vs v2, v2 vs v3), divergent branches highlighted |
| **Branch detail** | Conditions, support, outcome rates, cost, the Cypher behind it; **Apply rule** button |
| **Disputes queue** | Live dispute agent: case, tool calls, precedent, decision, rationale |
| **Schema registry** | Elements by status; **Approve** button; change log |

### 10.3 Scenario lab (phase 2, optional demo step)

Proves discovery isn't staged: someone plants a rule, and Rationode finds it live.

1. **Plant a rule:** set world-model dials (e.g. "humans always refund annual $480 customers," fraud review threshold, AI usage-log rate), or pick a preset.
2. **Generate:** the simulator creates a fresh month (~5,000 cases) in a few seconds.
3. **Ingest:** events stream into Neo4j under a new `scenario_id`; the graph grows on screen.
4. **Discover:** the decision tree is built live; the planted rule appears as a branch with its outcomes, compared against the main history tree.

*Line:* "You just made that rule up. Nobody told Rationode. It found it."

| Step | Where it runs | Target time |
|---|---|---|
| Generate | Vercel Python function (simulator) | < 5 s |
| Ingest | Vercel Python function (pipeline, batched writes) | < 60 s for ~25k events, with progress |
| Build tree | Vercel Python function (Rationode's own tree learner, no scikit-learn) | < 5 s |
| Compare and display | Next.js + Cypher | instant |
| GDS | Not live (sessions too slow to start); main-history results only | — |

**Cleanup:** a lab scenario is deleted by `scenario_id` when the demo resets.

### 10.4 Presenter controls

- **Reset demo** (restores Section 5.3 state).
- **Recorded mode** per live step: replays a saved agent run if the API is slow or offline.
- **Step jump** to any script step.

---

## 11. Tech Stack

| Area | Choice |
|---|---|
| Graph database | **Neo4j AuraDB Professional** (smallest size) |
| Graph analytics | **Aura Graph Analytics** sessions via the GDS Python client (`graphdatascience`); billed per session, so run in short sessions offline and write results back |
| Demo app | **Next.js (TypeScript) on Vercel** |
| Graph visualization | Neo4j's graph visualization library (NVL) in the browser |
| Agent | Anthropic TypeScript SDK with tool use; `claude-sonnet-5` |
| Agent tools and MCP | Next.js server routes using the Neo4j JavaScript driver; same tools exposed over MCP |
| Live pipeline | Python pipeline package deployed as a Vercel Python function |
| Offline data work | Python 3.12: simulator, batch pipeline, tree builder, GDS, embeddings |
| Tree learner | Rationode's own lightweight classification-tree learner (pure Python), used offline and live so results match; no scikit-learn (too heavy for Vercel functions) |
| Embeddings | Local sentence-embedding model offline; the same model's dimensions set on the vector index (e.g. 384, not the 1536 in the v4.1 example). Live contexts embedded with the same model (hosted endpoint or precomputed for prepared cases) |
| Secrets | Environment variables only, never committed: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `ANTHROPIC_API_KEY`, `DEMO_ACCESS_CODE`, Aura API client ID and secret (for Graph Analytics) |

**Open technical choice:** how live contexts (Sam, the 3 disputes, July) get embeddings with the same model as the offline data. Options: precompute for all prepared cases (simplest), or host the model behind a small endpoint.

---

## 12. Acceptance Criteria

- All six planted truths are rediscovered from data (no hard-coded conclusions) and visible on the stated screens.
- Every decision traces back to a mocked raw event (`EVIDENCED_BY`).
- Dana's full path renders from a single Cypher query.
- **Graph on/off:** with the graph off, the agent proposes deny for Sam in at least 9 of 10 runs; with it on, it proposes refund or pause in at least 9 of 10.
- Live decisions (chat, rep, disputes) appear in the graph within ~2 seconds.
- Loop shows v2 → v3 at the evidence decision point (~27% → ~63% win rate) with non-overlapping confidence ranges.
- `pause_subscription` is excluded from trees while `PROPOSED` and appears in the complaint tree after approval.
- Reset returns the exact starting state; every live step has a recorded mode.
- On-screen note that history and outcomes are simulated.
- App protected by an access code.

---

### 11.1 Design rules that keep the Scenario lab possible

- **Configurable world model:** the simulator takes a world configuration object (defaults = the planted truths), so dials can override any parameter.
- **Scenario isolation:** every node written by the pipeline carries a `scenario_id` (`history` for the main graph; loop and lab runs get their own). IDs outside `history` are prefixed with the scenario, and a scenario can be deleted cleanly.
- **Incremental, idempotent pipeline:** decisions, outcomes, and entities get deterministic IDs derived from source events and are written with `MERGE`, so the same code handles the full batch offline and small live batches in a Vercel Python function.
- **One tree learner** for offline and live.

## 13. Out of Scope (v1)

- Real Stripe, Zendesk, or fraud-tool connections (events are mocked in their real formats).
- Bank-side and card-network dispute rules (second-round appeals, network time limits).
- Audience-as-human override.
- Automatic schema induction beyond detecting unknown tool names and option values.
- Live tree rebuilding (stretch goal).
- Multi-merchant or multi-tenant setup.

---

## 14. Build Milestones

| # | Milestone | Done when |
|---|---|---|
| 1 | **AuraDB + schema** | Instance reachable; constraints, indexes, registry seeded for four decision types |
| 2 | **Simulator + world model** | Raw event files generated; planted truths verified from simulator ground truth |
| 3 | **Pipeline (batch)** | Jan–Jun events produce the full graph; Dana's path query works; `EVIDENCED_BY` provenance intact |
| 4 | **Trees + comparisons** | All scopes built; the three reveals visible via Cypher |
| 5 | **GDS + embeddings** | kNN, Leiden, vector index; `check_before_act` returns sensible precedent |
| 6 | **App skeleton + tools** | Next.js on Vercel with access code; agent tools and MCP working against AuraDB |
| 7 | **Live chat + rep console + graph on/off** | "The next Dana" works end to end; on/off criterion met |
| 8 | **Live pipeline + disputes queue** | Live events land in ~2 seconds; 3 disputes handled |
| 9 | **Loop + schema moment** | Apply rule → v3 → July → fast-forward → comparison; `pause_subscription` approval |
| 10 | **Screens, reset, recorded mode, rehearsal** | Full run in about 9 minutes, twice in a row from reset |
| 11 | **Scenario lab (phase 2)** | Plant a rule → generate → ingest → tree in under ~90 seconds; planted rule found as a branch; scenario deleted on reset |
