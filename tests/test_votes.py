import asyncio
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config
from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.votes import VoteResult
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
