"""Analytics CLI.

    uv run python -m rationode.analytics embed [--all]      # context embeddings -> vector index
    uv run python -m rationode.analytics gds                # kNN, Leiden, rep peer groups (Aura Graph Analytics)
    uv run python -m rationode.analytics precedent sam      # check_before_act on a live case
"""

import argparse
import json

from rationode.db import database, driver

LIVE_CASES = {
    "sam": ("support.complaint_resolution",
            {"support.tenure_months": 28, "support.plan": "annual_180", "support.amount_usd": 180.0,
             "support.complaint_category": "didnt_use", "support.prior_refunds_90d": 0, "support.channel": "chat"}),
    "dispute_1": ("dispute.evidence",
                  {"dispute.amount_usd": 300.0, "dispute.category": "subscription_canceled", "dispute.tenure_months": 40,
                   "dispute.prior_complaint": False, "dispute.usage_logs_available": True}),
    "dispute_2": ("dispute.response",
                  {"dispute.amount_usd": 15.0, "dispute.category": "not_recognized", "dispute.tenure_months": 9,
                   "dispute.prior_complaint": False, "dispute.usage_logs_available": False}),
    "dispute_3": ("dispute.response",
                  {"dispute.amount_usd": 480.0, "dispute.category": "unauthorized", "dispute.tenure_months": 0,
                   "dispute.prior_complaint": False, "dispute.usage_logs_available": False}),
}


def main() -> None:
    parser = argparse.ArgumentParser(prog="rationode.analytics")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("embed")
    p.add_argument("--all", action="store_true", help="re-embed every context")
    p.add_argument("--scenario", default="history")
    p = sub.add_parser("gds")
    p.add_argument("--scenario", default="history")
    p = sub.add_parser("precedent")
    p.add_argument("case", choices=sorted(LIVE_CASES))
    args = parser.parse_args()

    with driver() as d:
        db = database()
        if args.cmd == "embed":
            from rationode.analytics.embed import embed_contexts
            embed_contexts(d, db, args.scenario, args.all)
        elif args.cmd == "gds":
            from rationode.analytics import gds
            gds.run(d, db, args.scenario)
        else:
            from rationode.analytics.precedent import check_before_act
            decision_type, context = LIVE_CASES[args.case]
            print(json.dumps(check_before_act(d, db, decision_type, context), indent=2, default=str))


if __name__ == "__main__":
    main()
