"""Weekly viewing (Streamly app) for the live-tab customers, written through the pipeline.

Usage is scoped to the live customers and the Events-tab sets; the rest of the history
has none ("no usage data"). Adds raw events only: no decisions, trees, or statistics change.
Deterministic event IDs, so re-running is harmless.

Usage:
    uv run python -m rationode.sim.usage
"""

import json
import random
from datetime import date
from types import SimpleNamespace

from rationode.db import database, driver
from rationode.pipeline.detect import Detector
from rationode.pipeline.write import load_registry, write
from rationode.sim.generate import Ids
from rationode.sim.stories import usage_events

WEEKS = [date(2026, 5, 18), date(2026, 5, 25), date(2026, 6, 1), date(2026, 6, 8), date(2026, 6, 15), date(2026, 6, 22)]

# email -> hours per week, chosen to fit each live customer's message
PROFILES = {
    "sam.okafor26002@example.com": [0, 0, 0, 0, 0, 0],             # "haven't used Streamly at all this year"
    "jordan.rossi650@example.com": [4.0, 3.5, 0, 0, 0, 0],         # "didn't watch anything this month" (June)
    "amara.rossi165@example.com": [5.0, 6.5, 4.0, 5.5, 6.0, 4.5],  # "too expensive" (but watching)
    "jamie.kowalski100@example.com": [3.0, 2.5, 3.5, 2.0, 3.0, 2.5],  # "charged twice"
}


def main() -> None:
    ids = Ids(random.Random(2026))
    with driver() as d:
        db = database()
        events = []
        for email, hours in PROFILES.items():
            r = d.execute_query(
                "MATCH (c:Customer:Entity {source_system: 'stripe', email: $email, scenario_id: 'history'}) "
                "MATCH (s:Event {event_type: 'subscription.created', stripe_customer_id: c.source_key}) "
                "RETURN c.source_key AS cus, s.payload_json AS sub", email=email, database_=db).records[0]
            started = date.fromisoformat(json.loads(r["sub"])["started_at"][:10])
            c = SimpleNamespace(stripe_customer_id=r["cus"], email=email, started=started)
            sim = SimpleNamespace(ids=ids)
            events += usage_events(sim, c, list(zip(WEEKS, hours)))
        rows = Detector(load_registry(d, db), "history").run(events)
        assert not rows.decisions and not rows.outcomes, "usage events must not create decisions or outcomes"
        write(d, db, rows, log=lambda _: None)
        print(f"wrote {len(rows.events)} usage events for {len(PROFILES)} live customers")


if __name__ == "__main__":
    main()
