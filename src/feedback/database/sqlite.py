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
    thumbsup: int
    thumbsdown: int
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
                node_id=row[1],
                thumbsup=row[2],
                thumbsdown=row[3],
                upvotes=row[4],
                fetched_at=row[5],
                reactions=json.loads(row[6]),
            )
            for row in rows
        }

    def discussion(self, resource_id: str) -> Discussion | None:
        with self.connect() as connection:
            row = connection.execute(DISCUSSION, (resource_id,)).fetchone()
        return Discussion(*row) if row is not None else None

    def comment_belongs_to(self, comment_id: str, discussion_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM comments WHERE id = ? AND discussion_id = ?",
                (comment_id, discussion_id),
            ).fetchone()
        return row is not None

    def comment_can_receive_reply(self, comment_id: str, discussion_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM comments WHERE id = ? AND discussion_id = ? AND parent_id IS NULL",
                (comment_id, discussion_id),
            ).fetchone()
        return row is not None

    def put_comment(
        self,
        *,
        comment_id: str,
        discussion_id: str,
        parent_id: str | None,
        body: str,
        url: str | None,
        fetched_at: int,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO content (id, body) VALUES (?, ?)",
                (comment_id, body),
            )
            connection.execute(
                "INSERT OR REPLACE INTO comments "
                "(id, discussion_id, parent_id, content_id, url, fetched_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (comment_id, discussion_id, parent_id, comment_id, url, fetched_at),
            )

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
                    thumbsup=row[2],
                    thumbsdown=row[3],
                    upvotes=row[4],
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
        lookup_term: str,
        node_id: str,
        number: int,
        title: str,
        url: str,
        thumbsup: int = 0,
        thumbsdown: int = 0,
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
                    thumbsup,
                    thumbsdown,
                    fetched,
                ),
            )
            connection.execute(
                "UPDATE discussions SET upvotes = ? WHERE resource_id = ?",
                (upvotes, resource_id),
            )
            if reactions:
                connection.executemany(
                    "INSERT OR REPLACE INTO reactions "
                    "(discussion_id, reaction, account_id, count, updated_at) "
                    "VALUES (?, ?, '*', ?, ?)",
                    [(node_id, name, count, fetched) for name, count in reactions.items()],
                )

    def update_reactions(
        self,
        *,
        node_id: str,
        thumbsup: int,
        thumbsdown: int,
        upvotes: int,
        reactions: dict[str, tuple[int, tuple[str, ...]]],
        locked: bool,
        updated_at: int | None,
        fetched_at: int,
    ) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                UPDATE_REACTIONS,
                (thumbsup, thumbsdown, upvotes, locked, updated_at, fetched_at, node_id),
            )
            if cursor.rowcount == 1:
                connection.execute(
                    "DELETE FROM reactions WHERE discussion_id = ?",
                    (node_id,),
                )
                connection.executemany(
                    "INSERT INTO reactions "
                    "(discussion_id, reaction, account_id, count, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    [
                        (node_id, name, account_id, count, fetched_at)
                        for name, (total, accounts) in reactions.items()
                        for account_id, count in _reaction_rows(total, accounts)
                    ],
                )
        return cursor.rowcount == 1

    def adjust_reactions(
        self,
        *,
        resource_id: str,
        node_id: str,
        thumbsup_delta: int,
        thumbsdown_delta: int,
    ) -> tuple[int, int] | None:
        with self.connect() as connection:
            row = connection.execute(
                ADJUST_REACTIONS,
                (thumbsup_delta, thumbsdown_delta, resource_id, node_id),
            ).fetchone()
        return (row[0], row[1]) if row is not None else None


def _reaction_rows(total: int, accounts: tuple[str, ...]) -> list[tuple[str, int]]:
    unique = tuple(dict.fromkeys(accounts))
    rows = [(account_id, 1) for account_id in unique]
    remainder = total - len(unique)
    if remainder > 0:
        rows.append(("*", remainder))
    return rows
