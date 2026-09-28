"""Verify the planted truths from the simulator's own case records.

This checks the generated data is strong enough for the demo (clear effects,
enough decisions per branch) before anything goes into Neo4j. It reads the
ground-truth files, never Neo4j.

Usage:
    uv run python -m rationode.sim.verify
"""

import json
import math
import sys
from collections.abc import Callable, Iterable

from rationode.sim.generate import OUT_DIR

MIN_N = 100   # minimum decisions on a branch that carries a reveal


def load(name: str) -> list[dict]:
    with (OUT_DIR / name).open() as fh:
        return [json.loads(line) for line in fh]


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (centre - half, centre + half)


class Rate:
    def __init__(self, label: str, rows: Iterable[dict], hit: Callable[[dict], bool]):
        rows = list(rows)
        self.label, self.n, self.k = label, len(rows), sum(1 for r in rows if hit(r))
        self.p = self.k / self.n if self.n else 0.0
        self.lo, self.hi = wilson(self.k, self.n)

    def __str__(self) -> str:
        return f"{self.label:<52} {self.p:6.1%}  [{self.lo:5.1%}–{self.hi:5.1%}]  n={self.n}"


results: list[tuple[str, bool, str]] = []


def check(truth: str, ok: bool, note: str) -> None:
    results.append((truth, ok, note))


def separated(a: Rate, b: Rate) -> bool:
    return a.hi < b.lo or b.hi < a.lo


def big_enough(*rates: Rate) -> bool:
    return all(r.n >= MIN_N for r in rates)


def show(title: str, *rates: Rate) -> None:
    print(f"\n{title}")
    for r in rates:
        print(f"  {r}")


def main() -> None:
    hist = load("ground_truth_history.jsonl")
    loop = load("ground_truth_loop.jsonl")
    complaints = [r["complaint"] | {"churn": r.get("churn")} for r in hist if "complaint" in r]
    disputes = [r["dispute"] for r in hist if "dispute" in r]

    print(f"History cases {len(hist)}, complaints {len(complaints)}, disputes {len(disputes)}")

    # T1 tenure rule: within long tenure, final deny vs refund
    long_c = [c for c in complaints if c["long_tenure"]]
    deny = Rate("tenure>=24, final deny -> dispute", [c for c in long_c if c["final_option"] == "deny"], lambda c: c["disputed"])
    refund = Rate("tenure>=24, final full refund -> dispute", [c for c in long_c if c["final_option"] == "full_refund"], lambda c: c["disputed"])
    over_long = Rate("human overrides AI deny, tenure>=24",
                     [c for c in long_c if c["ai_option"] == "deny" and c["reviewed"]], lambda c: c["overridden"])
    over_short = Rate("human overrides AI deny, tenure<24",
                      [c for c in complaints if not c["long_tenure"] and c["ai_option"] == "deny" and c["reviewed"]],
                      lambda c: c["overridden"])
    show("T1 tenure rule", deny, refund, over_long, over_short)
    check("T1", separated(deny, refund) and deny.p > refund.p and big_enough(deny, refund) and over_long.p > over_short.p,
          f"deny {deny.p:.0%} vs refund {refund.p:.0%} dispute rate (long tenure)")

    # T2 evidence gap
    sc = [d for d in disputes if d["category"] == "subscription_canceled" and d["contest"]]
    with_logs = Rate("subscription_canceled contested WITH usage logs -> won", [d for d in sc if d["with_logs"]], lambda d: d["won"])
    without = Rate("subscription_canceled contested WITHOUT usage logs -> won", [d for d in sc if not d["with_logs"]], lambda d: d["won"])
    v2_include = Rate("AI v2 includes usage logs when available",
                      [d for d in sc if d["version"] == "v2" and d["logs_available"]], lambda d: d["with_logs"])
    show("T2 evidence gap", with_logs, without, v2_include)
    lost_without = sum(d["cost"] for d in sc if not d["with_logs"])
    print(f"  cost of contested subscription_canceled disputes without usage logs (6 months): ${lost_without:,.0f}")
    check("T2", separated(with_logs, without) and with_logs.p > without.p and big_enough(with_logs, without),
          f"with logs {with_logs.p:.0%} vs without {without.p:.0%} win rate")

    # T3 policy vs reality: small disputes
    small = [d for d in disputes if d["amount"] <= 50 and d["category"] != "unauthorized"]
    v1_contest = Rate("disputes <= $50, AI v1 contests", [d for d in small if d["version"] == "v1"], lambda d: d["contest"])
    v2_contest = Rate("disputes <= $50, AI v2 contests", [d for d in small if d["version"] == "v2"], lambda d: d["contest"])
    contested_small = [d for d in small if d["contest"]]
    accepted_small = [d for d in small if not d["contest"]]
    avg = lambda rows: sum(r["cost"] for r in rows) / len(rows) if rows else 0.0  # noqa: E731
    # Expected cost of accepting the same contested disputes instead: fee + amount
    accept_cost = sum(15 + d["amount"] for d in contested_small) / max(1, len(contested_small))
    show("T3 policy vs reality (policy: accept disputes <= $50)", v1_contest, v2_contest)
    print(f"  avg cost per contested small dispute ${avg(contested_small):.2f} vs if accepted ${accept_cost:.2f}"
          f" (n contested {len(contested_small)}, accepted {len(accepted_small)})")
    check("T3", v2_contest.p > 0.75 and avg(contested_small) > accept_cost and len(contested_small) >= MIN_N,
          f"v2 contests {v2_contest.p:.0%} of small disputes; contesting costs ${avg(contested_small) - accept_cost:.2f} more each")

    # T4 prompt drift
    v1_deny = Rate("AI v1 proposes deny", [c for c in complaints if c["version"] == "v1"], lambda c: c["ai_option"] == "deny")
    v2_deny = Rate("AI v2 proposes deny", [c for c in complaints if c["version"] == "v2"], lambda c: c["ai_option"] == "deny")
    show("T4 prompt drift", v1_deny, v2_deny)
    check("T4", separated(v1_deny, v2_deny) and v2_deny.p > v1_deny.p, f"deny {v1_deny.p:.0%} -> {v2_deny.p:.0%}")

    # T5 fraud threshold gap
    approved = [r for r in hist if r["screen"]["decision"] == "approve"]
    unauth = lambda r: r.get("dispute", {}).get("category") == "unauthorized"  # noqa: E731
    mid = Rate("approved at risk 60-75 -> unauthorized dispute", [r for r in approved if 60 <= r["screen"]["risk_score"] <= 75], unauth)
    low = Rate("approved at risk < 60 -> unauthorized dispute", [r for r in approved if r["screen"]["risk_score"] < 60], unauth)
    unauth_win = Rate("unauthorized disputes contested -> won",
                      [d for d in disputes if d["category"] == "unauthorized" and d["contest"]], lambda d: d["won"])
    show("T5 fraud threshold gap", mid, low, unauth_win)
    check("T5", separated(mid, low) and mid.p > low.p and mid.k >= 50, f"{mid.p:.1%} vs {low.p:.1%} unauthorized rate")

    # T6 new option
    te = [c for c in complaints if c["category"] == "too_expensive" and c["day"] >= "2026-05-01"]
    pause_uses = sum(1 for c in complaints if c["ai_option"] == "pause_subscription")
    p_disp = Rate("too_expensive (May-Jun), final pause -> dispute", [c for c in te if c["final_option"] == "pause_subscription"], lambda c: c["disputed"])
    d_disp = Rate("too_expensive (May-Jun), final deny -> dispute", [c for c in te if c["final_option"] == "deny"], lambda c: c["disputed"])
    p_churn = Rate("too_expensive (May-Jun), final pause -> churn", [c for c in te if c["final_option"] == "pause_subscription"], lambda c: bool(c["churn"]))
    d_churn = Rate("too_expensive (May-Jun), final deny -> churn", [c for c in te if c["final_option"] == "deny"], lambda c: bool(c["churn"]))
    show(f"T6 new option (pause_subscription proposed {pause_uses} times)", p_disp, d_disp, p_churn, d_churn)
    check("T6", separated(p_churn, d_churn) and p_churn.p < d_churn.p and pause_uses >= 150,
          f"pause churn {p_churn.p:.0%} vs deny {d_churn.p:.0%}; {pause_uses} uses")

    # Loop: v2 (history) vs v3 (July) at the evidence decision point
    loop_sc = [r["dispute"] for r in loop if "dispute" in r and r["dispute"]["category"] == "subscription_canceled"
               and r["dispute"]["contest"]]
    hist_v2 = [d for d in sc if d["version"] == "v2"]
    v2_win = Rate("v2: subscription_canceled contested -> won", hist_v2, lambda d: d["won"])
    v3_win = Rate("v3: subscription_canceled contested -> won", loop_sc, lambda d: d["won"])
    v3_include = Rate("v3 includes usage logs when available", [d for d in loop_sc if d["logs_available"]], lambda d: d["with_logs"])
    show("Loop v2 -> v3", v2_win, v3_win, v3_include)
    check("Loop", separated(v2_win, v3_win) and v3_win.p > v2_win.p and big_enough(v3_win),
          f"win rate {v2_win.p:.0%} -> {v3_win.p:.0%}")

    # Hero case
    dana = next(r for r in hist if r.get("label") == "hero_dana")
    d = dana.get("dispute", {})
    ok = (dana["complaint"]["ai_option"] == "deny" and not dana["complaint"]["overridden"] and d.get("contest")
          and not d.get("with_logs") and not d.get("won") and dana.get("churn"))
    check("Dana", bool(ok), f"lost ${d.get('cost', 0):.0f}, churned {dana.get('churn')}")

    print("\n" + "=" * 70)
    for truth, ok, note in results:
        print(f"{'PASS' if ok else 'FAIL'}  {truth:<5} {note}")
    if not all(ok for _, ok, _ in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
