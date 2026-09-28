"""Embed decision contexts into the vector index (context_embedding_v1)."""

import time
from collections.abc import Callable

from neo4j import Driver

from rationode.analytics.features import context_text

MODEL = "BAAI/bge-small-en-v1.5"   # 384 dimensions, matches context_embedding_v1
_model = None

Q_CONTEXTS = """
MATCH (d:Decision {scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context)
WHERE $all OR c.embedding IS NULL OR c.embedding_model <> $model
RETURN c.context_id AS id, d.decision_type AS type, properties(c) AS ctx
"""

Q_WRITE = """
UNWIND $rows AS r
MATCH (c:Context {context_id: r.id})
CALL db.create.setNodeVectorProperty(c, 'embedding', r.vector)
SET c.embedding_model = $model, c.embedding_text = r.text
"""


def model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(MODEL)
    return _model


def embed_texts(texts: list[str]) -> list[list[float]]:
    return [v.tolist() for v in model().embed(texts, batch_size=256)]


def embed_contexts(driver: Driver, db: str, scenario: str = "history", all_contexts: bool = False,
                   log: Callable[[str], None] = print) -> int:
    rows = driver.execute_query(Q_CONTEXTS, scenario=scenario, all=all_contexts, model=MODEL, database_=db).records
    if not rows:
        log("  all contexts already embedded")
        return 0
    start = time.time()
    texts = [context_text(r["type"], r["ctx"]) for r in rows]
    vectors = embed_texts(texts)
    log(f"  embedded {len(rows)} contexts in {time.time() - start:.0f}s")
    batch = [{"id": r["id"], "vector": v, "text": t} for r, v, t in zip(rows, vectors, texts)]
    for i in range(0, len(batch), 2000):
        driver.execute_query(Q_WRITE, rows=batch[i:i + 2000], model=MODEL, database_=db)
    log(f"  written in {time.time() - start:.0f}s")
    return len(rows)
