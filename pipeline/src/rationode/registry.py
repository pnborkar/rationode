"""Seed data for the schema registry (demo spec Section 3; v4.1 Section 8.4.4).

Every extensible element gets a SchemaElement node. Elements seeded here start
APPROVED. `pause_subscription` is deliberately absent: it must be discovered in
May's tool calls and enter as PROPOSED (demo spec step 9).
"""

DECISION_TYPES = {
    "charge.fraud_screen": {
        "display_name": "Charge screening",
        "options": ["approve", "review", "decline"],
    },
    "support.complaint_resolution": {
        "display_name": "Complaint resolution",
        "options": ["full_refund", "partial_refund", "voucher", "deny"],
    },
    "dispute.response": {
        "display_name": "Dispute response",
        "options": ["accept", "contest"],
    },
    "dispute.evidence": {
        "display_name": "Dispute evidence",
        "options": ["usage_logs", "tos_acceptance", "cancellation_emails", "delivery_confirmation"],
    },
}

# key: (datatype, encoding, ordered values or None, display name)
ATTRIBUTES = {
    "charge.risk_score": ("INTEGER", "NUMERIC", None, "Fraud risk score"),
    "charge.plan": ("STRING", "ONE_HOT", ["monthly_15", "monthly_25", "monthly_49", "annual_180", "annual_300", "annual_480"], "Plan"),
    "charge.is_renewal": ("BOOLEAN", "NUMERIC", None, "Renewal charge"),
    "charge.country_match": ("BOOLEAN", "NUMERIC", None, "Card country matches account"),
    "charge.card_age_days": ("INTEGER", "NUMERIC", None, "Card age (days)"),
    "support.tenure_months": ("INTEGER", "NUMERIC", None, "Customer age (months)"),
    "support.plan": ("STRING", "ONE_HOT", ["monthly_15", "monthly_25", "monthly_49", "annual_180", "annual_300", "annual_480"], "Plan"),
    "support.amount_usd": ("FLOAT", "NUMERIC", None, "Amount in question ($)"),
    "support.complaint_category": ("STRING", "ONE_HOT", ["too_expensive", "didnt_use", "billing_error", "content_issue"], "Complaint type"),
    "support.prior_refunds_90d": ("INTEGER", "NUMERIC", None, "Refunds in last 90 days"),
    "support.channel": ("STRING", "ONE_HOT", ["chat", "email"], "Channel"),
    "dispute.amount_usd": ("FLOAT", "NUMERIC", None, "Disputed amount ($)"),
    "dispute.category": ("STRING", "ONE_HOT", ["subscription_canceled", "not_recognized", "unauthorized", "duplicate_charge"], "Dispute type"),
    "dispute.tenure_months": ("INTEGER", "NUMERIC", None, "Customer age (months)"),
    "dispute.prior_complaint": ("BOOLEAN", "NUMERIC", None, "Complained before disputing"),
    "dispute.usage_logs_available": ("BOOLEAN", "NUMERIC", None, "Usage logs available"),
}

# key: (default attribution window in days, display name)
OUTCOME_TYPES = {
    "dispute_filed": (60, "Dispute filed"),
    "dispute_won": (120, "Dispute won"),
    "dispute_lost": (120, "Dispute lost"),
    "refund_cost": (1, "Refund issued"),
    "renewal": (400, "Renewed"),
    "churn": (400, "Churned"),
}

ENTITY_SUBTYPES = {
    "Customer": "Customer",
    "Subscription": "Subscription",
    "Charge": "Charge",
    "Ticket": "Support ticket",
    "Dispute": "Dispute",
}


def elements() -> list[dict]:
    """All seed SchemaElement rows."""
    rows = []
    for key, dt in DECISION_TYPES.items():
        rows.append({"key": key, "kind": "DECISION_TYPE", "datatype": None, "encoding": None,
                     "values": None, "window_days": None, "decision_type": key,
                     "display_name": dt["display_name"]})
        for opt in dt["options"]:
            rows.append({"key": f"{key}.{opt}", "kind": "OPTION", "datatype": None, "encoding": None,
                         "values": None, "window_days": None, "decision_type": key,
                         "display_name": opt.replace("_", " ").capitalize()})
    for key, (datatype, encoding, values, name) in ATTRIBUTES.items():
        rows.append({"key": key, "kind": "ATTRIBUTE", "datatype": datatype, "encoding": encoding,
                     "values": values, "window_days": None, "decision_type": None,
                     "display_name": name})
    for key, (window, name) in OUTCOME_TYPES.items():
        rows.append({"key": f"outcome.{key}", "kind": "OUTCOME_TYPE", "datatype": None, "encoding": None,
                     "values": None, "window_days": window, "decision_type": None,
                     "display_name": name})
    for label, name in ENTITY_SUBTYPES.items():
        rows.append({"key": f"entity.{label.lower()}", "kind": "ENTITY_SUBTYPE", "datatype": None,
                     "encoding": None, "values": None, "window_days": None, "decision_type": None,
                     "display_name": name})
    return rows
