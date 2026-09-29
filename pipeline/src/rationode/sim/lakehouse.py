"""Lakehouse dataset for the Databricks cold-start test (demo spec §21).

A fresh company history with the same world model: about 5,000 customers over January-June 2026
(3,850 renewals, 1,150 signups), with identity signals on every screening (small fraud crews,
isolated fraud accounts, households) and weekly usage around each case. Written as the tables a
lakehouse would hold, each with its own column names (the same shapes as the sample exports),
ready to go to Databricks. Emails, ticket IDs and fraud crews are clear of the demo's.

Usage:
    uv run python -m rationode.sim.lakehouse          # -> data/generated/lakehouse/
"""

import json
import random
from datetime import timedelta

from rationode.db import REPO_ROOT
from rationode.sim import formats as f
from rationode.sim import identifiers
from rationode.sim import world as wm
from rationode.sim.generate import Sim, random_day
from rationode.sim.stories import usage_events
from rationode.sim.uploads import export
from rationode.sim.world import World

OUT_DIR = REPO_ROOT / "data" / "generated" / "lakehouse"
SEED = 7070
N_EXISTING, N_SIGNUPS = 3_850, 1_150
CREW_OFFSET = 1_000        # this company's fraud crews are its own (not the demo's)
N_HOUSEHOLDS = 12


def build(seed: int = SEED) -> list[dict]:
    w = World(N_EXISTING=N_EXISTING, N_SIGNUPS=N_SIGNUPS)
    sim = Sim(seed=seed, world=w)
    sim.n_customers = 300_000   # emails and ticket IDs clear of the demo's
    sim.n_tickets = 800_000
    rng = sim.rng
    cases = []   # (customer, case events, record, charge day)
    for renewal, n in ((True, w.N_EXISTING), (False, w.N_SIGNUPS)):
        for _ in range(n):
            day = random_day(rng, w.HISTORY_START, w.HISTORY_END)
            c = sim.existing_customer(day) if renewal else sim.customer(day)
            ev, rec = sim.case(c, day, renewal)
            cases.append((c, ev, rec, day))

    # Identity: fraud cases in crews of 2-5 (60%) or isolated; a few households share a device.
    irng = random.Random(seed + 1)
    fraud_ids = sorted(rec["charge_id"] for _, _, rec, _ in cases if rec["screen"]["fraud"])
    irng.shuffle(fraud_ids)
    crew_of, i, k = {}, 0, CREW_OFFSET
    while i < int(len(fraud_ids) * identifiers.CREW_SHARE):
        size = irng.randint(2, 5)
        for cid in fraud_ids[i:i + size]:
            crew_of[cid] = k
        i, k = i + size, k + 1
    clean = sorted({c.email for c, _, rec, _ in cases if not rec["screen"]["fraud"] and "dispute" not in rec})
    irng.shuffle(clean)
    shared_device = {b: identifiers.home(a)["device_id"]
                     for a, b in zip(clean[0:2 * N_HOUSEHOLDS:2], clean[1:2 * N_HOUSEHOLDS:2])}

    events = []
    for c, ev, rec, day in cases:
        for e in ev:
            if e["event_type"] == "charge.screened":
                p = e["payload"]
                p |= identifiers.fraud(p["charge_ref"], p["country_match"], crew_of.get(p["charge_ref"])) \
                    if rec["screen"]["fraud"] else identifiers.legit(p["customer_email"], p["country_match"],
                                                                     shared_device.get(p["customer_email"]))
        events.append(f.subscription_created(sim.ids, wm.dt(c.started, 10), c))
        events += ev
        # Weekly usage around the charge: none for "didn't use" complaints, otherwise a few hours a week.
        didnt_use = rec.get("complaint", {}).get("category") == "didnt_use"
        monday = day - timedelta(days=day.weekday())
        base = 0 if didnt_use else rng.uniform(1.5, 8)
        weeks = [(monday + timedelta(weeks=k), round(max(0.0, base + rng.uniform(-1.5, 1.5)), 1) if base else 0.0)
                 for k in range(-3, 3)]
        events += usage_events(sim, c, weeks)
    events.sort(key=lambda e: (e["occurred_at"], e["event_id"]))
    print(f"{len(cases)} customers · {len(fraud_ids)} fraud charges ({len(crew_of)} in {k - CREW_OFFSET} crews) · "
          f"{len(shared_device)} households")
    return events


def main() -> None:
    events = build()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "raw_events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    counts = export(events, OUT_DIR)
    print(f"{len(events)} raw events -> {OUT_DIR.relative_to(REPO_ROOT)}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
