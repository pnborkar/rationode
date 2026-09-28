"""Hidden world model (demo spec Section 4).

These probabilities decide actor behavior and outcomes. The pipeline, the tree
builder, and the agent never read this module: Rationode must rediscover the
planted truths (T1-T6) from observed events alone.
"""

import copy
from datetime import date, datetime, timezone

# ---------------------------------------------------------------- timeline
HISTORY_START = date(2026, 1, 1)
HISTORY_END = date(2026, 6, 30)
AI_V2_FROM = date(2026, 4, 1)           # T4: prompt updated to "reduce refunds"
PAUSE_OPTION_FROM = date(2026, 5, 1)    # T6: agent starts proposing pause_subscription
LOOP_START = date(2026, 7, 1)
LOOP_END = date(2026, 7, 31)

UTC = timezone.utc


def dt(d: date, hour: float = 9.0) -> datetime:
    h = int(hour)
    m = int((hour - h) * 60)
    return datetime(d.year, d.month, d.day, h, m, tzinfo=UTC)


# ---------------------------------------------------------------- population
N_EXISTING = 20_000
N_SIGNUPS = 6_000
N_LOOP_CASES = 6_500

PLANS = {  # key: (price_usd, interval, weight)
    "monthly_15": (15.0, "month", 0.28),
    "monthly_25": (25.0, "month", 0.28),
    "monthly_49": (49.0, "month", 0.14),
    "annual_180": (180.0, "year", 0.15),
    "annual_300": (300.0, "year", 0.105),
    "annual_480": (480.0, "year", 0.045),
}

# Tenure (months) at charge time for existing customers
TENURE_BUCKETS = [((1, 11), 0.40), ((12, 23), 0.30), ((24, 72), 0.30)]

# ---------------------------------------------------------------- charge screening (T5)
# (upper bound of risk band inclusive, fraud probability)
FRAUD_PROBABILITY_BANDS = [(59, 0.01), (75, 0.12), (100, 0.30)]
# The fraud tool's configured rules. Written policy would review 60+;
# the configured threshold only reviews above 75 (T5).
FRAUD_REVIEW_ABOVE = 75
FRAUD_DECLINE_ABOVE = 90

REVIEW_APPROVE_RATE = 0.7   # reviewed charges approved after manual review
REVIEW_FRAUD_CATCH = 0.9    # fraud caught during review

# ---------------------------------------------------------------- complaints
COMPLAINT_RATE_RENEWAL = 0.22
COMPLAINT_RATE_SIGNUP = 0.12
COMPLAINT_CATEGORIES = [("too_expensive", 0.30), ("didnt_use", 0.35), ("billing_error", 0.15), ("content_issue", 0.20)]
CHANNELS = [("chat", 0.65), ("email", 0.35)]

AI_DENY_RATE = {"v1": 0.30, "v2": 0.55, "v3": 0.55}   # T4
AI_PAUSE_SHARE_TOO_EXPENSIVE = 0.35                    # T6, from PAUSE_OPTION_FROM
# When not denying, AI's choice among the rest by category
AI_NON_DENY_MIX = {
    "too_expensive": [("voucher", 0.55), ("partial_refund", 0.30), ("full_refund", 0.15)],
    "didnt_use": [("partial_refund", 0.45), ("voucher", 0.35), ("full_refund", 0.20)],
    "billing_error": [("full_refund", 0.85), ("partial_refund", 0.15)],
    "content_issue": [("voucher", 0.60), ("partial_refund", 0.30), ("full_refund", 0.10)],
}
BILLING_ERROR_DENY_FACTOR = 0.2   # AI rarely denies clear billing errors

HUMAN_REVIEW_RATE = 0.90          # otherwise AI proposal auto-executes after 24h
# T1: human override of AI "deny" to full refund, by team and tenure
HUMAN_OVERRIDE_DENY = {("A", True): 0.60, ("A", False): 0.08, ("B", True): 0.65, ("B", False): 0.35}
HUMAN_RANDOM_OVERRIDE = 0.05      # small overrides on non-deny proposals
PARTIAL_REFUND_SHARE = 0.5
LONG_TENURE_MONTHS = 24

# Outcome probabilities after the FINAL complaint decision
# key: final option -> (dispute_prob_long, dispute_prob_short, churn_prob_long, churn_prob_short)
COMPLAINT_OUTCOMES = {
    "deny": (0.25, 0.08, 0.40, 0.30),
    "full_refund": (0.03, 0.02, 0.08, 0.20),
    "partial_refund": (0.05, 0.03, 0.15, 0.22),
    "voucher": (0.10, 0.05, 0.25, 0.25),
    "pause_subscription": (0.02, 0.02, 0.15, 0.15),
}
# T6 comparison for too_expensive: deny outcomes override the generic table
TOO_EXPENSIVE_DENY = (0.12, 0.12, 0.45, 0.45)

# Dispute category given the complaint category
DISPUTE_CATEGORY_AFTER_COMPLAINT = {
    "too_expensive": [("subscription_canceled", 0.8), ("not_recognized", 0.2)],
    "didnt_use": [("subscription_canceled", 0.8), ("not_recognized", 0.2)],
    "billing_error": [("duplicate_charge", 0.7), ("subscription_canceled", 0.3)],
    "content_issue": [("subscription_canceled", 0.6), ("not_recognized", 0.4)],
}

# "Friendly" disputes with no prior complaint
FRIENDLY_DISPUTE_RATE = 0.045
FRIENDLY_CATEGORY = [("subscription_canceled", 0.6), ("not_recognized", 0.4)]

CHURN_AFTER_DISPUTE = 0.70
MONTHLY_RENEWAL_IF_NO_CHURN = 0.92

# ---------------------------------------------------------------- disputes (T2, T3)
DISPUTE_FEE = 15.0     # charged on every dispute
CONTEST_FEE = 15.0     # charged when contesting, refunded if won

# AI contest probability: (amount <= 50, amount > 50)
AI_CONTEST_RATE = {"v1": (0.45, 0.90), "v2": (0.88, 0.92), "v3": (0.88, 0.92)}
AI_CONTEST_RATE_UNAUTHORIZED = 0.85

USAGE_LOGS_AVAILABLE = {"subscription_canceled": 0.85, "not_recognized": 0.80,
                        "duplicate_charge": 0.60, "unauthorized": 0.10}
CANCELLATION_EMAILS_AVAILABLE = 0.40
DELIVERY_CONFIRMATION_AVAILABLE = 0.30

# Probability the AI includes each available evidence item
AI_EVIDENCE_RATE = {
    "v1": {"usage_logs": 0.42, "tos_acceptance": 0.95, "cancellation_emails": 0.50, "delivery_confirmation": 0.40},
    "v2": {"usage_logs": 0.15, "tos_acceptance": 0.95, "cancellation_emails": 0.50, "delivery_confirmation": 0.40},
    "v3": {"usage_logs": 0.98, "tos_acceptance": 0.95, "cancellation_emails": 0.50, "delivery_confirmation": 0.40},
}

# Win probability when contested: category -> (with usage logs, without)
WIN_RATE = {
    "subscription_canceled": (0.70, 0.20),
    "not_recognized": (0.45, 0.20),
    "duplicate_charge": (0.20, 0.15),
    "unauthorized": (0.04, 0.04),
}

# ---------------------------------------------------------------- people
N_REPS_PER_TEAM = 15
AGENT_ID = "streamly-support-agent"




class World:
    """World configuration: module constants are the defaults (the planted truths).

    Scenario lab dials override any parameter by name, e.g.
    World(FRAUD_REVIEW_ABOVE=60, AI_EVIDENCE_RATE={...}).
    """

    def __init__(self, **overrides):
        for key, value in DEFAULTS.items():
            setattr(self, key, copy.deepcopy(value))
        for key, value in overrides.items():
            if key not in DEFAULTS:
                raise KeyError(f"Unknown world parameter {key!r}")
            setattr(self, key, value)

    def fraud_probability(self, risk_score: int) -> float:
        for upper, p in self.FRAUD_PROBABILITY_BANDS:
            if risk_score <= upper:
                return p
        return self.FRAUD_PROBABILITY_BANDS[-1][1]

    def fraud_tool_decision(self, risk_score: int) -> str:
        if risk_score > self.FRAUD_DECLINE_ABOVE:
            return "decline"
        if risk_score > self.FRAUD_REVIEW_ABOVE:
            return "review"
        return "approve"

    def ai_version(self, on: date, loop: bool = False) -> str:
        if loop:
            return "v3"
        return "v2" if on >= self.AI_V2_FROM else "v1"


DEFAULTS = {k: v for k, v in dict(globals()).items() if k.isupper() and k != "UTC"}
