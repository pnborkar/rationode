"""Builders for raw events in each source system's native shape.

Every event is wrapped in a common envelope:
    {event_id, source_system, event_type, occurred_at, payload}
`payload` mimics the real system (Stripe webhook event, Zendesk ticket event,
MCP gateway tool-call log, fraud-tool screening record, subscription event).
"""

import zlib
from datetime import datetime


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def envelope(event_id: str, source: str, event_type: str, at: datetime, payload: dict) -> dict:
    return {"event_id": event_id, "source_system": source, "event_type": event_type,
            "occurred_at": iso(at), "payload": payload}


def cents(usd: float) -> int:
    return int(round(usd * 100))


# ---------------------------------------------------------------- subscription system
def subscription_created(ids, at: datetime, c) -> dict:
    return envelope(ids.new("subevt"), "subscriptions", "subscription.created", at, {
        "subscription_id": c.subscription_id, "stripe_customer_id": c.stripe_customer_id,
        "email": c.email, "plan": c.plan, "started_at": iso(at),
    })


def subscription_event(ids, kind: str, at: datetime, c, reason: str | None = None) -> dict:
    payload = {"subscription_id": c.subscription_id, "stripe_customer_id": c.stripe_customer_id,
               "plan": c.plan, "at": iso(at)}
    if reason:
        payload["reason"] = reason
    return envelope(ids.new("subevt"), "subscriptions", f"subscription.{kind}", at, payload)


# ---------------------------------------------------------------- fraud tool
def charge_screened(ids, at: datetime, c, charge_id: str, amount: float, s) -> dict:
    return envelope(ids.new("scr"), "fraudguard", "charge.screened", at, {
        "screening_id": ids.new("scr"), "charge_ref": charge_id, "customer_email": c.email,
        "amount": amount, "currency": "usd", "plan": c.plan, "is_renewal": s["is_renewal"],
        "risk_score": s["risk_score"], "country_match": s["country_match"],
        "card_age_days": s["card_age_days"], "decision": s["decision"],
        "rule_id": {"approve": "R-APPROVE-LE75", "review": "R-REVIEW-76-90", "decline": "R-DECLINE-GT90"}[s["decision"]],
        "screened_at": iso(at),
    })


# ---------------------------------------------------------------- stripe
def stripe_event(ids, event_type: str, at: datetime, obj: dict) -> dict:
    evt_id = ids.new("evt")
    return envelope(evt_id, "stripe", event_type, at, {
        "id": evt_id, "object": "event", "api_version": "2026-06-30", "type": event_type,
        "created": int(at.timestamp()), "livemode": False, "data": {"object": obj},
    })


def charge_succeeded(ids, at, c, charge_id: str, amount: float) -> dict:
    return stripe_event(ids, "charge.succeeded", at, {
        "id": charge_id, "object": "charge", "amount": cents(amount), "currency": "usd",
        "customer": c.stripe_customer_id, "billing_details": {"email": c.email, "name": c.name},
        "metadata": {"plan": c.plan, "subscription_id": c.subscription_id},
        "status": "succeeded", "created": int(at.timestamp()),
    })


def refund_created(ids, at, charge_id: str, amount: float, ticket_id: str, initiated_by: str) -> dict:
    return stripe_event(ids, "refund.created", at, {
        "id": ids.new("re"), "object": "refund", "amount": cents(amount), "currency": "usd",
        "charge": charge_id, "status": "succeeded",
        "metadata": {"zendesk_ticket_id": ticket_id, "initiated_by": initiated_by},
        "created": int(at.timestamp()),
    })


STRIPE_REASON = {"subscription_canceled": "subscription_canceled", "not_recognized": "unrecognized",
                 "unauthorized": "fraudulent", "duplicate_charge": "duplicate"}


def dispute_created(ids, at, dispute_id: str, charge_id: str, amount: float, category: str) -> dict:
    return stripe_event(ids, "charge.dispute.created", at, {
        "id": dispute_id, "object": "dispute", "amount": cents(amount), "currency": "usd",
        "charge": charge_id, "reason": STRIPE_REASON[category], "status": "needs_response",
        "balance_transactions": [{"type": "adjustment", "fee": cents(15.0), "description": "Dispute fee"}],
        "created": int(at.timestamp()),
    })


def dispute_closed(ids, at, dispute_id: str, charge_id: str, amount: float, category: str, status: str) -> dict:
    return stripe_event(ids, "charge.dispute.closed", at, {
        "id": dispute_id, "object": "dispute", "amount": cents(amount), "currency": "usd",
        "charge": charge_id, "reason": STRIPE_REASON[category], "status": status,
        "created": int(at.timestamp()),
    })


# ---------------------------------------------------------------- zendesk
def ticket_created(ids, at, c, ticket_id: str, charge_id: str, category: str, channel: str, text: str) -> dict:
    return envelope(ids.new("zdevt"), "zendesk", "ticket.created", at, {
        "type": "ticket.created",
        "ticket": {
            "id": ticket_id, "subject": text.split(".")[0][:60], "description": text,
            "requester": {"email": c.email, "name": c.name},
            "via": {"channel": channel}, "tags": [category], "status": "new",
            "custom_fields": [{"id": "stripe_charge_id", "value": charge_id}],
            "created_at": iso(at),
        },
    })


def macro_applied(ids, at, ticket_id: str, macro_title: str, rep) -> dict:
    return envelope(ids.new("zdevt"), "zendesk", "macro.applied", at, {
        "type": "macro.applied", "ticket_id": ticket_id,
        "macro": {"id": zlib.crc32(macro_title.encode()) % 100000, "title": macro_title},
        "actor": {"id": rep["id"], "name": rep["name"], "group": rep["group"], "role": "agent"},
        "applied_at": iso(at),
    })


def ticket_solved(ids, at, ticket_id: str, actor_id: str) -> dict:
    return envelope(ids.new("zdevt"), "zendesk", "ticket.updated", at, {
        "type": "ticket.updated", "ticket_id": ticket_id,
        "changes": {"status": {"from": "open", "to": "solved"}},
        "actor": {"id": actor_id}, "updated_at": iso(at),
    })


# ---------------------------------------------------------------- MCP gateway (AI agent tool calls)
def tool_call(ids, at, version: str, session_id: str, tool: str, arguments: dict, result: dict) -> dict:
    call_id = ids.new("call")
    return envelope(call_id, "mcp_gateway", "tool_call", at, {
        "call_id": call_id, "session_id": session_id, "agent_id": "streamly-support-agent",
        "agent_version": version, "server": "streamly-ops", "tool": tool,
        "arguments": arguments, "result": result, "called_at": iso(at),
    })


# ---------------------------------------------------------------- Streamly app (viewing activity)
def playback_weekly(ids, at, c, week_start: str, hours: float, titles: int) -> dict:
    return envelope(ids.new("pb"), "streamly_app", "playback.weekly_summary", at, {
        "stripe_customer_id": c.stripe_customer_id, "email": c.email, "week_start": week_start,
        "hours_watched": hours, "titles_watched": titles, "sessions": max(0, round(hours / 1.4)),
    })
