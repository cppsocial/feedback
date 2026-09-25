import asyncio
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import CategoryConfig, Config, SiteConfig
from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.discussions import GitHubDiscussion, GitHubDiscussions
from feedback.service.discussions import DiscussionError, DiscussionService
from feedback.service.oauth_state import CreationGrantSigner
from feedback.service.resources import Resource


class FakeDiscussions:
    def __init__(self) -> None:
        self.find_count = 0
        self.create_count = 0
        self.categories: list[str] = []
        self.bodies: list[str] = []

    async def find(
        self, site: SiteConfig, lookup_term: str, category_key: str
    ) -> GitHubDiscussion | None:
        self.find_count += 1
        self.categories.append(category_key)
        await asyncio.sleep(0)
        return None

    async def create(
        self, site: SiteConfig, category_key: str, *, title: str, body: str
    ) -> GitHubDiscussion:
        self.create_count += 1
        self.categories.append(category_key)
        self.bodies.append(body)
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


class FakeContent:
    def __init__(self) -> None:
        self.calls = 0

    async def find(
        self, site: SiteConfig, lookup_term: str, category_key: str
    ) -> GitHubDiscussion | None:
        raise AssertionError("not used")

    async def create(
        self, site: SiteConfig, category_key: str, *, title: str, body: str
    ) -> GitHubDiscussion:
        raise AssertionError("not used")

    async def content(
        self, site: SiteConfig, discussion_ids: list[str], comments: int = 100
    ) -> dict[str, Any]:
        self.calls += 1
        await asyncio.sleep(0)
        return {"nodes": [{"id": value, "comments": {"nodes": []}} for value in discussion_ids]}

    async def add_comment(
        self, token: str, discussion_id: str, body: str, reply_to_id: str | None
    ) -> dict[str, Any]:
        raise AssertionError("not used")


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
    assert "https://cpp.social/example/" in github.bodies[0]


@pytest.mark.asyncio
async def test_concurrent_content_reads_share_a_cached_github_request(
    config: Config, tmp_path: Path
) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    database.put_discussion(
        resource_id="feedback/example",
        lookup_term="feedback/example",
        node_id="D_example",
        number=7,
        title="Example",
        url="https://github.test/7",
    )
    github = FakeContent()
    service = DiscussionService(github, clock=lambda: 1_000)

    first, second = await asyncio.gather(
        service.content(config.sites["cpp-social"], database, "feedback/example"),
        service.content(config.sites["cpp-social"], database, "feedback/example"),
    )

    assert first == second
    assert github.calls == 1


@pytest.mark.asyncio
async def test_hidden_comments_and_replies_are_excluded(config: Config, tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    database.put_discussion(
        resource_id="feedback/example",
        lookup_term="feedback/example",
        node_id="D_example",
        number=7,
        title="Example",
        url="https://github.test/7",
    )

    class DeletedContent(FakeContent):
        async def content(
            self, site: SiteConfig, discussion_ids: list[str], comments: int = 100
        ) -> dict[str, Any]:
            return {
                "nodes": [
                    {
                        "comments": {
                            "totalCount": 3,
                            "nodes": [
                                {
                                    "id": "DC_deleted",
                                    "deletedAt": "2026-01-01T00:00:00Z",
                                    "body": "must not escape",
                                    "bodyHTML": "<p>must not escape</p>",
                                    "url": "https://github.test/leak",
                                    "author": {"login": "former-author"},
                                    "replies": {"nodes": [{"id": "DC_orphan"}]},
                                },
                                {
                                    "id": "DC_minimized",
                                    "isMinimized": True,
                                    "body": "also must not escape",
                                    "replies": {"nodes": [{"id": "DC_hidden_reply"}]},
                                },
                                {
                                    "id": "DC_visible",
                                    "body": "visible",
                                    "replies": {
                                        "totalCount": 2,
                                        "nodes": [
                                            {"id": "DC_reply", "body": "visible reply"},
                                            {"id": "DC_deleted_reply", "deletedAt": "now"},
                                        ],
                                    },
                                },
                            ],
                        }
                    }
                ]
            }

    result = await DiscussionService(DeletedContent()).content(
        config.sites["cpp-social"], database, "feedback/example"
    )
    comments = result["nodes"][0]["comments"]
    assert comments == {
        "totalCount": 1,
        "nodes": [
            {
                "id": "DC_visible",
                "body": "visible",
                "replies": {
                    "totalCount": 1,
                    "nodes": [{"id": "DC_reply", "body": "visible reply"}],
                },
            }
        ],
    }


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


@pytest.mark.asyncio
async def test_resource_prefix_selects_category_and_body_template(
    config: Config, tmp_path: Path
) -> None:
    database = SiteDatabase(tmp_path / "site.sqlite3")
    database.migrate()
    github = FakeDiscussions()
    original = config.sites["cpp-social"]
    site = replace(
        original,
        categories=MappingProxyType(
            {
                "resources": original.categories["resources"],
                "tips": CategoryConfig("tips", "Tips", "DIC_tips"),
            }
        ),
        discussion_body="Discuss {title}; key={key}; url={url}",
    )

    await DiscussionService(github).ensure(
        site,
        database,
        Resource(key="tips/one", title="Tip one", url="https://cpp.social/tips/one"),
    )

    stored = database.discussion("tips/one")
    assert stored is not None
    assert stored.category_key == "tips"
    assert github.categories == ["tips", "tips"]
    assert github.bodies == ["Discuss Tip one; key=tips/one; url=https://cpp.social/tips/one"]


def test_ensure_endpoint_requires_an_origin_bound_grant(
    config: Config, caplog: pytest.LogCaptureFixture
) -> None:
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
        with caplog.at_level("WARNING", logger="feedback.oauth"):
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
    assert "Discussion creation grant rejected" in caplog.text
    assert "site=cpp-social" in caplog.text
    assert grant not in caplog.text


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
        config.sites["cpp-social"], "feedback/example", "resources"
    )

    assert result is not None
    assert result.node_id == "D_example"
    assert github.calls == [
        (
            123,
            {"query": 'repo:cppsocial/site category:"Resources" in:title "feedback/example"'},
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
        config.sites["cpp-social"], "feedback/example", "resources"
    )

    assert result is None
