import asyncio
import logging
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config
from feedback.database.sqlite import SiteDatabase
from feedback.service.reaction_cache import ReactionRefresher
from feedback.service.runtime import FeedbackRuntime


class FakeGitHub:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.calls: list[tuple[int, Mapping[str, object]]] = []

    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]:
        self.calls.append((installation_id, variables))
        return self.data


class CoordinatedGitHub(FakeGitHub):
    def __init__(self, data: dict[str, Any]) -> None:
        super().__init__(data)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]:
        self.calls.append((installation_id, variables))
        self.started.set()
        await self.release.wait()
        return self.data


@pytest.mark.asyncio
async def test_refreshes_known_nodes_and_preserves_missing_nodes(
    config: Config, tmp_path: Path
) -> None:
    site = config.sites["cpp-social"]
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    for number, key in enumerate(("a", "b"), 1):
        database.put_discussion(
            resource_id=key,
            lookup_term=key,
            node_id=f"D_{key}",
            number=number,
            title=key,
            url=f"https://example.test/{key}",
            fetched_at=1,
        )
    github = FakeGitHub(
        {
            "nodes": [
                {
                    "id": "D_a",
                    "locked": False,
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "reactionGroups": [
                        {
                            "content": "THUMBS_UP",
                            "users": {"totalCount": 7, "nodes": [{"id": "U_one"}]},
                        },
                        {
                            "content": "THUMBS_DOWN",
                            "users": {"totalCount": 2, "nodes": [{"id": "U_two"}]},
                        },
                    ],
                },
                None,
            ]
        }
    )
    refresher = ReactionRefresher(github, clock=lambda: 100, chunk_size=2)

    refreshed = await refresher.refresh(site, database, database.reactions(["a", "b"]).values())

    assert refreshed == 1
    assert github.calls == [(123, {"ids": ["D_a", "D_b"]})]
    assert database.reactions(["a"])["a"].up == 7
    assert database.reactions(["b"])["b"].fetched_at == 1

    with database.connect() as connection:
        reaction_rows = connection.execute(
            "SELECT reaction, account_id, count FROM reactions WHERE object_id = ? "
            "ORDER BY reaction, account_id",
            ("D_a",),
        ).fetchall()
    assert reaction_rows == [
        ("THUMBS_DOWN", "*", 1),
        ("THUMBS_DOWN", "U_two", 1),
        ("THUMBS_UP", "*", 6),
        ("THUMBS_UP", "U_one", 1),
    ]


def test_stale_request_waits_for_one_refresh_and_returns_external_votes(
    config: Config, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="feedback.runtime")
    database = SiteDatabase(tmp_path / "cpp-social.sqlite3")
    database.migrate()
    database.put_discussion(
        resource_id="feedback/example",
        lookup_term="feedback/example",
        node_id="D_example",
        number=1,
        title="feedback/example",
        url="https://github.test/1",
        fetched_at=1,
    )
    github = FakeGitHub(
        {
            "nodes": [
                {
                    "id": "D_example",
                    "locked": False,
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "reactionGroups": [
                        {"content": "THUMBS_UP", "users": {"totalCount": 9}},
                        {"content": "THUMBS_DOWN", "users": {"totalCount": 2}},
                    ],
                }
            ]
        }
    )
    app = create_app(
        config, clock=lambda: 100, refresher=ReactionRefresher(github, clock=lambda: 100)
    )
    with TestClient(app) as client:
        # create_app uses the same configured path as the database above.
        response = client.get(
            "/v1/sites/cpp-social/reactions?keys=feedback/example",
            headers={"Origin": "https://cpp.social"},
        )

    assert response.status_code == 200
    assert response.json()["items"]["feedback/example"] == {
        "id": "D_example",
        "up": 9,
        "down": 2,
        "upvotes": 0,
        "reactions": {
            "CONFUSED": 0,
            "EYES": 0,
            "HEART": 0,
            "HOORAY": 0,
            "LAUGH": 0,
            "ROCKET": 0,
            "THUMBS_DOWN": 2,
            "THUMBS_UP": 9,
        },
        "age": 0,
        "stale": False,
    }
    assert len(github.calls) == 1
    assert "GitHub reaction refresh completed" in caplog.text
    assert "site=cpp-social reason=requested nodes=1 updated=1" in caplog.text


@pytest.mark.asyncio
async def test_simultaneous_stale_reads_share_one_github_batch(
    config: Config, tmp_path: Path
) -> None:
    store = SiteDatabase(tmp_path / "site.sqlite3")
    store.migrate()
    store.put_discussion(
        resource_id="feedback/example",
        lookup_term="feedback/example",
        node_id="D_example",
        number=1,
        title="feedback/example",
        url="https://github.test/1",
        fetched_at=1,
    )
    github = CoordinatedGitHub(
        {
            "nodes": [
                {
                    "id": "D_example",
                    "locked": False,
                    "updatedAt": None,
                    "reactionGroups": [{"content": "THUMBS_UP", "users": {"totalCount": 4}}],
                }
            ]
        }
    )
    runtime = FeedbackRuntime(
        config,
        {"cpp-social": store},
        lambda: 100,
        refresher=ReactionRefresher(github, clock=lambda: 100),
    )
    stale = store.reactions(["feedback/example"])

    first = asyncio.create_task(runtime.refresh_stale(config.sites["cpp-social"], stale))
    await github.started.wait()
    second = asyncio.create_task(runtime.refresh_stale(config.sites["cpp-social"], stale))
    await asyncio.sleep(0)
    github.release.set()
    await asyncio.gather(first, second)

    assert len(github.calls) == 1
    assert store.reactions(["feedback/example"])["feedback/example"].up == 4


@pytest.mark.asyncio
async def test_refresh_window_preserves_then_replaces_tentative_counts(
    config: Config, tmp_path: Path
) -> None:
    store = SiteDatabase(tmp_path / "site.sqlite3")
    store.migrate()
    store.put_discussion(
        resource_id="feedback/example",
        lookup_term="feedback/example",
        node_id="D_example",
        number=1,
        title="feedback/example",
        url="https://github.test/1",
        up=9,
        fetched_at=100,
    )
    data: dict[str, Any] = {
        "nodes": [
            {
                "id": "D_example",
                "locked": False,
                "updatedAt": None,
                "reactionGroups": [{"content": "THUMBS_UP", "users": {"totalCount": 7}}],
            }
        ]
    }
    github = FakeGitHub(data)
    now = 104
    site = replace(
        config.sites["cpp-social"],
        cache_fresh_seconds=5,
        refresh_cooldown_seconds=5,
    )
    runtime = FeedbackRuntime(
        config,
        {"cpp-social": store},
        lambda: now,
        refresher=ReactionRefresher(github, clock=lambda: now),
    )
    store.adjust_reactions(
        resource_id="feedback/example",
        node_id="D_example",
        up_delta=1,
        down_delta=0,
    )

    await runtime.refresh_stale(site, store.reactions(["feedback/example"]))
    assert github.calls == []
    assert store.reactions(["feedback/example"])["feedback/example"].up == 10

    now = 105
    await runtime.refresh_stale(site, store.reactions(["feedback/example"]))

    assert len(github.calls) == 1
    authoritative = store.reactions(["feedback/example"])["feedback/example"]
    assert (authoritative.up, authoritative.fetched_at) == (7, 105)


@pytest.mark.asyncio
async def test_daily_sweep_refreshes_only_old_tracked_discussions(
    config: Config, tmp_path: Path
) -> None:
    store = SiteDatabase(tmp_path / "site.sqlite3")
    store.migrate()
    for key, fetched_at in (("old", 1), ("recent", 99_999)):
        store.put_discussion(
            resource_id=key,
            lookup_term=key,
            node_id=f"D_{key}",
            number=1 if key == "old" else 2,
            title=key,
            url=f"https://github.test/{key}",
            fetched_at=fetched_at,
        )
    github = FakeGitHub(
        {
            "nodes": [
                {
                    "id": "D_old",
                    "locked": False,
                    "updatedAt": None,
                    "reactionGroups": [{"content": "THUMBS_UP", "users": {"totalCount": 6}}],
                }
            ]
        }
    )
    site = replace(config.sites["cpp-social"], refresh_sweep_seconds=3600)
    runtime = FeedbackRuntime(
        Config(config.service, {"cpp-social": site}),
        {"cpp-social": store},
        lambda: 100_000,
        refresher=ReactionRefresher(github, clock=lambda: 100_000),
    )

    await runtime.sweep_once()

    assert github.calls == [(123, {"ids": ["D_old"]})]
    assert store.reactions(["old"])["old"].up == 6
    assert store.reactions(["recent"])["recent"].fetched_at == 99_999
