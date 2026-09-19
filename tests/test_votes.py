import asyncio
import json
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config
from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.votes import GitHubVotes, VoteResult
from feedback.service.votes import VoteService


class FakeVotes:
    def __init__(self) -> None:
        self.count = 0
        self.active = 0
        self.maximum_active = 0

    async def viewer_vote(self, token: str, discussion_id: str) -> str:
        assert token.startswith("ghu_")
        assert discussion_id == "D_example"
        return "none"

    async def viewer_votes(
        self, token: str, discussion_ids: list[str]
    ) -> dict[str, tuple[str, bool]]:
        assert token.startswith("ghu_")
        return {discussion_id: ("up", True) for discussion_id in discussion_ids}

    async def star(self, token: str, discussion_id: str, current: bool) -> bool:
        assert token.startswith("ghu_")
        assert discussion_id == "D_example"
        return not current

    async def vote(
        self, token: str, discussion_id: str, current: str, requested: str
    ) -> VoteResult:
        self.active += 1
        self.maximum_active = max(self.maximum_active, self.active)
        await asyncio.sleep(0)
        self.count += 1
        self.active -= 1
        return VoteResult(self.count, 0, "up")


def database(path: Path, *, up: int = 0, down: int = 0) -> SiteDatabase:
    result = SiteDatabase(path)
    result.migrate()
    result.put_discussion(
        resource_id="feedback/example",
        lookup_term="feedback/example",
        node_id="D_example",
        number=1,
        title="feedback/example",
        url="https://github.test/1",
        up=up,
        down=down,
        fetched_at=1,
    )
    return result


@pytest.mark.asyncio
async def test_simultaneous_votes_atomically_update_cache(tmp_path: Path) -> None:
    store = database(tmp_path / "site.sqlite3")
    github = FakeVotes()
    service = VoteService(github)

    first, second = await asyncio.gather(
        service.vote(store, resource_id="feedback/example", requested="up", token="ghu_one"),
        service.vote(store, resource_id="feedback/example", requested="up", token="ghu_two"),
    )

    assert {first.up, second.up} == {1, 2}
    assert github.maximum_active == 2
    cached = store.reactions(["feedback/example"])["feedback/example"]
    assert (cached.up, cached.down, cached.fetched_at) == (2, 0, 1)


def test_vote_endpoint_updates_count_without_a_refresh(config: Config) -> None:
    github = FakeVotes()
    app = create_app(config, clock=lambda: 100, votes=VoteService(github))
    with TestClient(app) as client:
        store = app.state.services.databases["cpp-social"]
        store.put_discussion(
            resource_id="feedback/example",
            lookup_term="feedback/example",
            node_id="D_example",
            number=1,
            title="feedback/example",
            url="https://github.test/1",
            fetched_at=1,
        )
        response = client.post(
            "/v1/sites/cpp-social/votes",
            headers={
                "Origin": "https://cpp.social",
                "Authorization": "Bearer ghu_user",
            },
            json={"key": "feedback/example", "vote": "up"},
        )

    assert response.status_code == 200
    assert response.json() == {"v": 1, "up": 1, "down": 0, "viewer": "up"}
    assert response.headers["cache-control"] == "no-store"
    assert store.reactions(["feedback/example"])["feedback/example"].up == 1


def test_viewer_reactions_are_looked_up_in_one_authenticated_batch(config: Config) -> None:
    github = FakeVotes()
    app = create_app(config, clock=lambda: 100, votes=VoteService(github))
    with TestClient(app) as client:
        store = app.state.services.databases["cpp-social"]
        store.put_discussion(
            resource_id="feedback/example",
            lookup_term="feedback/example",
            node_id="D_example",
            number=1,
            title="feedback/example",
            url="https://github.test/1",
        )
        response = client.get(
            "/v1/sites/cpp-social/viewer-reactions?keys=feedback/example,feedback/missing",
            headers={
                "Origin": "https://cpp.social",
                "Authorization": "Bearer ghu_user",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "v": 1,
        "site": "cpp-social",
        "items": {
            "feedback/example": {"vote": "up", "starred": True},
            "feedback/missing": {"vote": "none", "starred": False},
        },
    }
    assert response.headers["cache-control"] == "no-store"


def test_star_endpoint_toggles_github_eyes_reaction(config: Config) -> None:
    app = create_app(config, votes=VoteService(FakeVotes()))
    with TestClient(app) as client:
        store = app.state.services.databases["cpp-social"]
        store.put_discussion(
            resource_id="feedback/example",
            lookup_term="feedback/example",
            node_id="D_example",
            number=1,
            title="feedback/example",
            url="https://github.test/1",
        )
        response = client.post(
            "/v1/sites/cpp-social/stars",
            headers={"Origin": "https://cpp.social", "Authorization": "Bearer ghu_user"},
            json={"key": "feedback/example"},
        )

    assert response.status_code == 200
    assert response.json() == {"v": 1, "starred": False}


class FakeBothVotes(FakeVotes):
    async def viewer_vote(self, token: str, discussion_id: str) -> str:
        return "both"

    async def vote(
        self, token: str, discussion_id: str, current: str, requested: str
    ) -> VoteResult:
        assert current == "both"
        assert requested == "up"
        return VoteResult(8, 2, "up")


@pytest.mark.asyncio
async def test_normalizing_both_reactions_decrements_only_removed_vote(tmp_path: Path) -> None:
    store = database(tmp_path / "site.sqlite3", up=8, down=3)
    service = VoteService(FakeBothVotes())

    result = await service.vote(
        store,
        resource_id="feedback/example",
        requested="up",
        token="ghu_user",
    )

    assert result == VoteResult(8, 2, "up")
    cached = store.reactions(["feedback/example"])["feedback/example"]
    assert (cached.up, cached.down) == (8, 2)


@pytest.mark.asyncio
async def test_github_viewer_reactions_batch_includes_eyes() -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(
            200,
            json={
                "data": {
                    "nodes": [
                        {
                            "id": "D_example",
                            "reactionGroups": [
                                {"content": "THUMBS_UP", "viewerHasReacted": True},
                                {"content": "THUMBS_DOWN", "viewerHasReacted": True},
                                {"content": "EYES", "viewerHasReacted": True},
                            ],
                        }
                    ]
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await GitHubVotes(http).viewer_votes("ghu_user", ["D_example"])

    assert result == {"D_example": ("both", True)}
    assert requests == 1


@pytest.mark.asyncio
async def test_github_star_adds_eyes_reaction() -> None:
    variables: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal variables
        body = json.loads(request.read())
        variables = body["variables"]
        return httpx.Response(
            200,
            json={
                "data": {
                    "add": {
                        "subject": {
                            "reactionGroups": [{"content": "EYES", "viewerHasReacted": True}]
                        }
                    }
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        starred = await GitHubVotes(http).star("ghu_user", "D_example", False)

    assert starred is True
    assert variables == {"id": "D_example", "remove": False, "add": True}
