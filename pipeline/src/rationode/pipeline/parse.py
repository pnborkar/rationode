"""Normalize raw events from each source system and extract correlation keys."""

from dataclasses import dataclass, field

STRIPE_CATEGORY = {"subscription_canceled": "subscription_canceled", "unrecognized": "not_recognized",
                   "fraudulent": "unauthorized", "duplicate": "duplicate_charge"}

MACRO_OPTION = {"Refund: full": "full_refund", "Refund: partial (50%)": "partial_refund",
                "Voucher: 20% credit": "voucher", "Deny refund": "deny", "Pause subscription": "pause_subscription"}


@dataclass
class Ev:
    event_id: str
    source: str
    type: str
    at: str
    payload: dict
    raw: dict
    charge_id: str | None = None
    ticket_id: str | None = None
    dispute_id: str | None = None
    session_id: str | None = None
    stripe_customer_id: str | None = None
    email: str | None = None
    subscription_id: str | None = None
    tool: str | None = None
    data: dict = field(default_factory=dict)   # normalized fields used by detection

    @property
    def kind(self) -> str:
        return f"{self.source}:{self.tool or self.type}"


def parse(raw: dict) -> Ev:
    p = raw["payload"]
    e = Ev(raw["event_id"], raw["source_system"], raw["event_type"], raw["occurred_at"], p, raw)
    src, typ = e.source, e.type

    if src == "fraudguard":
        e.charge_id, e.email = p["charge_ref"], p["customer_email"]
        e.data = {k: p[k] for k in ("risk_score", "plan", "is_renewal", "country_match", "card_age_days",
                                    "decision", "amount", "rule_id")}
    elif src == "stripe":
        o = p["data"]["object"]
        if typ == "charge.succeeded":
            e.charge_id, e.stripe_customer_id = o["id"], o["customer"]
            e.email = o["billing_details"]["email"]
            e.data = {"amount": o["amount"] / 100, "name": o["billing_details"]["name"], "plan": o["metadata"]["plan"]}
        elif typ == "refund.created":
            e.charge_id, e.ticket_id = o["charge"], o["metadata"].get("zendesk_ticket_id")
            e.data = {"amount": o["amount"] / 100, "initiated_by": o["metadata"].get("initiated_by")}
        elif typ.startswith("charge.dispute."):
            e.dispute_id, e.charge_id = o["id"], o["charge"]
            e.data = {"amount": o["amount"] / 100, "category": STRIPE_CATEGORY[o["reason"]], "status": o["status"]}
    elif src == "zendesk":
        if typ == "ticket.created":
            t = p["ticket"]
            e.ticket_id, e.email = str(t["id"]), t["requester"]["email"]
            fields = {f["id"]: f["value"] for f in t.get("custom_fields", [])}
            e.charge_id = fields.get("stripe_charge_id")
            e.data = {"category": t["tags"][0] if t["tags"] else None, "channel": t["via"]["channel"],
                      "subject": t["subject"], "name": t["requester"]["name"]}
        elif typ == "macro.applied":
            e.ticket_id = str(p["ticket_id"])
            e.data = {"option": MACRO_OPTION.get(p["macro"]["title"]), "macro": p["macro"]["title"],
                      "actor_id": p["actor"]["id"], "actor_name": p["actor"]["name"], "group": p["actor"]["group"]}
        elif typ == "ticket.updated":
            e.ticket_id = str(p["ticket_id"])
            e.data = {"status": p["changes"].get("status", {}).get("to"), "actor_id": p["actor"]["id"]}
    elif src == "mcp_gateway":
        e.session_id, e.tool = p["session_id"], p["tool"]
        args, result = p["arguments"], p["result"]
        e.ticket_id = str(args["ticket_id"]) if "ticket_id" in args else None
        e.dispute_id = args.get("dispute_id")
        e.charge_id = result.get("charge_id")
        e.email = result.get("customer_email")
        e.data = {"agent_id": p["agent_id"], "agent_version": p["agent_version"], "args": args, "result": result}
    elif src == "streamly_app":
        e.stripe_customer_id, e.email = p["stripe_customer_id"], p.get("email")
        e.data = {"week_start": p["week_start"], "hours_watched": p["hours_watched"], "titles_watched": p["titles_watched"]}
    elif src == "subscriptions":
        e.subscription_id, e.stripe_customer_id = p["subscription_id"], p["stripe_customer_id"]
        e.email = p.get("email")
        e.data = {"plan": p["plan"], "started_at": p.get("started_at"), "reason": p.get("reason")}
    return e
