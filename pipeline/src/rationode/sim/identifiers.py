"""Identity signals behind each charge: card and device (demo spec §17).

What a fraud tool records when it screens a charge: the card's fingerprint and country, the
device of the account's latest app login, and the IP country. Consistent with the screening's
own card_age_days and country_match. Generated with its own seeds, so nothing the main simulator
draws changes.

Planted patterns (kept small; no big ring):
- fraud accounts mostly come in crews of 2-5 sharing one or two devices; a few stolen cards are
  used on two accounts; the rest of the fraud accounts are isolated (no shared identifiers);
- households: pairs of legitimate, undisputed accounts sharing one device (a false positive);
- crews persist: fraud accounts arriving later (sets, uploads) can reuse a crew's device.

History enrichment (additive; no existing event, decision, tree, or live case changes):
    uv run python -m rationode.sim.identifiers            # writes FraudGuard charge.signals events
"""

import json
import random
import string

from rationode.db import REPO_ROOT, database, driver

SEED = 4242
GENERATED = REPO_ROOT / "data" / "generated"
OUT = GENERATED / "identifiers_history.jsonl"
HOME = [("US", 0.82), ("CA", 0.10), ("GB", 0.08)]
ELSEWHERE = ["DE", "BR", "IN", "NL", "FR", "ES", "MX", "PL", "PT", "IT"]
CREW_SHARE = 0.6          # share of fraud accounts that belong to a crew
SHARED_CARD_RATE = 0.15   # a crew account paying with the crew's stolen card also used elsewhere
N_HOUSEHOLDS = 60

# Crews reserved for fraud accounts that arrive after the history (sets, sample uploads).
CREW_FOR_SETS, CREW_FOR_UPLOADS = 1, 0


def _rng(*parts) -> random.Random:
    return random.Random(":".join(str(p) for p in (SEED, *parts)))


def _pick(rng: random.Random, weighted):
    x, acc = rng.random(), 0.0
    for value, w in weighted:
        acc += w
        if x < acc:
            return value
    return weighted[-1][0]


def fingerprint(rng: random.Random) -> str:
    return "".join(rng.choices(string.ascii_letters + string.digits, k=16))


def device(rng: random.Random) -> str:
    return "dev_" + "".join(rng.choices("0123456789abcdef", k=12))


def home(email: str) -> dict:
    """A legitimate customer's own card and device."""
    r = _rng("home", email)
    country = _pick(r, HOME)
    return {"card_fingerprint": fingerprint(r), "card_country": country, "device_id": device(r), "ip_country": country}


def crew(index: int) -> dict:
    r = _rng("crew", index)
    return {"devices": [device(r) for _ in range(r.choice([1, 1, 2]))], "ip_country": r.choice(ELSEWHERE),
            "shared_card": fingerprint(r)}


def legit(email: str, country_match: bool, device_override: str | None = None) -> dict:
    s = home(email)
    if device_override:
        s["device_id"] = device_override
    if not country_match:   # travelling: logged in from elsewhere
        s["ip_country"] = _rng("travel", email).choice([c for c in ELSEWHERE if c != s["card_country"]])
    return s


def fraud(charge_id: str, country_match: bool, crew_index: int | None) -> dict:
    """A stolen card (the victim's country), on a crew's device or the fraudster's own."""
    r = _rng("fraud", charge_id)
    card_country = _pick(r, HOME)
    if crew_index is None:
        dev, away = device(r), r.choice(ELSEWHERE)
        card = fingerprint(r)
    else:
        c = crew(crew_index)
        dev, away = r.choice(c["devices"]), c["ip_country"]
        card = c["shared_card"] if r.random() < SHARED_CARD_RATE else fingerprint(r)
    return {"card_fingerprint": card, "card_country": card_country, "device_id": dev,
            "ip_country": card_country if country_match else away}


def add_to_screening(events: list[dict], rec: dict, crew_index: int) -> None:
    """Put the identity signals on a case's screening record (sets, sample uploads): fraud cases use the crew."""
    for e in events:
        if e["event_type"] == "charge.screened":
            p = e["payload"]
            p |= fraud(p["charge_ref"], p["country_match"], crew_index) if rec["screen"]["fraud"] \
                else legit(p["customer_email"], p["country_match"])


# ---------------------------------------------------------------- history enrichment
def history_signals() -> list[dict]:
    truth = {}
    for line in open(GENERATED / "ground_truth_history.jsonl"):
        r = json.loads(line)
        truth[r["charge_id"]] = r
    screens, cus_by_email = [], {}
    for line in open(GENERATED / "history_events.jsonl"):
        e = json.loads(line)
        if e["event_type"] == "charge.screened":
            screens.append(e)
        elif e["event_type"] == "subscription.created":
            cus_by_email[e["payload"]["email"]] = e["payload"]["stripe_customer_id"]

    # Crews: fraud charges in a fixed order, 60% chunked into crews of 2-5, the rest isolated.
    rng = _rng("history")
    fraud_ids = sorted(cid for cid, r in truth.items() if r["screen"]["fraud"])
    rng.shuffle(fraud_ids)
    n_crewed = int(len(fraud_ids) * CREW_SHARE)
    crew_of, i, k = {}, 0, 0
    while i < n_crewed:
        size = rng.randint(2, 5)
        for cid in fraud_ids[i:i + size]:
            crew_of[cid] = k
        i, k = i + size, k + 1

    # Households: pairs of legitimate accounts with no dispute; the second uses the first's device.
    clean = sorted(r["email"] for r in truth.values() if not r["screen"]["fraud"] and "dispute" not in r
                   and r["email"] in cus_by_email)
    clean = sorted(set(clean))
    rng.shuffle(clean)
    shared_device = {}
    for a, b in zip(clean[0:2 * N_HOUSEHOLDS:2], clean[1:2 * N_HOUSEHOLDS:2]):
        shared_device[b] = home(a)["device_id"]

    events = []
    for e in screens:
        p = e["payload"]
        cid, email = p["charge_ref"], p["customer_email"]
        is_fraud = truth[cid]["screen"]["fraud"] if cid in truth else False
        s = fraud(cid, p["country_match"], crew_of.get(cid)) if is_fraud \
            else legit(email, p["country_match"], shared_device.get(email))
        events.append({
            "event_id": f"sig_{cid.removeprefix('ch_')}", "source_system": "fraudguard", "event_type": "charge.signals",
            "occurred_at": e["occurred_at"],
            "payload": {"signal_id": f"sig_{cid.removeprefix('ch_')}", "charge_ref": cid, "customer_email": email,
                        "stripe_customer_id": cus_by_email.get(email), **s},
        })
    print(f"{len(events)} charge signals · {len(fraud_ids)} fraud charges: {n_crewed} in {k} crews, "
          f"{len(fraud_ids) - n_crewed} isolated · {len(shared_device)} households")
    return events


def main() -> None:
    from rationode.pipeline.detect import Detector
    from rationode.pipeline.write import load_registry, write

    events = history_signals()
    OUT.write_text("".join(json.dumps(e) + "\n" for e in events))
    with driver() as d:
        db = database()
        rows = Detector(load_registry(d, db), "history").run(events)
        assert not rows.decisions and not rows.outcomes, "identity signals must not create decisions or outcomes"
        print(f"rows: {len(rows.entities)} cards/devices, {len(rows.links)} links, review {len(rows.review)}")
        write(d, db, rows)


if __name__ == "__main__":
    main()
