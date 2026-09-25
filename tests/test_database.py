import sqlite3
from pathlib import Path

import pytest

from feedback.database.sqlite import DatabaseError, SiteDatabase


def test_migration_and_site_isolation(tmp_path: Path) -> None:
    first = SiteDatabase(tmp_path / "first.sqlite3")
    second = SiteDatabase(tmp_path / "second.sqlite3")
    first.migrate()
    second.migrate()
    first.put_discussion(
        resource_id="a",
        lookup_term="a",
        node_id="D_a",
        number=1,
        title="A",
        url="https://example.test/a",
        up=2,
    )

    assert first.reactions(["a"])["a"].up == 2
    assert second.reactions(["a"]) == {}
    with first.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 7
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_refuses_newer_schema(tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "future.sqlite3")
    with database.connect() as connection:
        connection.execute("PRAGMA user_version = 99")

    with pytest.raises(DatabaseError, match="schema 99"):
        database.migrate()


def test_counter_constraints_and_reaction_refresh_are_atomic(tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    database.put_discussion(
        resource_id="a",
        lookup_term="a",
        node_id="D_a",
        number=1,
        title="A",
        url="https://example.test/a",
        up=2,
        reactions={"HEART": 3},
    )
    assert database.reactions(["a"])["a"].reactions == {"HEART": 3}
    assert database.update_reactions(
        node_id="D_a",
        thumbsup=4,
        thumbsdown=0,
        reactions={"HEART": 1},
        locked=False,
        updated_at=None,
        fetched_at=100,
    )
    refreshed = database.reactions(["a"])["a"]
    assert (refreshed.up, refreshed.reactions) == (4, {"HEART": 1})
    with (
        database.connect() as connection,
        pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"),
    ):
        connection.execute("UPDATE discussions SET thumbsup = -1 WHERE resource_id = ?", ("a",))
    assert database.reactions(["a"])["a"].up == 4


def test_reaction_cascade_only_follows_discussion_deletion(tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    database.put_discussion(
        resource_id="a",
        lookup_term="a",
        node_id="D_a",
        number=1,
        title="A",
        url="https://example.test/a",
        reactions={"HEART": 1},
    )
    with database.connect() as connection:
        connection.execute("DELETE FROM reactions WHERE object_id = ?", ("D_a",))
        assert connection.execute("SELECT count(*) FROM discussions").fetchone()[0] == 1
        connection.execute(
            "INSERT INTO reactions (object_id, reaction, count, updated_at) VALUES (?, ?, ?, ?)",
            ("D_a", "HEART", 1, 1),
        )
        connection.execute("DELETE FROM discussions WHERE id = ?", ("D_a",))
        assert connection.execute("SELECT count(*) FROM reactions").fetchone()[0] == 0
