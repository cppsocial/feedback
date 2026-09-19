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
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_refuses_newer_schema(tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "future.sqlite3")
    with database.connect() as connection:
        connection.execute("PRAGMA user_version = 99")

    with pytest.raises(DatabaseError, match="schema 99"):
        database.migrate()
