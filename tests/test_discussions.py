import asyncio
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config, SiteConfig
from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.discussions import GitHubDiscussion, GitHubDiscussions
from feedback.service.discussions import DiscussionError, DiscussionService
from feedback.service.oauth_state import CreationGrantSigner
from feedback.service.resources import Resource


class FakeDiscussions:
    def __init__(self) -> None:
        self.find_count = 0
        self.create_count = 0

    async def find(self, site: SiteConfig, lookup_term: str) -> GitHubDiscussion | None:
        self.find_count += 1
        await asyncio.sleep(0)
        return None

    async def create(self, site: SiteConfig, *, title: str, body: str) -> GitHubDiscussion:
        self.create_count += 1
        assert title == "feedback/example"
        assert "https://cpp.social/example/" in body
        await asyncio.sleep(0)
        return GitHubDiscussion("D_example", 7, title, "https://github.test/7", False, 0, 0)


class FakeGraphQL:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.calls: list[tuple[int, Mapping[str, object]]] = []

    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]:
        self.calls.append((installation_id, variables))
        return self.response


@pytest.mark.asyncio
async def test_concurrent_ensure_creates_one_discussion(config: Config, tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    github = FakeDiscussions()
    service = DiscussionService(github)
    resource = Resource(
        key="feedback/example",
        title="Example",
        url="https://cpp.social/example/",
    )

    first, second = await asyncio.gather(
        service.ensure(config.sites["cpp-social"], database, resource),
        service.ensure(config.sites["cpp-social"], database, resource),
    )

    assert first == second
    assert first.node_id == "D_example"
    assert github.find_count == 1
    assert github.create_count == 1


@pytest.mark.asyncio
async def test_ensure_rejects_unconfigured_canonical_origin(config: Config, tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    service = DiscussionService(FakeDiscussions())

    with pytest.raises(DiscussionError, match="not allowed"):
        await service.ensure(
            config.sites["cpp-social"],
            database,
            Resource(key="feedback/example", url="https://attacker.example/example/"),
        )


def test_ensure_endpoint_requires_an_origin_bound_grant(config: Config) -> None:
    grants = CreationGrantSigner(b"k" * 32, clock=lambda: 1_000)
    app = create_app(
        config,
        clock=lambda: 1_000,
        grants=grants,
        discussions=DiscussionService(FakeDiscussions()),
    )
    grant = grants.issue(
        site="cpp-social",
        origin="https://cpp.social",
        nonce="n" * 22,
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/sites/cpp-social/discussions/ensure",
            headers={"Origin": "https://cpp.social"},
            json={
                "key": "feedback/example",
                "title": "Example",
                "url": "https://cpp.social/example/",
                "grant": grant,
            },
        )
        rejected = client.post(
            "/v1/sites/cpp-social/discussions/ensure",
            headers={"Origin": "https://cpp.social"},
            json={
                "key": "feedback/other",
                "url": "https://cpp.social/other/",
                "grant": grant[:-1] + ("A" if grant[-1] != "A" else "B"),
            },
        )

    assert response.status_code == 200
    assert response.json() == {"v": 1, "id": "D_example", "number": 7}
    assert rejected.status_code == 401


@pytest.mark.asyncio
async def test_discovers_exact_discussion_in_configured_repository_and_category(
    config: Config,
) -> None:
    github = FakeGraphQL(
        {
            "search": {
                "nodes": [
                    {
                        "id": "D_example",
                        "number": 7,
                        "title": "feedback/example",
                        "url": "https://github.test/discussions/7",
                        "locked": False,
                        "repository": {"id": "R_repo"},
                        "category": {"id": "DIC_category"},
                        "reactionGroups": [],
                    }
                ]
            }
        }
    )

    result = await GitHubDiscussions(github).find(
        config.sites["cpp-social"], "feedback/example"
    )

    assert result is not None
    assert result.node_id == "D_example"
    assert github.calls == [
        (
            123,
            {
                "query": 'repo:cppsocial/site category:"Resources" in:title "feedback/example"'
            },
        )
    ]


@pytest.mark.asyncio
async def test_discovery_rejects_results_outside_configured_category(config: Config) -> None:
    github = FakeGraphQL(
        {
            "search": {
                "nodes": [
                    {
                        "id": "D_other",
                        "number": 8,
                        "title": "feedback/example",
                        "url": "https://github.test/discussions/8",
                        "locked": False,
                        "repository": {"id": "R_repo"},
                        "category": {"id": "DIC_other"},
                        "reactionGroups": [],
                    }
                ]
            }
        }
    )

    result = await GitHubDiscussions(github).find(
        config.sites["cpp-social"], "feedback/example"
    )

    assert result is None
