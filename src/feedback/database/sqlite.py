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
ADJUST_REACTIONS = load("adjust_reactions")
TRACKED_REACTIONS = load("tracked_reactions")


class DatabaseError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ReactionCounts:
    node_id: str
    up: int
    down: int
    upvotes: int
    fetched_at: int
    reactions: dict[str, int]


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
            row[0]: ReactionCounts(
                node_id=row[1], up=row[2], down=row[3], upvotes=row[4], fetched_at=row[5],
                reactions=json.loads(row[6]),
            )
            for row in rows
        }

    def discussion(self, resource_id: str) -> Discussion | None:
        with self.connect() as connection:
            row = connection.execute(DISCUSSION, (resource_id,)).fetchone()
        return Discussion(*row) if row is not None else None

    def tracked_reactions(
        self, *, after: str, fetched_before: int, limit: int
    ) -> list[tuple[str, ReactionCounts]]:
        with self.connect() as connection:
            rows = connection.execute(TRACKED_REACTIONS, (after, fetched_before, limit)).fetchall()
        return [
            (row[0], ReactionCounts(
                node_id=row[1], up=row[2], down=row[3], upvotes=row[4], fetched_at=row[5],
                reactions=json.loads(row[6]),
            ))
            for row in rows
        ]

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
        upvotes: int = 0,
        reactions: dict[str, int] | None = None,
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
            connection.execute(
                "UPDATE discussions SET upvotes = ? WHERE resource_id = ?",
                (upvotes, resource_id),
            )
            if reactions:
                connection.executemany(
                    "INSERT OR REPLACE INTO reaction_counts (resource_id, reaction, count) VALUES (?, ?, ?)",
                    [(resource_id, name, count) for name, count in reactions.items()],
                )

    def update_reactions(
        self,
        *,
        node_id: str,
        up: int,
        down: int,
        upvotes: int,
        reactions: dict[str, int],
        locked: bool,
        github_updated_at: int | None,
        fetched_at: int,
    ) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                UPDATE_REACTIONS,
                (up, down, upvotes, locked, github_updated_at, fetched_at, node_id),
            )
            resource = connection.execute(
                "SELECT resource_id FROM discussions WHERE github_node_id = ?", (node_id,)
            ).fetchone()
            if resource is not None:
                connection.execute("DELETE FROM reaction_counts WHERE resource_id = ?", (resource[0],))
                connection.executemany(
                    "INSERT INTO reaction_counts (resource_id, reaction, count) VALUES (?, ?, ?)",
                    [(resource[0], name, count) for name, count in reactions.items()],
                )
        return cursor.rowcount == 1

    def adjust_reactions(
        self,
        *,
        resource_id: str,
        node_id: str,
        up_delta: int,
        down_delta: int,
    ) -> tuple[int, int] | None:
        with self.connect() as connection:
            row = connection.execute(
                ADJUST_REACTIONS,
                (up_delta, down_delta, resource_id, node_id),
            ).fetchone()
        return (row[0], row[1]) if row is not None else None
