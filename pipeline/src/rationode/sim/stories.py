"""The Events tab's four sets (demo spec Section 10.5).

Each set is one customer's journey generated with the world model, run through the
real pipeline (Detector) under its own scenario (`story:<key>`), and split into
"events" and "60 days later". Output: web/src/data/stories/set-<n>.json, holding the
raw events, the rows Neo4j should receive, and what each event became.

Usage:
    uv run python -m rationode.sim.stories
"""

import json
from dataclasses import asdict
from datetime import date, timedelta

from rationode.db import REPO_ROOT, database, driver
from rationode.pipeline.detect import Detector, Registry
from rationode.pipeline.write import load_registry
from rationode.sim import formats as f
from rationode.sim import identifiers
from rationode.sim import world as wm
from rationode.sim.generate import Sim, months_before

OUT_DIR = REPO_ROOT / "web" / "src" / "data" / "stories"
OUTCOME_TYPES = {"charge.dispute.closed", "subscription.canceled", "subscription.renewed"}

# One entry per set. "message" is what the customer says on the live tab (None = their Zendesk ticket's words).
# "usage" is weekly viewing from the Streamly app: (week start, hours watched), chosen to fit each story.
SETS = [
    dict(set=1, key="priya", name="Priya Shah", plan="monthly_49", tenure=30, renewal=True, charge_day=date(2026, 6, 12),
         force={"risk_score": 22, "fraud": False, "complaint": True, "complaint_at": wm.dt(date(2026, 6, 16), 14.2),
                "category": "didnt_use", "ai_option": "deny", "reviewed": True, "rep_team": "A",
                "final_option": "full_refund", "dispute": False, "churn": False, "renew": True},
         title="The loyal customer we almost lost",
         point="A human override recorded against the AI, and it worked.", message=None,
         usage=[(date(2026, 5, 18), 0.5), (date(2026, 5, 25), 0.0), (date(2026, 6, 1), 0.0), (date(2026, 6, 8), 0.0),
                (date(2026, 6, 15), 0.0), (date(2026, 6, 22), 1.5)]),
    dict(set=2, key="leo", name="Leo Marsh", plan="annual_180", tenure=26, renewal=True, charge_day=date(2026, 6, 5),
         force={"risk_score": 18, "fraud": False, "complaint": True, "complaint_at": wm.dt(date(2026, 6, 9), 10.5),
                "category": "didnt_use", "ai_option": "deny", "reviewed": True, "rep_team": "A", "final_option": "deny",
                "dispute": True, "dispute_category": "subscription_canceled", "dispute_at": wm.dt(date(2026, 6, 22), 9.0),
                "usage_logs_available": True, "contest": True, "evidence": ["tos_acceptance"], "won": False,
                "churn": True},
         title="Denied, disputed, lost",
         point="A costly chain across Zendesk, the agent, and Stripe: the Dana pattern, live.", message=None,
         usage=[(date(2026, 5, 11), 0.0), (date(2026, 5, 18), 0.0), (date(2026, 5, 25), 0.0), (date(2026, 6, 1), 0.0),
                (date(2026, 6, 8), 0.0), (date(2026, 6, 15), 0.0)]),
    dict(set=3, key="mei", name="Mei Tanaka", plan="monthly_49", tenure=38, renewal=True, charge_day=date(2026, 6, 14),
         force={"risk_score": 15, "fraud": False, "complaint": True, "complaint_at": wm.dt(date(2026, 6, 18), 16.0),
                "category": "too_expensive", "ai_option": "pause_subscription", "reviewed": True, "rep_team": "B",
                "final_option": "pause_subscription", "dispute": False, "churn": False, "renew": True},
         title="The pause that saved a customer",
         point="The newer pause_subscription option (still PROPOSED in the schema registry) showing up in fresh events.",
         message=None,
         usage=[(date(2026, 5, 18), 5.5), (date(2026, 5, 25), 6.0), (date(2026, 6, 1), 4.5), (date(2026, 6, 8), 5.0),
                (date(2026, 6, 15), 3.5), (date(2026, 6, 22), 0.0)]),
    dict(set=4, key="omar", name="Omar Haddad", plan="annual_480", tenure=0, renewal=False, charge_day=date(2026, 6, 20),
         force={"risk_score": 70, "fraud": True, "contest": True, "won": False, "churn": True},
         title="The fraud that slipped through",
         point="The fraud tool approved a risk-70 signup (its review threshold is 75); the charge came back as unauthorized.",
         message="I never signed up for Streamly. Why was I charged $480?",
         usage=[(date(2026, 6, 22), 0.0)]),
    dict(set=5, key="nina", name="Nina Brooks", plan="annual_300", tenure=34, renewal=True, charge_day=date(2026, 6, 8),
         force={"risk_score": 12, "fraud": False, "no_complaint": True, "friendly_dispute": True,
                "dispute_category": "subscription_canceled", "dispute_at": wm.dt(date(2026, 6, 19), 15.0),
                "usage_logs_available": True, "contest": True, "evidence": ["usage_logs", "tos_acceptance"],
                "won": True, "churn": False},
         title="The usage logs that won",
         point="She told her bank she'd canceled; the agent sent usage logs showing she kept watching, and the dispute was won.",
         message="I thought I canceled. Why was I charged $300 again?",
         usage=[(date(2026, 5, 18), 6.5), (date(2026, 5, 25), 7.5), (date(2026, 6, 1), 6.0), (date(2026, 6, 8), 8.0),
                (date(2026, 6, 15), 5.5), (date(2026, 6, 22), 6.5)]),
    dict(set=6, key="theo", name="Theo Grant", plan="monthly_25", tenure=3, renewal=True, charge_day=date(2026, 6, 10),
         force={"risk_score": 25, "fraud": False, "complaint": True, "complaint_at": wm.dt(date(2026, 6, 13), 11.0),
                "category": "didnt_use", "ai_option": "deny", "reviewed": True, "rep_team": "B",
                "final_option": "full_refund", "dispute": False, "churn": True},
         title="The generous rep",
         point="A Team B rep refunded a 3-month customer the AI would have denied; he cancelled anyway. "
               "GDS picked out Team B's peer group for calls like this.",
         message=None,
         usage=[(date(2026, 5, 25), 0.0), (date(2026, 6, 1), 0.0), (date(2026, 6, 8), 0.0), (date(2026, 6, 15), 0.0)]),
]


def usage_events(sim: Sim, c, weeks) -> list[dict]:
    """Weekly viewing summaries, each emitted at the end of its week (only weeks after signup)."""
    return [f.playback_weekly(sim.ids, wm.dt(week + timedelta(days=7), 6.0), c, week.isoformat(), hours,
                              titles=max(0, round(hours * 1.3)))
            for week, hours in weeks if week >= c.started - timedelta(days=6)]


def summarize(rows, events: list[dict]) -> dict[str, list[str]]:
    """What each event became: decisions, outcomes, identity links."""
    became: dict[str, list[str]] = {e["event_id"]: [] for e in events}
    by_id = {e["event_id"]: e for e in events}
    decisions = {d["decision_id"]: d for d in rows.decisions}
    chosen: dict[str, list[str]] = {}
    for c in rows.considered:
        if c["status"] in ("CHOSEN", "PROPOSED"):
            chosen.setdefault(c["decision_id"], []).append(c["option_key"])
    overrides = {o["from"] for o in rows.overrides}
    actors = {m["decision_id"]: rows.actors[m["actor_id"]] for m in rows.made_by}
    outcomes = {o["outcome_id"]: o for o in rows.outcomes}
    # Each decision/outcome ID embeds the event that produced it: "<scenario>|dec:<event_id>[:evidence]", "|out:<event_id>".
    def source_event(node_id: str) -> str:
        return node_id.split("|", 1)[-1].split(":", 1)[1].removesuffix(":evidence")

    for node_id in list(decisions) + list(outcomes):
        key = source_event(node_id)
        if node_id in decisions:
            d = decisions[node_id]
            a = actors[node_id]
            who = {"AI_AGENT": f"AI {a['version']}", "HUMAN": f"{a['name']} ({a['team']})", "SYSTEM": a["name"]}[a["kind"]]
            what = ", ".join(o.replace("_", " ") for o in chosen.get(node_id, []))
            label = f"Decision · {d['decision_type'].split('.')[1].replace('_', ' ')} · {d['stage'].lower()}: {what} · by {who}"
            if node_id in overrides:
                label += " · OVERRIDES the AI proposal"
            became[key].append(label)
        elif node_id in outcomes:
            o = outcomes[node_id]
            if o["outcome_type"] == "dispute_won":
                # value_usd is Streamly's cost (the fee); the disputed amount was kept.
                kept = by_id[key]["payload"]["data"]["object"]["amount"] / 100
                value = f" (${kept:.0f} kept, ${o['value_usd']:.0f} fee)"
            else:
                value = f" (${o['value_usd']:.0f})" if o["value_usd"] else ""
            became[key].append(f"Outcome · {o['outcome_type'].replace('_', ' ')}{value}")
    for s in rows.same_as:
        for e in events:
            if e["source_system"] == "zendesk" and e["event_type"] == "ticket.created":
                became[e["event_id"]].append("Identity · Zendesk requester SAME_AS Stripe customer (email match)")
                break
    return became


def rows_dict(rows) -> dict:
    d = asdict(rows)
    d["actors"] = list(d["actors"].values())
    d["schema_proposals"] = list(d["schema_proposals"].values())
    d.pop("review")
    return d


def subtract(all_rows: dict, first: dict) -> dict:
    """Rows present in all_rows but not in first (the '60 days later' delta)."""
    def key(table: str, r: dict) -> str:
        return json.dumps(r, sort_keys=True) if table not in ("events", "decisions", "outcomes", "entities", "contexts") \
            else r.get("event_id") or r.get("decision_id") or r.get("outcome_id") or r.get("entity_id") or r.get("context_id")
    out = {}
    for table, rows in all_rows.items():
        seen = {key(table, r) for r in first.get(table, [])}
        out[table] = [r for r in rows if key(table, r) not in seen]
    return out


def copy_registry(r: Registry) -> Registry:
    # The detector marks unseen options PROPOSED as it goes, so each run gets its own copy.
    return Registry({k: dict(v) for k, v in r.options.items()}, dict(r.windows))


def build(sim: Sim, spec: dict, registry: Registry) -> dict:
    n, key, name, plan, tenure = spec["set"], spec["key"], spec["name"], spec["plan"], spec["tenure"]
    charge_day = spec["charge_day"]
    started = months_before(charge_day, tenure) if tenure else charge_day
    c = sim.customer(started, plan=plan, name=name)
    c.email = f"{name.lower().replace(' ', '.')}.set{n}@example.com"
    force = dict(spec["force"])
    if team := force.pop("rep_team", None):
        force["rep"] = next(r for r in sim.reps if r["team"] == team)
    case_events, rec = sim.case(c, charge_day, renewal=spec["renewal"], force=force)
    identifiers.add_to_screening(case_events, rec, identifiers.CREW_FOR_SETS)
    events = [f.subscription_created(sim.ids, wm.dt(c.started, 10), c)] + case_events + usage_events(sim, c, spec["usage"])
    events.sort(key=lambda e: (e["occurred_at"], e["event_id"]))
    phase1 = [e for e in events if e["event_type"] not in OUTCOME_TYPES]
    phase2 = [e for e in events if e["event_type"] in OUTCOME_TYPES]

    scenario = f"story:{key}"
    rows_first = Detector(copy_registry(registry), scenario).run(phase1)
    rows_all = Detector(copy_registry(registry), scenario).run(events)
    first, total = rows_dict(rows_first), rows_dict(rows_all)
    became = summarize(rows_all, events)
    ticket = next((e for e in phase1 if e["event_type"] == "ticket.created"), None)
    message = spec["message"] or (ticket["payload"]["ticket"]["description"] if ticket else "")
    return {
        "set": n, "key": key, "scenario_id": scenario, "title": spec["title"], "point": spec["point"],
        "message": message, "via_bank": ticket is None,
        "customer": {"name": c.name, "email": c.email, "plan": plan, "tenure_months": tenure},
        "phases": [
            {"name": "events", "events": phase1, "rows": first},
            {"name": "60 days later", "events": phase2, "rows": subtract(total, first)},
        ],
        "became": became,
    }


def main() -> None:
    with driver() as d:
        base_registry = load_registry(d, database())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for spec in SETS:
        story = build(Sim(seed=1000 + spec["set"]), spec, base_registry)
        path = OUT_DIR / f"set-{spec['set']}.json"
        path.write_text(json.dumps(story, indent=1, default=str))
        p1, p2 = story["phases"]
        print(f"Set {spec['set']} ({story['customer']['name']}): {len(p1['events'])} events + {len(p2['events'])} later · "
              f"{len(p1['rows']['decisions'])} decisions, {len(p1['rows']['outcomes'])}+{len(p2['rows']['outcomes'])} outcomes"
              f"{' · schema proposals: ' + ', '.join(x['key'] for x in p1['rows']['schema_proposals']) if p1['rows']['schema_proposals'] else ''}")


if __name__ == "__main__":
    main()
