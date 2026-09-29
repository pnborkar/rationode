"""Turn raw events into decision-graph rows (demo spec Section 7.1).

A pure function of (events, registry, scenario): no database access. Every ID is
derived from source event IDs, so re-running over the same events (or over a
case's full event set plus new live events) yields the same rows, and writes
can MERGE idempotently.
"""

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from rationode.pipeline.parse import Ev, parse

FRAUD_ACTOR = ("system:fraudguard", "SYSTEM", "rules-2026.1", "FraudGuard rules")
POLICIES = {"charge.fraud_screen": ("fraud-screening", "2025.1"),
            "support.complaint_resolution": ("streamly-refunds", "2025.1"),
            "dispute.response": ("streamly-disputes", "2025.1"),
            "dispute.evidence": ("streamly-disputes", "2025.1")}
DISPUTE_FEE = CONTEST_FEE = 15.0
AI_FINAL_CONFIDENCE = 0.9   # AI proposal executed without human action (inferred from ticket closure)


@dataclass
class Registry:
    """Known options per decision type with status, and outcome attribution windows."""
    options: dict[str, dict[str, str]]
    windows: dict[str, int]

    def approved(self, decision_type: str) -> list[str]:
        return sorted(k for k, s in self.options.get(decision_type, {}).items() if s == "APPROVED")


@dataclass
class Rows:
    events: list = field(default_factory=list)
    entities: list = field(default_factory=list)
    same_as: list = field(default_factory=list)
    actors: dict = field(default_factory=dict)
    decisions: list = field(default_factory=list)
    contexts: list = field(default_factory=list)
    considered: list = field(default_factory=list)
    made_by: list = field(default_factory=list)
    about: list = field(default_factory=list)
    preceded_by: list = field(default_factory=list)
    overrides: list = field(default_factory=list)
    under_policy: list = field(default_factory=list)
    evidenced_by: list = field(default_factory=list)
    outcomes: list = field(default_factory=list)
    led_to: list = field(default_factory=list)
    schema_proposals: dict = field(default_factory=dict)
    links: list = field(default_factory=list)   # identity: PAID_WITH, FROM_DEVICE, USED
    review: list = field(default_factory=list)

    def counts(self) -> dict:
        return {k: len(v) for k, v in self.__dict__.items()}


def ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


class Detector:
    def __init__(self, registry: Registry, scenario: str = "history"):
        self.reg = registry
        self.scenario = scenario
        self.rows = Rows()
        self.entity_ids: set[str] = set()
        self.by_customer: dict[str, list[tuple[str, str, str]]] = defaultdict(list)  # cus -> (at, decision_id, kind)
        self.chosen_rows: dict[str, list[dict]] = {}   # decision_id -> its CHOSEN/PROPOSED considered rows

    # ------------------------------------------------------------ ids and small writers
    def pid(self, value: str) -> str:
        return value if self.scenario == "history" else f"{self.scenario}|{value}"

    def entity(self, label: str, source: str, key: str, **props) -> str:
        entity_id = self.pid(f"{source}:{key}")
        if entity_id not in self.entity_ids:
            self.entity_ids.add(entity_id)
            self.rows.entities.append({"entity_id": entity_id, "label": label, "source_system": source,
                                       "source_key": key, "props": props, "scenario_id": self.scenario})
        return entity_id

    def actor(self, actor_id: str, kind: str, version: str | None, name: str, team: str | None = None) -> str:
        aid = self.pid(actor_id)
        self.rows.actors.setdefault(aid, {"actor_id": aid, "kind": kind, "version": version, "name": name,
                                          "team": team, "scenario_id": self.scenario})
        return aid

    def option_status(self, decision_type: str, option: str, at: str) -> None:
        known = self.reg.options.setdefault(decision_type, {})
        if option not in known:
            known[option] = "PROPOSED"
            self.rows.schema_proposals[f"{decision_type}.{option}"] = {
                "key": f"{decision_type}.{option}", "decision_type": decision_type, "option_key": option,
                "first_seen_at": at, "display_name": option.replace("_", " ").capitalize()}

    def decision(self, source_event: Ev, decision_type: str, stage: str, *, actor: str, role: str,
                 chosen: list[tuple[str, float | None]], context: dict, summary: str, about: list[str],
                 evidence: list[Ev], suffix: str = "", at: str | None = None, confidence: float = 1.0,
                 rejected: list[str] = (), proposed_status: bool = False, all_options: list[str] | None = None) -> str:
        at = at or source_event.at
        did = self.pid(f"dec:{source_event.event_id}{suffix}")
        r = self.rows
        r.decisions.append({"decision_id": did, "decision_type": decision_type, "stage": stage, "decided_at": at,
                            "detection_method": "RULE", "detection_confidence": confidence,
                            "source_system": source_event.source, "scenario_id": self.scenario})
        r.contexts.append({"context_id": self.pid(f"ctx:{source_event.event_id}{suffix}"), "decision_id": did,
                           "attrs": context, "summary_text": summary, "scenario_id": self.scenario})
        chosen_keys = {o for o, _ in chosen}
        self.chosen_rows[did] = []
        for option, amount in chosen:
            self.option_status(decision_type, option, at)
            row = {"decision_id": did, "decision_type": decision_type, "option_key": option,
                   "status": "PROPOSED" if proposed_status else "CHOSEN", "amount_usd": amount}
            r.considered.append(row)
            self.chosen_rows[did].append(row)
        for option in rejected:
            if option not in chosen_keys:
                r.considered.append({"decision_id": did, "decision_type": decision_type, "option_key": option,
                                     "status": "REJECTED", "amount_usd": None})
        for option in (all_options if all_options is not None else self.reg.approved(decision_type)):
            if option not in chosen_keys and option not in rejected:
                r.considered.append({"decision_id": did, "decision_type": decision_type, "option_key": option,
                                     "status": "AVAILABLE", "amount_usd": None})
        r.made_by.append({"decision_id": did, "actor_id": actor, "role": role})
        r.about.extend({"decision_id": did, "entity_id": e} for e in about)
        policy_id, version = POLICIES[decision_type]
        r.under_policy.append({"decision_id": did, "policy_id": policy_id, "version": version})
        r.evidenced_by.extend({"node_id": did, "kind": "Decision", "event_id": self.pid(e.event_id)} for e in evidence)
        return did

    def outcome(self, source_event: Ev, outcome_type: str, value: float | None) -> str:
        oid = self.pid(f"out:{source_event.event_id}")
        self.rows.outcomes.append({"outcome_id": oid, "outcome_type": outcome_type, "occurred_at": source_event.at,
                                   "value_usd": value, "scenario_id": self.scenario})
        self.rows.evidenced_by.append({"node_id": oid, "kind": "Outcome", "event_id": self.pid(source_event.event_id)})
        return oid

    def led_to(self, decision_id: str | None, outcome_id: str, outcome_type: str, method: str, confidence: float) -> None:
        if decision_id:
            self.rows.led_to.append({"decision_id": decision_id, "outcome_id": outcome_id, "confidence": confidence,
                                     "attribution_method": method, "window_days": self.reg.windows.get(outcome_type)})

    # ------------------------------------------------------------ main
    def run(self, raw_events: list[dict]) -> Rows:
        evs = sorted((parse(r) for r in raw_events), key=lambda e: (e.at, e.event_id))
        ticket_charge, dispute_charge, email_cus, cus_name = {}, {}, {}, {}
        for e in evs:
            if e.ticket_id and e.charge_id:
                ticket_charge[e.ticket_id] = e.charge_id
            if e.dispute_id and e.charge_id:
                dispute_charge[e.dispute_id] = e.charge_id
            if e.stripe_customer_id and e.email:
                email_cus[e.email] = e.stripe_customer_id
            if e.type == "charge.succeeded":
                cus_name[e.stripe_customer_id] = e.data["name"]

        cases: dict[str, list[Ev]] = defaultdict(list)
        customer_events: list[Ev] = []
        identity_events: list[Ev] = []
        for e in evs:
            self.rows.events.append({
                "event_id": self.pid(e.event_id), "source_system": e.source, "event_type": e.type,
                "occurred_at": e.at, "payload_json": json.dumps(e.payload, separators=(",", ":")),
                "charge_id": e.charge_id, "ticket_id": e.ticket_id, "dispute_id": e.dispute_id,
                "stripe_customer_id": e.stripe_customer_id, "email": e.email, "scenario_id": self.scenario})
            charge = e.charge_id or ticket_charge.get(e.ticket_id) or dispute_charge.get(e.dispute_id)
            if e.data.get("card_fingerprint") or e.data.get("device_id"):
                identity_events.append(e)
            if e.kind == "fraudguard:charge.signals":            # identity only, not part of the case
                continue
            if e.source in ("subscriptions", "streamly_app"):   # customer-level: outcomes and usage context
                customer_events.append(e)
            elif charge:
                cases[charge].append(e)
            else:
                self.rows.review.append({"event_id": e.event_id, "reason": "no case key"})

        for charge_id, case_events in cases.items():
            self.case(charge_id, case_events, email_cus, cus_name)
        for e in identity_events:
            self.identity(e, email_cus)
        self.customer_outcomes(customer_events)
        return self.rows

    # ------------------------------------------------------------ identity (card, device) behind a charge
    def identity(self, e: Ev, email_cus: dict) -> None:
        cus = e.stripe_customer_id or email_cus.get(e.email)
        if not (cus and e.charge_id):
            self.rows.review.append({"event_id": e.event_id, "reason": "identity signals without customer or charge"})
            return
        charge, customer = self.pid(f"stripe:{e.charge_id}"), self.pid(f"stripe:{cus}")
        d, links = e.data, self.rows.links
        if d.get("card_fingerprint"):
            card = self.entity("Card", "card", d["card_fingerprint"], country=d.get("card_country"))
            links.append({"type": "PAID_WITH", "from": charge, "to": card, "at": e.at, "ip_country": None})
            links.append({"type": "USED", "from": customer, "to": card, "at": e.at, "ip_country": None})
        if d.get("device_id"):
            device = self.entity("Device", "device", d["device_id"])
            links.append({"type": "FROM_DEVICE", "from": charge, "to": device, "at": e.at, "ip_country": d.get("ip_country")})
            links.append({"type": "USED", "from": customer, "to": device, "at": e.at, "ip_country": None})

    # ------------------------------------------------------------ one case (one charge)
    def case(self, charge_id: str, evs: list[Ev], email_cus: dict, cus_name: dict) -> None:
        screen = next((e for e in evs if e.type == "charge.screened"), None)
        email = next((e.email for e in evs if e.email), None)
        cus = next((e.stripe_customer_id for e in evs if e.stripe_customer_id), None) or email_cus.get(email)
        if not cus:
            self.rows.review.append({"case": charge_id, "reason": "customer not resolved"})
            return
        customer = self.entity("Customer", "stripe", cus, email=email, name=cus_name.get(cus))
        amount = screen.data["amount"] if screen else None
        charge = self.entity("Charge", "stripe", charge_id, amount_usd=amount,
                             plan=screen.data["plan"] if screen else None)

        screen_dec = complaint_final = proposal = None
        ticket = ticket_entity = None
        sessions: dict[str, Ev] = {}
        dispute_ev = response_dec = evidence_dec = contested = None

        for e in evs:
            k = e.kind
            if k == "fraudguard:charge.screened":
                d = e.data
                screen_dec = self.decision(
                    e, "charge.fraud_screen", "FINAL", actor=self.actor(*FRAUD_ACTOR), role="DECIDER",
                    chosen=[(d["decision"], None)], about=[charge, customer], evidence=[e],
                    context={"charge.risk_score": d["risk_score"], "charge.plan": d["plan"],
                             "charge.is_renewal": d["is_renewal"], "charge.country_match": d["country_match"],
                             "charge.card_age_days": d["card_age_days"]},
                    summary=f"Charge screening: {'renewal' if d['is_renewal'] else 'signup'} on {d['plan']}, "
                            f"${d['amount']:.0f}, risk score {d['risk_score']}, card age {d['card_age_days']} days, "
                            f"country {'matches' if d['country_match'] else 'does not match'}.")
                self.by_customer[cus].append((e.at, screen_dec, "screen"))

            elif k == "zendesk:ticket.created":
                ticket = e
                ticket_entity = self.entity("Ticket", "zendesk", f"ticket:{e.ticket_id}",
                                            category=e.data["category"], channel=e.data["channel"],
                                            subject=e.data["subject"])
                zd_user = self.entity("Customer", "zendesk", f"user:{e.email}", email=e.email, name=e.data["name"])
                self.rows.same_as.append({"from": zd_user, "to": customer, "confidence": 0.98, "method": "EMAIL"})

            elif e.source == "mcp_gateway" and e.tool in ("get_customer", "get_dispute_evidence"):
                sessions[e.session_id] = e

            elif k == "mcp_gateway:propose_resolution":
                info = sessions.get(e.session_id)
                if not (info and ticket):
                    self.rows.review.append({"event_id": e.event_id, "reason": "proposal without customer lookup or ticket"})
                    continue
                res, args = info.data["result"], e.data["args"]
                ctx = self.complaint_context(res, ticket, args)
                actor = self.agent_actor(e)
                proposal = {"id": None, "option": args["option"], "amount": args["amount_usd"], "ctx": ctx,
                            "evidence": [ticket, info, e], "actor": actor}
                proposal["id"] = self.decision(
                    e, "support.complaint_resolution", "PROPOSAL", actor=actor, role="PROPOSER",
                    chosen=[(args["option"], args["amount_usd"])], proposed_status=True, context=ctx,
                    summary=self.complaint_summary(ctx, f"AI {e.data['agent_version']} proposed {args['option']}"),
                    about=[ticket_entity, charge, customer], evidence=proposal["evidence"])
                self.rows.preceded_by.append({"from": proposal["id"], "to": screen_dec})

            elif k in ("zendesk:macro.applied", "zendesk:ticket.updated") and proposal and not complaint_final:
                human = k == "zendesk:macro.applied"
                if not human and e.data["actor_id"] != "streamly-support-agent":
                    continue
                option = e.data["option"] if human else proposal["option"]
                if human:
                    actor = self.actor(f"zendesk:{e.data['actor_id']}", "HUMAN", None, e.data["actor_name"],
                                       e.data["group"])
                else:
                    actor = proposal["actor"]
                overridden = option != proposal["option"]
                amount_final = proposal["amount"] if not overridden else None
                complaint_final = self.decision(
                    e, "support.complaint_resolution", "FINAL", actor=actor, role="DECIDER",
                    chosen=[(option, amount_final)], rejected=[proposal["option"]] if overridden else [],
                    context=dict(proposal["ctx"]), confidence=1.0 if human else AI_FINAL_CONFIDENCE,
                    summary=self.complaint_summary(
                        proposal["ctx"], (f"{e.data['group']} rep chose {option}" if human else f"AI executed {option}")
                        + (f", overriding AI proposal {proposal['option']}" if overridden else "")),
                    about=[ticket_entity, charge, customer], evidence=[e])
                self.rows.preceded_by.append({"from": complaint_final, "to": proposal["id"]})
                if overridden:
                    self.rows.overrides.append({"from": complaint_final, "to": proposal["id"], "detected_at": e.at})
                self.by_customer[cus].append((e.at, complaint_final, "complaint"))

            elif k == "stripe:refund.created":
                out = self.outcome(e, "refund_cost", e.data["amount"])
                self.led_to(complaint_final, out, "refund_cost", "EXPLICIT_REF", 1.0)
                for row in self.chosen_rows.get(complaint_final, []):   # record the executed amount
                    row["amount_usd"] = e.data["amount"]

            elif k == "stripe:charge.dispute.created":
                dispute_ev = e
                out = self.outcome(e, "dispute_filed", e.data["amount"])
                self.led_to(screen_dec, out, "dispute_filed", "EXPLICIT_REF", 1.0)
                self.led_to(complaint_final, out, "dispute_filed", "EXPLICIT_REF", 1.0)

            elif k == "mcp_gateway:respond_to_dispute" and dispute_ev:
                info = sessions.get(e.session_id)
                if not info:
                    self.rows.review.append({"event_id": e.event_id, "reason": "dispute response without evidence lookup"})
                    continue
                res, args = info.data["result"], e.data["args"]
                dispute_entity = self.entity("Dispute", "stripe", dispute_ev.dispute_id, category=res["category"],
                                             amount_usd=res["amount_usd"])
                ctx = {"dispute.amount_usd": res["amount_usd"], "dispute.category": res["category"],
                       "dispute.tenure_months": res["customer_tenure_months"],
                       "dispute.prior_complaint": res["prior_complaint"],
                       "dispute.usage_logs_available": "usage_logs" in res["available_evidence"]}
                actor = self.agent_actor(e)
                contested = args["action"] == "contest"
                base = (f"Dispute ({res['category']}), ${res['amount_usd']:.0f}, tenure {res['customer_tenure_months']} "
                        f"months, {'after a complaint' if res['prior_complaint'] else 'no prior complaint'}, usage logs "
                        f"{'available' if ctx['dispute.usage_logs_available'] else 'not available'}")
                response_dec = self.decision(
                    e, "dispute.response", "FINAL", actor=actor, role="DECIDER", chosen=[(args["action"], None)],
                    context=ctx, summary=f"{base}. AI {e.data['agent_version']} chose to {args['action']}.",
                    about=[dispute_entity, charge, customer], evidence=[dispute_ev, info, e])
                self.rows.preceded_by.append({"from": response_dec, "to": complaint_final or screen_dec})
                self.by_customer[cus].append((e.at, response_dec, "dispute"))
                if contested:
                    chosen = args["evidence"]
                    evidence_dec = self.decision(
                        e, "dispute.evidence", "FINAL", actor=actor, role="DECIDER", suffix=":evidence",
                        chosen=[(x, None) for x in chosen], all_options=res["available_evidence"], context=dict(ctx),
                        summary=f"{base}. AI {e.data['agent_version']} submitted evidence: {', '.join(chosen)}.",
                        about=[dispute_entity, charge, customer], evidence=[info, e])
                    self.rows.preceded_by.append({"from": evidence_dec, "to": response_dec})

            elif k == "stripe:charge.dispute.closed" and dispute_ev:
                won = e.data["status"] == "won"
                cost = DISPUTE_FEE + (0 if won else e.data["amount"] + (CONTEST_FEE if contested else 0))
                otype = "dispute_won" if won else "dispute_lost"
                out = self.outcome(e, otype, round(cost, 2))
                self.led_to(response_dec, out, otype, "EXPLICIT_REF", 1.0)
                self.led_to(evidence_dec, out, otype, "EXPLICIT_REF", 1.0)

    def agent_actor(self, e: Ev) -> str:
        v = e.data["agent_version"]
        return self.actor(f"agent:{e.data['agent_id']}:{v}", "AI_AGENT", v, f"Streamly support agent {v}")

    @staticmethod
    def complaint_context(res: dict, ticket: Ev, args: dict) -> dict:
        # The ticket's tag, or (live chats have none yet) the category the agent tagged when proposing.
        category = ticket.data["category"] or args.get("category")
        return {"support.tenure_months": res["tenure_months"], "support.plan": res["plan"],
                "support.amount_usd": res["charge_amount_usd"], "support.complaint_category": category,
                "support.prior_refunds_90d": res["prior_refunds_90d"], "support.channel": ticket.data["channel"]}

    @staticmethod
    def complaint_summary(ctx: dict, what: str) -> str:
        return (f"Complaint ({ctx['support.complaint_category']}) via {ctx['support.channel']}: customer tenure "
                f"{ctx['support.tenure_months']} months on {ctx['support.plan']}, ${ctx['support.amount_usd']:.0f} "
                f"charge, {ctx['support.prior_refunds_90d']} refunds in last 90 days. {what}.")

    # ------------------------------------------------------------ churn and renewal (same-customer window)
    def customer_outcomes(self, evs: list[Ev]) -> None:
        for e in evs:
            if e.type not in ("subscription.canceled", "subscription.renewed"):
                continue
            otype = "churn" if e.type == "subscription.canceled" else "renewal"
            window = timedelta(days=self.reg.windows.get(otype, 400))
            at = ts(e.at)
            prior = [(t, d, kind) for t, d, kind in self.by_customer.get(e.stripe_customer_id, [])
                     if ts(t) <= at and at - ts(t) <= window]
            candidates = [d for _, d, kind in prior if kind in ("complaint", "dispute")]
            if not candidates:
                candidates = [d for _, d, kind in prior if kind == "screen"][-1:]
            if not candidates:
                continue
            out = self.outcome(e, otype, None)
            confidence = 1.0 if len(candidates) == 1 else 0.6
            for d in candidates:
                self.led_to(d, out, otype, "SAME_ENTITY_WINDOW", confidence)
