"""Encode decision contexts as numeric feature vectors and as text for embeddings.

Encodings come from the schema registry (SchemaElement.encoding). Numeric
attributes are scaled by `scale_max`, stored on the SchemaElement when analytics
run, so a new live case is encoded exactly like the history.
"""

from neo4j import Driver

TYPE_PREFIX = {"charge.fraud_screen": "charge.", "support.complaint_resolution": "support.",
               "dispute.response": "dispute.", "dispute.evidence": "dispute."}

Q_ATTRS = """
MATCH (s:SchemaElement {kind: 'ATTRIBUTE', status: 'APPROVED'})
RETURN s.key AS key, s.datatype AS datatype, s.encoding AS encoding, s.values AS values, s.scale_max AS scale_max
ORDER BY key
"""

Q_SCALE = """
UNWIND $rows AS r
MATCH (s:SchemaElement {key: r.key}) SET s.scale_max = r.scale_max
"""


class Encoder:
    def __init__(self, driver: Driver, db: str):
        self.attrs = [dict(r) for r in driver.execute_query(Q_ATTRS, database_=db).records]

    def columns(self, decision_type: str) -> list[dict]:
        return [a for a in self.attrs if a["key"].startswith(TYPE_PREFIX[decision_type])]

    def fit_scales(self, driver: Driver, db: str, contexts: list[dict]) -> None:
        """Record the maximum of each numeric attribute seen in history."""
        rows = []
        for a in self.attrs:
            if a["encoding"] == "NUMERIC" and a["datatype"] != "BOOLEAN":
                values = [c[a["key"]] for c in contexts if c.get(a["key"]) is not None]
                if values:
                    a["scale_max"] = float(max(values)) or 1.0
                    rows.append({"key": a["key"], "scale_max": a["scale_max"]})
        driver.execute_query(Q_SCALE, rows=rows, database_=db)

    def vector(self, decision_type: str, ctx: dict) -> list[float]:
        out: list[float] = []
        for a in self.columns(decision_type):
            v = ctx.get(a["key"])
            if a["datatype"] == "BOOLEAN":
                out.append(1.0 if v else 0.0)
            elif a["encoding"] == "NUMERIC":
                out.append(min(1.0, float(v or 0) / (a["scale_max"] or 1.0)))
            else:
                out.extend(1.0 if v == value else 0.0 for value in (a["values"] or []))
        return out


def context_text(decision_type: str, c: dict) -> str:
    """Context only (no decision), so a new case can be matched against history."""
    if decision_type == "support.complaint_resolution":
        return (f"Complaint about {str(c.get('support.complaint_category', '')).replace('_', ' ')} via "
                f"{c.get('support.channel')}. Customer tenure {c.get('support.tenure_months')} months on "
                f"{c.get('support.plan')} plan, charge ${c.get('support.amount_usd', 0):.0f}, "
                f"{c.get('support.prior_refunds_90d')} refunds in last 90 days.")
    if decision_type in ("dispute.response", "dispute.evidence"):
        return (f"Card dispute: {str(c.get('dispute.category', '')).replace('_', ' ')}, amount "
                f"${c.get('dispute.amount_usd', 0):.0f}, customer tenure {c.get('dispute.tenure_months')} months, "
                f"{'complained before disputing' if c.get('dispute.prior_complaint') else 'no prior complaint'}, "
                f"usage logs {'available' if c.get('dispute.usage_logs_available') else 'not available'}.")
    return (f"Charge screening: {'renewal' if c.get('charge.is_renewal') else 'signup'} on {c.get('charge.plan')}, "
            f"risk score {c.get('charge.risk_score')}, card age {c.get('charge.card_age_days')} days, card country "
            f"{'matches' if c.get('charge.country_match') else 'does not match'}.")
