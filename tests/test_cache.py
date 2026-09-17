import asyncio
from collections.abc import Mapping
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
                        {"content": "THUMBS_UP", "users": {"totalCount": 7}},
                        {"content": "THUMBS_DOWN", "users": {"totalCount": 2}},
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


def test_stale_request_waits_for_one_refresh_and_returns_external_votes(
    config: Config, tmp_path: Path
) -> None:
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
        "age": 0,
        "stale": False,
    }
    assert len(github.calls) == 1


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
