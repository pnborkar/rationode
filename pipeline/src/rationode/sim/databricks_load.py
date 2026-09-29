"""Put the lakehouse dataset into Databricks (demo spec §21).

Creates the schema and a volume, uploads the six files (column names in snake_case, as lakehouse
tables have them), and creates one Delta table per file with Change Data Feed on. Uses the SQL
Statement Execution API and the Files API with the workspace settings from .env:

    DATABRICKS_HOST          e.g. https://dbc-xxxx.cloud.databricks.com
    DATABRICKS_TOKEN         personal access token (or a service principal's token)
    DATABRICKS_WAREHOUSE_ID  SQL warehouse ID
    DATABRICKS_SCHEMA        catalog.schema, e.g. main.rationode_test

Usage:
    uv run python -m rationode.sim.lakehouse        # generate the files first
    uv run python -m rationode.sim.databricks_load   # then load them
"""

import csv
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

from dotenv import load_dotenv

from rationode.db import REPO_ROOT
from rationode.sim.lakehouse import OUT_DIR

TABLES = {   # table name -> (file, format)
    "zendesk_ticket_events": ("zendesk_ticket_events.csv", "csv"),
    "stripe_activity": ("stripe_activity.csv", "csv"),
    "support_agent_tool_calls": ("support_agent_tool_calls.jsonl", "json"),
    "fraudguard_screening": ("fraudguard_screening.csv", "csv"),
    "subscriptions": ("subscriptions.csv", "csv"),
    "app_usage_weekly": ("app_usage_weekly.csv", "csv"),
}
VOLUME = "raw_exports"


def snake(name: str) -> str:
    """'Timestamp (UTC)' -> 'timestamp_utc', 'Plan (metadata)' -> 'plan_metadata'."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def snake_csv(text: str) -> bytes:
    rows = list(csv.reader(io.StringIO(text)))
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow([snake(h) for h in rows[0]])
    w.writerows(rows[1:])
    return out.getvalue().encode()


class Databricks:
    def __init__(self):
        load_dotenv(REPO_ROOT / ".env")
        missing = [k for k in ("DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID", "DATABRICKS_SCHEMA")
                   if not os.environ.get(k)]
        if missing:
            sys.exit(f"Missing in .env: {', '.join(missing)}")
        self.host = os.environ["DATABRICKS_HOST"].rstrip("/")
        self.token = os.environ["DATABRICKS_TOKEN"]
        self.warehouse = os.environ["DATABRICKS_WAREHOUSE_ID"]
        self.catalog, self.schema = os.environ["DATABRICKS_SCHEMA"].split(".", 1)

    def request(self, method: str, path: str, body: bytes | None = None, content_type: str = "application/json"):
        req = urllib.request.Request(f"{self.host}{path}", data=body, method=method,
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": content_type})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:500]}")

    def sql(self, statement: str) -> dict:
        r = self.request("POST", "/api/2.0/sql/statements", json.dumps(
            {"warehouse_id": self.warehouse, "statement": statement, "wait_timeout": "50s"}).encode())
        while r["status"]["state"] in ("PENDING", "RUNNING"):
            time.sleep(2)
            r = self.request("GET", f"/api/2.0/sql/statements/{r['statement_id']}")
        if r["status"]["state"] != "SUCCEEDED":
            sys.exit(f"SQL failed ({r['status']['state']}): {statement[:120]}…\n{json.dumps(r['status'])[:600]}")
        return r

    def upload(self, path: str, data: bytes) -> None:
        self.request("PUT", f"/api/2.0/fs/files{path}?overwrite=true", data, "application/octet-stream")


def main() -> None:
    db = Databricks()
    fq = f"`{db.catalog}`.`{db.schema}`"
    print(f"Databricks {db.host} · warehouse {db.warehouse} · {db.catalog}.{db.schema}")
    db.sql(f"CREATE SCHEMA IF NOT EXISTS {fq}")
    db.sql(f"CREATE VOLUME IF NOT EXISTS {fq}.`{VOLUME}`")
    base = f"/Volumes/{db.catalog}/{db.schema}/{VOLUME}"
    for table, (file, fmt) in TABLES.items():
        text = (OUT_DIR / file).read_text()
        data = snake_csv(text) if fmt == "csv" else text.encode()
        t0 = time.time()
        db.upload(f"{base}/{file}", data)
        options = "format => 'csv', header => true, inferSchema => true" if fmt == "csv" else "format => 'json'"
        db.sql(f"CREATE OR REPLACE TABLE {fq}.`{table}` TBLPROPERTIES (delta.enableChangeDataFeed = true) "
               f"AS SELECT * FROM read_files('{base}/{file}', {options})")
        n = db.sql(f"SELECT count(*) FROM {fq}.`{table}`")["result"]["data_array"][0][0]
        print(f"  {table:<26} {n:>7} rows  ({len(data) / 1e6:.1f} MB, {time.time() - t0:.1f}s)")
    print("done: tables have Change Data Feed on (incremental reads via table_changes)")


if __name__ == "__main__":
    main()
