"""Sample exports for "Connect a source" (demo spec §16.2).

A batch of new Streamly customers (spring 2026 cases), generated with the world model and
written as the files a merchant would actually export, each with its own column names:
Zendesk ticket events (CSV), Stripe activity (CSV), the support agent's tool-call log (JSONL),
FraudGuard screening (CSV), subscriptions (CSV), and Streamly app weekly usage (CSV).
Nothing here is pre-labelled: decisions and outcomes are found by the mapping + detector.

The same batch's raw events go to data/generated/sample_upload_raw.jsonl so the mapping path
can be checked against the native adapter (web/scripts/mapping-check.mjs).

Usage:
    uv run python -m rationode.sim.uploads
"""

import csv
import io
import json
from datetime import date, datetime, timedelta

from rationode.db import REPO_ROOT
from rationode.sim import formats as f
from rationode.sim import identifiers
from rationode.sim import world as wm
from rationode.sim.generate import Sim, random_day
from rationode.sim.stories import usage_events

OUT_DIR = REPO_ROOT / "web" / "public" / "samples" / "streamly-spring"
RAW_OUT = REPO_ROOT / "data" / "generated" / "sample_upload_raw.jsonl"

# What each customer's case is forced to be (the world model decides everything else).
MIX = [{"complaint": True}] * 10 + [{"no_complaint": True, "friendly_dispute": True}] * 3 \
    + [{"risk_score": 66, "fraud": True}] + [{"no_complaint": True, "no_dispute": True, "renew": True}] * 2


def build(seed: int = 3000) -> list[dict]:
    sim = Sim(seed=seed)
    sim.n_customers = 90000   # emails and ticket IDs clear of the history's
    sim.n_tickets = 200000
    events: list[dict] = []
    for i, force in enumerate(MIX):
        day = random_day(sim.rng, date(2026, 3, 2), date(2026, 4, 20))
        renewal = "fraud" not in force
        c = sim.existing_customer(day) if renewal else sim.customer(day)
        case, rec = sim.case(c, day, renewal=renewal, force=dict(force))
        identifiers.add_to_screening(case, rec, identifiers.CREW_FOR_UPLOADS)
        events.append(f.subscription_created(sim.ids, wm.dt(c.started, 10), c))
        events += case
        didnt_use = rec.get("complaint", {}).get("category") == "didnt_use"
        monday = day - timedelta(days=day.weekday())
        weeks = [monday + timedelta(weeks=k) for k in range(-4, 2)]
        base = 0 if didnt_use else sim.rng.uniform(2, 8)
        events += usage_events(sim, c, [(w, round(max(0.0, base + sim.rng.uniform(-1.5, 1.5)) if base else 0.0, 1))
                                        for w in weeks])
    events.sort(key=lambda e: (e["occurred_at"], e["event_id"]))
    return events


def ts(iso: str) -> str:
    return iso.replace("T", " ").removesuffix("Z")   # "2026-03-14 10:22:05" (UTC, per the column name)


def write_csv(name: str, columns: list[str], rows: list[dict], out_dir=OUT_DIR) -> None:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=columns, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow({k: ("" if r.get(k) is None else r[k]) for k in columns})
    (out_dir / name).write_text(buf.getvalue())


def yn(b: bool) -> str:
    return "Y" if b else "N"


def export(events: list[dict], out_dir=OUT_DIR) -> dict[str, int]:
    zd, stripe, calls, fraud, subs, usage = [], [], [], [], [], []
    for e in events:
        p, at = e["payload"], e["occurred_at"]
        src, typ = e["source_system"], e["event_type"]
        if src == "zendesk":
            row = {"Audit ID": e["event_id"], "Timestamp (UTC)": ts(at)}
            if typ == "ticket.created":
                t = p["ticket"]
                fields = {x["id"]: x["value"] for x in t["custom_fields"]}
                row |= {"Ticket ID": t["id"], "Event Type": "Create", "Requester Email": t["requester"]["email"],
                        "Requester Name": t["requester"]["name"], "Subject": t["subject"], "Tags": " ".join(t["tags"]),
                        "Channel": t["via"]["channel"], "Stripe Charge ID": fields.get("stripe_charge_id")}
            elif typ == "macro.applied":
                row |= {"Ticket ID": p["ticket_id"], "Event Type": "Macro applied", "Macro Title": p["macro"]["title"],
                        "Updater ID": p["actor"]["id"], "Updater Name": p["actor"]["name"], "Group": p["actor"]["group"]}
            else:
                row |= {"Ticket ID": p["ticket_id"], "Event Type": "Status change", "Updater ID": p["actor"]["id"],
                        "Status From": p["changes"]["status"]["from"], "Status To": p["changes"]["status"]["to"]}
            zd.append(row)
        elif src == "stripe":
            o = p["data"]["object"]
            row = {"Event ID": e["event_id"], "Created (UTC)": ts(at), "Amount": f"{o['amount'] / 100:.2f}",
                   "Currency": o["currency"]}
            if typ == "charge.succeeded":
                row |= {"Type": "charge", "id": o["id"], "Customer ID": o["customer"],
                        "Customer Email": o["billing_details"]["email"], "Customer Name": o["billing_details"]["name"],
                        "Plan (metadata)": o["metadata"]["plan"], "Status": o["status"]}
            elif typ == "refund.created":
                row |= {"Type": "refund", "id": o["id"], "Charge ID": o["charge"], "Status": o["status"],
                        "Zendesk Ticket (metadata)": o["metadata"]["zendesk_ticket_id"],
                        "Initiated By (metadata)": o["metadata"]["initiated_by"]}
            else:
                row |= {"Type": "dispute_opened" if typ.endswith("created") else "dispute_closed", "id": o["id"],
                        "Charge ID": o["charge"], "Dispute Reason": o["reason"], "Status": o["status"]}
            stripe.append(row)
        elif src == "mcp_gateway":
            calls.append({"call_id": p["call_id"], "conversation_id": p["session_id"], "timestamp": at,
                          "agent": {"id": p["agent_id"], "version": p["agent_version"]}, "tool_name": p["tool"],
                          "input": p["arguments"], "output": p["result"]})
        elif src == "fraudguard":
            fraud.append({"screen_id": e["event_id"], "screened_at": at, "charge_reference": p["charge_ref"],
                          "email": p["customer_email"], "amount": p["amount"], "plan": p["plan"],
                          "renewal": yn(p["is_renewal"]), "risk_score": p["risk_score"],
                          "ip_country_match": yn(p["country_match"]), "card_age_days": p["card_age_days"],
                          "outcome": p["decision"].upper(), "rule": p["rule_id"],
                          "card_fingerprint": p["card_fingerprint"], "card_country": p["card_country"],
                          "device_id": p["device_id"], "ip_country": p["ip_country"]})
        elif src == "subscriptions":
            subs.append({"event_id": e["event_id"], "subscription_id": p["subscription_id"],
                         "customer_id": p["stripe_customer_id"], "customer_email": p.get("email"), "plan": p["plan"],
                         "event": typ.split(".")[1], "event_at": at, "started_at": p.get("started_at"),
                         "cancel_reason": p.get("reason")})
        elif src == "streamly_app":
            usage.append({"row_id": e["event_id"], "account_id": p["stripe_customer_id"], "account_email": p["email"],
                          "week_of": p["week_start"], "watch_hours": p["hours_watched"],
                          "titles": p["titles_watched"], "generated_at": at})

    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv("zendesk_ticket_events.csv", ["Ticket ID", "Audit ID", "Event Type", "Timestamp (UTC)", "Requester Email",
              "Requester Name", "Subject", "Tags", "Channel", "Stripe Charge ID", "Macro Title", "Updater ID",
              "Updater Name", "Group", "Status From", "Status To"], zd, out_dir)
    write_csv("stripe_activity.csv", ["Event ID", "Type", "id", "Created (UTC)", "Amount", "Currency", "Customer ID",
              "Customer Email", "Customer Name", "Charge ID", "Dispute Reason", "Status", "Plan (metadata)",
              "Zendesk Ticket (metadata)", "Initiated By (metadata)"], stripe, out_dir)
    (out_dir / "support_agent_tool_calls.jsonl").write_text("".join(json.dumps(c) + "\n" for c in calls))
    write_csv("fraudguard_screening.csv", ["screen_id", "screened_at", "charge_reference", "email", "amount", "plan",
              "renewal", "risk_score", "ip_country_match", "card_age_days", "outcome", "rule", "card_fingerprint",
              "card_country", "device_id", "ip_country"], fraud, out_dir)
    write_csv("subscriptions.csv", ["event_id", "subscription_id", "customer_id", "customer_email", "plan", "event",
              "event_at", "started_at", "cancel_reason"], subs, out_dir)
    write_csv("app_usage_weekly.csv", ["row_id", "account_id", "account_email", "week_of", "watch_hours", "titles",
              "generated_at"], usage, out_dir)
    return {"zendesk": len(zd), "stripe": len(stripe), "tool calls": len(calls), "fraud": len(fraud),
            "subscriptions": len(subs), "usage": len(usage)}


def main() -> None:
    events = build()
    RAW_OUT.parent.mkdir(parents=True, exist_ok=True)
    RAW_OUT.write_text("".join(json.dumps(e) + "\n" for e in events))
    counts = export(events)
    print(f"{len(events)} raw events -> {OUT_DIR.relative_to(REPO_ROOT)}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
