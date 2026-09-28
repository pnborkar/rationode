"""Simulate Streamly: six months of history, the loop month, and live cases.

Usage:
    uv run python -m rationode.sim.generate [--seed 42]

Writes to data/generated/ at the repo root:
    history_events.jsonl        Jan-Jun raw events (pre-loaded before the demo)
    loop_decision_events.jsonl  July, agent v3: everything up to dispute responses
    loop_outcome_events.jsonl   July, agent v3: dispute closures, churn, renewals ("fast-forward")
    live_cases.json             Sam (live chat) and the 3 live disputes
    ground_truth_*.jsonl        Simulator's own case records, for verification only
    manifest.json               Seed and counts
"""

import argparse
import json
import random
import string
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from rationode.db import REPO_ROOT
from rationode.sim import formats as f
from rationode.sim import world as wm
from rationode.sim.world import World

OUT_DIR = REPO_ROOT / "data" / "generated"

FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn",
         "Priya", "Arjun", "Mei", "Wei", "Sofia", "Lucas", "Amara", "Kofi", "Elena", "Mateo",
         "Noah", "Leah", "Omar", "Yuki", "Hana", "Ivan", "Nora", "Theo", "Zara", "Ravi"]
LAST = ["Nguyen", "Patel", "Garcia", "Kim", "Smith", "Okafor", "Rossi", "Muller", "Silva", "Cohen",
        "Tanaka", "Haddad", "Novak", "Larsen", "Mensah", "Costa", "Ibrahim", "Kowalski", "Reyes", "Chen"]

COMPLAINT_TEXT = {
    "too_expensive": ["The price went up again and it's too expensive for us now. Can you help?",
                      "I can't justify paying this much anymore. Is there anything you can do?"],
    "didnt_use": ["I was charged for a renewal but I haven't used the service at all. Can I get a refund?",
                  "I forgot to cancel and didn't watch anything this period. Please refund me."],
    "billing_error": ["I was charged twice this month. Please fix this.",
                      "The amount charged doesn't match my plan. I think it's a billing error."],
    "content_issue": ["The shows I subscribed for were removed. I want my money back.",
                      "Streaming quality has been terrible and half the catalog is gone."],
}

MACRO = {"full_refund": "Refund: full", "partial_refund": "Refund: partial (50%)",
         "voucher": "Voucher: 20% credit", "deny": "Deny refund", "pause_subscription": "Pause subscription"}

RATIONALE = {
    "full_refund": "Customer is eligible for a full refund under the circumstances.",
    "partial_refund": "Partial refund balances the customer's request with policy.",
    "voucher": "Offer account credit to retain the customer while limiting refunds.",
    "deny": "Policy does not support a refund for this request; reducing refunds.",
    "pause_subscription": "Offer a pause instead of a refund; customer finds the price too high right now.",
}


class Ids:
    ALPHABET = string.ascii_letters + string.digits

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.seen: set[str] = set()

    def new(self, prefix: str) -> str:
        while True:
            value = f"{prefix}_{''.join(self.rng.choices(self.ALPHABET, k=14))}"
            if value not in self.seen:
                self.seen.add(value)
                return value


@dataclass
class Customer:
    key: str
    name: str
    email: str
    stripe_customer_id: str
    subscription_id: str
    plan: str
    started: date
    price: float
    interval: str

    @property
    def monthly(self) -> bool:
        return self.interval == "month"

    def tenure_months(self, on: date) -> int:
        return max(0, (on.year - self.started.year) * 12 + on.month - self.started.month
                   - (1 if on.day < self.started.day else 0))


def pick(rng: random.Random, weighted):
    r = rng.random() * sum(wt for _, wt in weighted)
    for value, wt in weighted:
        r -= wt
        if r <= 0:
            return value
    return weighted[-1][0]


def months_before(d: date, months: int) -> date:
    y, m = divmod(d.year * 12 + d.month - 1 - months, 12)
    return date(y, m + 1, min(d.day, 28))


class Sim:
    def __init__(self, seed: int, world: World | None = None):
        self.w = world or World()
        self.rng = random.Random(seed)
        self.ids = Ids(self.rng)
        self.n_customers = 0
        self.n_tickets = 0
        self.reps = [{"id": f"zd_{team.lower()}{i:02d}", "name": f"{self.rng.choice(FIRST)} {self.rng.choice(LAST)}",
                      "group": f"Team {team}", "team": team}
                     for team in ("A", "B") for i in range(1, self.w.N_REPS_PER_TEAM + 1)]

    # ------------------------------------------------------------ helpers
    def at(self, d: date, lo_h: float = 8, hi_h: float = 20) -> datetime:
        return wm.dt(d, self.rng.uniform(lo_h, hi_h))

    def later(self, t: datetime, lo: float, hi: float, unit: str = "days") -> datetime:
        return t + timedelta(**{unit: self.rng.uniform(lo, hi)})

    def customer(self, started: date, plan: str | None = None, name: str | None = None) -> Customer:
        self.n_customers += 1
        first, last = (name.split() if name else (self.rng.choice(FIRST), self.rng.choice(LAST)))
        stripe_customer_id, subscription_id = self.ids.new("cus"), self.ids.new("sub")
        plan = plan or pick(self.rng, [(k, v[2]) for k, v in self.w.PLANS.items()])
        return Customer(
            key=f"cust{self.n_customers:06d}", name=f"{first} {last}",
            email=f"{first.lower()}.{last.lower()}{self.n_customers}@example.com",
            stripe_customer_id=stripe_customer_id, subscription_id=subscription_id,
            plan=plan, started=started, price=self.w.PLANS[plan][0], interval=self.w.PLANS[plan][1])

    def existing_customer(self, charge_day: date) -> Customer:
        lo, hi = pick(self.rng, self.w.TENURE_BUCKETS)
        return self.customer(months_before(charge_day, self.rng.randint(lo, hi)))

    def risk_profile(self, renewal: bool) -> int:
        if renewal:
            return int(min(99, max(1, self.rng.gauss(25, 15))))
        r = self.rng.random()
        if r < 0.70:
            return int(min(59, max(1, self.rng.gauss(35, 15))))
        if r < 0.90:
            return self.rng.randint(60, 75)
        return self.rng.randint(76, 99)

    # ------------------------------------------------------------ one case
    def case(self, c: Customer, charge_day: date, renewal: bool, loop: bool = False, force: dict | None = None):
        """Simulate one charge and everything that follows. Returns (events, record)."""
        force = force or {}
        rng, ids = self.rng, self.ids
        ev: list[dict] = []
        rec: dict = {"case_customer": c.key, "email": c.email, "plan": c.plan, "charge_day": charge_day.isoformat(),
                     "renewal": renewal, "loop": loop}

        charge_at = force.get("charge_at") or self.at(charge_day, 0, 23.9)
        charge_id = ids.new("ch")
        amount = c.price
        rec["charge_id"], rec["amount"] = charge_id, amount

        # 1. Charge screening (T5)
        score = force.get("risk_score", self.risk_profile(renewal))
        fraud = force.get("fraud", rng.random() < self.w.fraud_probability(score))
        decision = self.w.fraud_tool_decision(score)
        screen = {"is_renewal": renewal, "risk_score": score,
                  "country_match": (rng.random() < 0.5) if fraud else (rng.random() < 0.95),
                  "card_age_days": rng.randint(0, 10) if fraud else rng.randint(30, 2000),
                  "decision": decision}
        ev.append(f.charge_screened(ids, charge_at - timedelta(seconds=2), c, charge_id, amount, screen))
        rec["screen"] = {"risk_score": score, "decision": decision, "fraud": fraud}
        if decision == "decline":
            return ev, rec
        if decision == "review":
            if fraud and rng.random() < self.w.REVIEW_FRAUD_CATCH or rng.random() > self.w.REVIEW_APPROVE_RATE:
                rec["screen"]["review_result"] = "declined"
                return ev, rec
            rec["screen"]["review_result"] = "approved"
            charge_at = self.later(charge_at, 1, 6, "hours")
        ev.append(f.charge_succeeded(ids, charge_at, c, charge_id, amount))

        # Fraudulent charge that got through -> unauthorized dispute, no complaint
        if fraud:
            ev += self.dispute(c, rec, charge_id, amount, "unauthorized", self.later(charge_at, 10, 40),
                               prior_complaint=False, loop=loop, force=force)
            return ev, rec

        complaint_rate = self.w.COMPLAINT_RATE_RENEWAL if renewal else self.w.COMPLAINT_RATE_SIGNUP
        if force.get("no_complaint") or not (force.get("complaint") or rng.random() < complaint_rate):
            if not force.get("no_dispute") and rng.random() < self.w.FRIENDLY_DISPUTE_RATE:
                ev += self.dispute(c, rec, charge_id, amount, pick(rng, self.w.FRIENDLY_CATEGORY),
                                   self.later(charge_at, 5, 60), prior_complaint=False, loop=loop, force=force)
            else:
                ev += self.lifecycle(c, rec, charge_at, churn_prob=0.05)
            return ev, rec

        # 2. Complaint: AI proposes, human may override
        t = force.get("complaint_at") or self.later(charge_at, 3, 40)
        day = t.date()
        version = self.w.ai_version(day, loop)
        category = force.get("category") or pick(rng, self.w.COMPLAINT_CATEGORIES)
        channel = pick(rng, self.w.CHANNELS)
        tenure = c.tenure_months(day)
        long_tenure = tenure >= self.w.LONG_TENURE_MONTHS
        prior_refunds = pick(rng, [(0, 0.85), (1, 0.12), (2, 0.03)])
        rng.randint(100000, 999999)   # draw kept so seeded output stays comparable with earlier runs
        self.n_tickets += 1
        ticket_id = str(400000 + self.n_tickets)   # Zendesk ticket IDs are sequential
        session = ids.new("sess")

        ev.append(f.ticket_created(ids, t, c, ticket_id, charge_id, category, channel,
                                   rng.choice(COMPLAINT_TEXT[category])))
        t1 = self.later(t, 1, 5, "minutes")
        ev.append(f.tool_call(ids, t1, version, session, "get_customer", {"ticket_id": ticket_id}, {
            "customer_email": c.email, "tenure_months": tenure, "plan": c.plan,
            "prior_refunds_90d": prior_refunds, "subscription_status": "active",
            "charge_id": charge_id, "charge_amount_usd": amount}))

        ai_option = force.get("ai_option")
        if ai_option is None:
            if category == "too_expensive" and version != "v1" and day >= self.w.PAUSE_OPTION_FROM \
                    and rng.random() < self.w.AI_PAUSE_SHARE_TOO_EXPENSIVE:
                ai_option = "pause_subscription"
            else:
                deny_rate = self.w.AI_DENY_RATE[version] * (self.w.BILLING_ERROR_DENY_FACTOR if category == "billing_error" else 1)
                ai_option = "deny" if rng.random() < deny_rate else pick(rng, self.w.AI_NON_DENY_MIX[category])
        t2 = self.later(t1, 1, 4, "minutes")
        ev.append(f.tool_call(ids, t2, version, session, "propose_resolution", {
            "ticket_id": ticket_id, "option": ai_option, "amount_usd": self.option_amount(ai_option, amount),
            "rationale": RATIONALE[ai_option]}, {"status": "pending_review"}))

        reviewed = force.get("reviewed", rng.random() < self.w.HUMAN_REVIEW_RATE)
        if reviewed:
            rep = force.get("rep") or rng.choice(self.reps)
            final = ai_option
            if "final_option" in force:
                final = force["final_option"]
            elif ai_option == "deny":
                if rng.random() < self.w.HUMAN_OVERRIDE_DENY[(rep["team"], long_tenure)]:
                    final = "full_refund"
            elif ai_option != "pause_subscription" and rng.random() < self.w.HUMAN_RANDOM_OVERRIDE:
                final = rng.choice([o for o, _ in self.w.AI_NON_DENY_MIX[category] if o != ai_option] or ["full_refund"])
            t3 = self.later(t2, 1, 20, "hours")
            ev.append(f.macro_applied(ids, t3, ticket_id, MACRO[final], rep))
            actor_id, team = rep["id"], rep["team"]
        else:
            final, t3, actor_id, team = ai_option, t2 + timedelta(hours=24, minutes=rng.uniform(1, 30)), self.w.AGENT_ID, None
        refund = self.option_amount(final, amount) if final in ("full_refund", "partial_refund") else 0.0
        if refund:
            ev.append(f.refund_created(ids, t3 + timedelta(minutes=1), charge_id, refund, ticket_id, actor_id))
        if final == "pause_subscription":
            ev.append(f.subscription_event(ids, "paused", t3 + timedelta(minutes=2), c))
        ev.append(f.ticket_solved(ids, t3 + timedelta(minutes=3), ticket_id, actor_id))

        rec["complaint"] = {"ticket_id": ticket_id, "version": version, "category": category, "tenure": tenure,
                            "long_tenure": long_tenure, "ai_option": ai_option, "final_option": final,
                            "reviewed": reviewed, "team": team, "overridden": final != ai_option, "refund": refund,
                            "day": day.isoformat()}

        # Outcomes of the complaint decision (T1, T6)
        probs = self.w.COMPLAINT_OUTCOMES[final]
        if final == "deny" and category == "too_expensive":
            probs = self.w.TOO_EXPENSIVE_DENY
        dispute_p, churn_p = (probs[0], probs[2]) if long_tenure else (probs[1], probs[3])
        disputed = force.get("dispute", (not force.get("no_dispute")) and rng.random() < dispute_p)
        rec["complaint"]["disputed"] = disputed
        if disputed:
            dcat = force.get("dispute_category") or pick(rng, self.w.DISPUTE_CATEGORY_AFTER_COMPLAINT[category])
            dispute_amount = round(amount - (refund if final == "partial_refund" else 0), 2)
            ev += self.dispute(c, rec, charge_id, dispute_amount, dcat, force.get("dispute_at") or self.later(t3, 5, 60),
                               prior_complaint=True, loop=loop, force=force)
        else:
            ev += self.lifecycle(c, rec, t3, churn_prob=churn_p, force=force)
        return ev, rec

    def option_amount(self, option: str, amount: float) -> float:
        return {"full_refund": amount, "partial_refund": round(amount * self.w.PARTIAL_REFUND_SHARE, 2),
                "voucher": round(amount * 0.2, 2)}.get(option, 0.0)

    # ------------------------------------------------------------ disputes (T2, T3, T5)
    def dispute(self, c: Customer, rec: dict, charge_id: str, amount: float, category: str, t: datetime,
                prior_complaint: bool, loop: bool, force: dict) -> list[dict]:
        rng, ids = self.rng, self.ids
        ev = []
        dispute_id = ids.new("dp")
        ev.append(f.dispute_created(ids, t, dispute_id, charge_id, amount, category))

        version = self.w.ai_version(t.date(), loop)
        session = ids.new("sess")
        logs = force.get("usage_logs_available", rng.random() < self.w.USAGE_LOGS_AVAILABLE[category])
        available = ["tos_acceptance"]
        if logs:
            available.append("usage_logs")
        if rng.random() < self.w.CANCELLATION_EMAILS_AVAILABLE:
            available.append("cancellation_emails")
        if rng.random() < self.w.DELIVERY_CONFIRMATION_AVAILABLE:
            available.append("delivery_confirmation")
        tenure = c.tenure_months(t.date())

        t1 = self.later(t, 2, 48, "hours")
        ev.append(f.tool_call(ids, t1, version, session, "get_dispute_evidence", {"dispute_id": dispute_id}, {
            "dispute_id": dispute_id, "charge_id": charge_id, "category": category, "amount_usd": amount,
            "customer_email": c.email, "customer_tenure_months": tenure, "prior_complaint": prior_complaint,
            "available_evidence": available}))

        if "contest" in force:
            contest = force["contest"]
        elif category == "unauthorized":
            contest = rng.random() < self.w.AI_CONTEST_RATE_UNAUTHORIZED
        else:
            small, large = self.w.AI_CONTEST_RATE[version]
            contest = rng.random() < (small if amount <= 50 else large)
        evidence = []
        if contest:
            evidence = force.get("evidence") or [e for e in available if rng.random() < self.w.AI_EVIDENCE_RATE[version][e]]
            if not evidence:
                evidence = ["tos_acceptance"]
        t2 = self.later(t1, 1, 10, "minutes")
        ev.append(f.tool_call(ids, t2, version, session, "respond_to_dispute", {
            "dispute_id": dispute_id, "action": "contest" if contest else "accept", "evidence": evidence,
            "rationale": "Contest with available evidence." if contest else "Accept the dispute."},
            {"status": "submitted"}))

        with_logs = "usage_logs" in evidence
        won = force.get("won", contest and rng.random() < self.w.WIN_RATE[category][0 if with_logs else 1])
        closed_at = self.later(t2, 45, 75)
        ev.append(f.dispute_closed(ids, closed_at, dispute_id, charge_id, amount, category, "won" if won else "lost"))
        cost = self.w.DISPUTE_FEE + (0 if won else amount + (self.w.CONTEST_FEE if contest else 0))
        rec["dispute"] = {"dispute_id": dispute_id, "version": version, "category": category, "amount": amount,
                          "tenure": tenure, "prior_complaint": prior_complaint, "logs_available": logs,
                          "contest": contest, "evidence": evidence, "with_logs": with_logs, "won": won,
                          "cost": round(cost, 2), "day": t.date().isoformat()}

        churn = force.get("churn", rng.random() < self.w.CHURN_AFTER_DISPUTE)
        if churn:
            ev.append(f.subscription_event(ids, "canceled", self.later(t, 2, 20), c, reason="dispute"))
        rec["churn"] = churn
        return ev

    def lifecycle(self, c: Customer, rec: dict, t: datetime, churn_prob: float, force: dict | None = None) -> list[dict]:
        force = force or {}
        churn = force.get("churn", self.rng.random() < churn_prob)
        rec["churn"] = churn
        if churn:
            return [f.subscription_event(self.ids, "canceled", self.later(t, 10, 45), c, reason="customer_request")]
        if force.get("renew") or (c.monthly and self.rng.random() < self.w.MONTHLY_RENEWAL_IF_NO_CHURN):
            return [f.subscription_event(self.ids, "renewed", self.later(t, 25, 35), c)]
        return []


# ---------------------------------------------------------------- scenario builders
def random_day(rng: random.Random, start: date, end: date) -> date:
    return start + timedelta(days=rng.randint(0, (end - start).days))


def build_history(sim: Sim):
    events, records, customers = [], [], []
    rng = sim.rng

    def add(c: Customer, day: date, renewal: bool, force: dict | None = None, label: str | None = None):
        customers.append(c)
        events.append(f.subscription_created(sim.ids, wm.dt(c.started, 10), c))
        ev, rec = sim.case(c, day, renewal, force=force)
        if label:
            rec["label"] = label
        events.extend(ev)
        records.append(rec)
        return rec

    for _ in range(sim.w.N_EXISTING):
        day = random_day(rng, sim.w.HISTORY_START, sim.w.HISTORY_END)
        add(sim.existing_customer(day), day, renewal=True)
    for _ in range(sim.w.N_SIGNUPS):
        day = random_day(rng, sim.w.HISTORY_START, sim.w.HISTORY_END)
        add(sim.customer(day), day, renewal=False)

    # Hero case: Dana (demo spec Section 4)
    dana = sim.customer(months_before(date(2026, 3, 3), 31), plan="annual_180", name="Dana Whitfield")
    dana_rep = next(r for r in sim.reps if r["team"] == "A")
    dana_rec = add(dana, date(2026, 3, 3), renewal=True, label="hero_dana", force={
        "charge_at": wm.dt(date(2026, 3, 3), 6.0), "risk_score": 18, "fraud": False, "complaint": True,
        "complaint_at": wm.dt(date(2026, 3, 23), 19.5), "category": "didnt_use", "ai_option": "deny",
        "reviewed": True, "rep": dana_rep, "final_option": "deny", "dispute": True,
        "dispute_category": "subscription_canceled", "dispute_at": wm.dt(date(2026, 4, 7), 11.0),
        "usage_logs_available": True, "contest": True, "evidence": ["tos_acceptance"], "won": False, "churn": True})

    # Live customers: present in history, no complaint or dispute yet
    live = {}
    sam = sim.customer(months_before(date(2026, 6, 20), 28), plan="annual_180", name="Sam Okafor")
    add(sam, date(2026, 6, 20), renewal=True, label="live_sam",
        force={"risk_score": 15, "fraud": False, "no_complaint": True, "no_dispute": True, "churn": False})
    live["sam"] = sam
    for key, plan, tenure, renewal, score in [("dispute_1", "annual_300", 40, True, 20),
                                               ("dispute_2", "monthly_15", 9, True, 30),
                                               ("dispute_3", "annual_480", 0, False, 68)]:
        c = sim.customer(months_before(date(2026, 6, 24), tenure), plan=plan)
        rec = add(c, date(2026, 6, 24), renewal=renewal, label=f"live_{key}",
                  force={"risk_score": score, "fraud": False, "no_complaint": True, "no_dispute": True, "churn": False})
        live[key] = (c, rec)
    return events, records, dana_rec, live


def build_loop(sim: Sim):
    events, records = [], []
    for _ in range(sim.w.N_LOOP_CASES):
        day = random_day(sim.rng, sim.w.LOOP_START, sim.w.LOOP_END)
        c = sim.existing_customer(day)
        events.append(f.subscription_created(sim.ids, wm.dt(c.started, 10), c))
        ev, rec = sim.case(c, day, renewal=True, loop=True)
        events.extend(ev)
        records.append(rec)
    outcome_types = {"charge.dispute.closed", "subscription.canceled", "subscription.renewed"}
    decisions = [e for e in events if e["event_type"] not in outcome_types]
    outcomes = [e for e in events if e["event_type"] in outcome_types]
    return decisions, outcomes, records


def live_cases(live: dict) -> dict:
    sam = live["sam"]
    disputes = []
    specs = {
        "dispute_1": ("subscription_canceled", ["tos_acceptance", "usage_logs", "cancellation_emails"],
                      "Customer says they canceled before renewal; usage logs show activity after renewal."),
        "dispute_2": ("not_recognized", ["tos_acceptance"], "Customer's bank reports they don't recognize the charge."),
        "dispute_3": ("unauthorized", ["tos_acceptance"],
                      "Cardholder reports the signup charge as unauthorized; charge approved at risk score 68."),
    }
    for key, (category, available, note) in specs.items():
        c, rec = live[key]
        disputes.append({"key": key, "customer": {"name": c.name, "email": c.email,
                                                  "stripe_customer_id": c.stripe_customer_id, "plan": c.plan},
                         "charge_id": rec["charge_id"], "amount_usd": rec["amount"], "category": category,
                         "risk_score": rec["screen"]["risk_score"], "available_evidence": available, "note": note})
    return {
        "sam": {"customer": {"name": sam.name, "email": sam.email, "stripe_customer_id": sam.stripe_customer_id,
                             "subscription_id": sam.subscription_id, "plan": sam.plan, "started": sam.started.isoformat()},
                "complaint_category": "didnt_use",
                "message": "Hi, I was charged $180 for my annual renewal but I haven't used Streamly at all this year. "
                           "Can I get a refund?"},
        "disputes": disputes,
    }


def write_jsonl(path, rows):
    with path.open("w") as fh:
        for row in rows:
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    sim = Sim(args.seed)
    history, history_records, dana, live = build_history(sim)
    loop_decisions, loop_outcomes, loop_records = build_loop(sim)

    order = lambda e: (e["occurred_at"], e["event_id"])  # noqa: E731
    history.sort(key=order)
    loop_decisions.sort(key=order)
    loop_outcomes.sort(key=order)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_jsonl(OUT_DIR / "history_events.jsonl", history)
    write_jsonl(OUT_DIR / "loop_decision_events.jsonl", loop_decisions)
    write_jsonl(OUT_DIR / "loop_outcome_events.jsonl", loop_outcomes)
    write_jsonl(OUT_DIR / "ground_truth_history.jsonl", history_records)
    write_jsonl(OUT_DIR / "ground_truth_loop.jsonl", loop_records)
    (OUT_DIR / "live_cases.json").write_text(json.dumps(live_cases(live), indent=2))

    by_type: dict[str, int] = {}
    for e in history:
        k = f"{e['source_system']}:{e['event_type']}"
        by_type[k] = by_type.get(k, 0) + 1
    manifest = {
        "seed": args.seed, "generated_at": datetime.now(wm.UTC).isoformat(timespec="seconds"),
        "history_events": len(history), "loop_decision_events": len(loop_decisions),
        "loop_outcome_events": len(loop_outcomes), "customers": sim.n_customers,
        "history_cases": len(history_records), "loop_cases": len(loop_records),
        "history_events_by_type": dict(sorted(by_type.items())),
        "hero_dana": {"email": dana["email"], "charge_id": dana["charge_id"]},
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({k: v for k, v in manifest.items() if k != "history_events_by_type"}, indent=2))
    for k, v in manifest["history_events_by_type"].items():
        print(f"  {k:<40} {v:>7}")


if __name__ == "__main__":
    main()
