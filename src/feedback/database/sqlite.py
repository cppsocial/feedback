from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from feedback.database.migrations import scripts
from feedback.database.queries import load

MIGRATIONS = scripts()
REACTIONS = load("reactions")
DISCUSSION = load("discussion")
PUT_DISCUSSION = load("put_discussion")
UPDATE_REACTIONS = load("update_reactions")


class DatabaseError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ReactionCounts:
    node_id: str
    up: int
    down: int
    fetched_at: int


@dataclass(frozen=True, slots=True)
class Discussion:
    resource_id: str
    lookup_term: str
    node_id: str
    number: int
    title: str
    url: str


class SiteDatabase:
    def __init__(self, path: Path) -> None:
        self.path = path

    def migrate(self) -> None:
        self.path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        with self.connect() as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > len(MIGRATIONS):
                raise DatabaseError(
                    f"database {self.path} has schema {version}, expected at most {len(MIGRATIONS)}"
                )
            for migration in MIGRATIONS[version:]:
                connection.executescript(migration)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def reactions(self, resource_ids: Iterable[str]) -> dict[str, ReactionCounts]:
        keys = tuple(resource_ids)
        if not keys:
            return {}
        with self.connect() as connection:
            rows = connection.execute(REACTIONS, (json.dumps(keys),)).fetchall()
        return {
            row[0]: ReactionCounts(node_id=row[1], up=row[2], down=row[3], fetched_at=row[4])
            for row in rows
        }

    def discussion(self, resource_id: str) -> Discussion | None:
        with self.connect() as connection:
            row = connection.execute(DISCUSSION, (resource_id,)).fetchone()
        return Discussion(*row) if row is not None else None

    def put_discussion(
        self,
        *,
        resource_id: str,
        lookup_term: str,
        node_id: str,
        number: int,
        title: str,
        url: str,
        up: int = 0,
        down: int = 0,
        fetched_at: int | None = None,
    ) -> None:
        fetched = int(time.time()) if fetched_at is None else fetched_at
        with self.connect() as connection:
            connection.execute(
                PUT_DISCUSSION,
                (
                    resource_id,
                    lookup_term,
                    node_id,
                    number,
                    title,
                    url,
                    up,
                    down,
                    fetched,
                ),
            )

    def update_reactions(
        self,
        *,
        node_id: str,
        up: int,
        down: int,
        locked: bool,
        github_updated_at: int | None,
        fetched_at: int,
    ) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                UPDATE_REACTIONS,
                (up, down, locked, github_updated_at, fetched_at, node_id),
            )
        return cursor.rowcount == 1
