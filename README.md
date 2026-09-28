# Rationode

**A decision graph on Neo4j: observe every decision your AI agents, people, and systems make, and make it queryable.**

Rationode watches raw events from the systems where decisions happen — agent tool calls, support tickets, payments, fraud screening — recognizes the decisions inside them, and captures each one in Neo4j: who decided, what the options were, what was chosen, under what conditions, and what happened weeks later.

Once decisions are graph data, you can:

- **Trace a case end to end** across systems with a single Cypher path query.
- **Reconstruct the real decision tree** and compare it with the written policy.
- **See where AI and humans disagree**, and who turned out to be right.
- **Find similar past decisions** with vector search, and give them to agents before they act.
- **Run graph algorithms** (GDS) to find clusters, deviating groups, and drift.

## Demo scenario

The demo follows *Streamly*, a fictional subscription service, told from the merchant's side of card disputes:

```
Charge screening  →  Complaint (AI proposes, human may override)  →  Dispute  →  Evidence  →  Won / lost, churn
(fraud tool)          (support agent + Zendesk)                        (AI agent)   (AI agent)
```

Six months of history are simulated from a hidden world model with planted patterns. The events are generated in real formats (Stripe webhooks, Zendesk ticket events, MCP gateway tool-call logs, fraud-tool records), and the pipeline has to rediscover the patterns from the data alone. **All data is synthetic.**

## Repository layout

```
pipeline/
  cypher/schema.cypher          Constraints and indexes (incl. vector index)
  src/rationode/
    schema.py                   Apply schema, seed the schema registry
    registry.py                 Seed decision types, options, attributes, outcome types
    sim/                        Simulator: world model, event formats, generator, verification
    pipeline/                   Raw events → decision graph (parse, detect, write)
```

## Setup

Requirements: Python 3.12+, [uv](https://docs.astral.sh/uv/), a Neo4j 5 database (AuraDB works).

```bash
cp .env.example .env            # fill in your Neo4j connection details
cd pipeline
uv sync
```

## Usage

From `pipeline/`:

```bash
# 1. Schema: constraints, indexes, registry
uv run python -m rationode.schema check
uv run python -m rationode.schema apply

# 2. Generate synthetic events (writes to data/generated/, not committed)
uv run python -m rationode.sim.generate --seed 42
uv run python -m rationode.sim.verify          # checks the planted patterns are strong enough

# 3. Build the decision graph
uv run python -m rationode.pipeline ingest history_events.jsonl --scenario history
uv run python -m rationode.pipeline stats
uv run python -m rationode.pipeline dana       # one customer's full path across systems

# Remove a scenario
uv run python -m rationode.pipeline reset --scenario history
```

Ingest is idempotent: IDs are derived from source events and written with `MERGE`, so re-running is safe. Every node carries a `scenario_id`, so separate runs can live side by side and be removed cleanly.

## Status

Work in progress.

- [x] Schema and registry
- [x] Simulator and verification
- [x] Batch pipeline into Neo4j
- [ ] Decision trees and comparisons
- [ ] Graph Data Science and vector search
- [ ] Agent tools and MCP server
- [ ] Demo app
