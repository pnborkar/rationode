"""Neo4j connection from environment variables (.env at the repo root)."""

import os
from pathlib import Path

from dotenv import load_dotenv
from neo4j import Driver, GraphDatabase

REPO_ROOT = Path(__file__).resolve().parents[3]

load_dotenv(REPO_ROOT / ".env")


def database() -> str:
    return os.environ.get("NEO4J_DATABASE", "neo4j")


def driver() -> Driver:
    return GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]),
    )
