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
SCHEMA_VERSION = 6
REACTIONS = load("reactions")
DISCUSSION = load("discussion")
PUT_DISCUSSION = load("put_discussion")
UPDATE_REACTIONS = load("update_reactions")
TRACKED_REACTIONS = load("tracked_reactions")


class DatabaseError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ReactionCounts:
    node_id: str
    number: int
    thumbsup: int
    thumbsdown: int
    fetched_at: int
    reactions: dict[str, int]

    @property
    def up(self) -> int:
        return self.thumbsup

    @property
    def down(self) -> int:
        return self.thumbsdown


@dataclass(frozen=True, slots=True)
class Discussion:
    resource_id: str
    category_key: str
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
            if version not in {0, SCHEMA_VERSION}:
                raise DatabaseError(
                    f"database {self.path} has schema {version}, expected {SCHEMA_VERSION}"
                )
            for migration in MIGRATIONS if version == 0 else ():
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
                node_id=row[1],
                number=row[2],
                thumbsup=row[3],
                thumbsdown=row[4],
                fetched_at=row[5],
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
            (
                row[0],
                ReactionCounts(
                    node_id=row[1],
                    number=row[2],
                    thumbsup=row[3],
                    thumbsdown=row[4],
                    fetched_at=row[5],
                    reactions=json.loads(row[6]),
                ),
            )
            for row in rows
        ]

    def put_discussion(
        self,
        *,
        resource_id: str,
        category_key: str = "default",
        lookup_term: str,
        node_id: str,
        number: int,
        title: str,
        url: str,
        up: int = 0,
        down: int = 0,
        reactions: dict[str, int] | None = None,
        fetched_at: int | None = None,
    ) -> None:
        fetched = int(time.time()) if fetched_at is None else fetched_at
        with self.connect() as connection:
            connection.execute(
                PUT_DISCUSSION,
                (
                    resource_id,
                    category_key,
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
            if reactions:
                connection.executemany(
                    "INSERT OR REPLACE INTO reactions "
                    "(object_id, reaction, count, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    [
                        (node_id, name, count, fetched)
                        for name, count in reactions.items()
                        if name not in {"THUMBS_UP", "THUMBS_DOWN"}
                    ],
                )

    def update_reactions(
        self,
        *,
        node_id: str,
        thumbsup: int,
        thumbsdown: int,
        reactions: dict[str, int],
        locked: bool,
        updated_at: int | None,
        fetched_at: int,
    ) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                UPDATE_REACTIONS,
                (thumbsup, thumbsdown, locked, updated_at, fetched_at, node_id),
            )
            if cursor.rowcount == 1:
                connection.execute(
                    "DELETE FROM reactions WHERE object_id = ?",
                    (node_id,),
                )
                connection.executemany(
                    "INSERT INTO reactions "
                    "(object_id, reaction, count, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    [(node_id, name, count, fetched_at) for name, count in reactions.items()],
                )
        return cursor.rowcount == 1
