from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from feedback.config import Config
from feedback.database.sqlite import SiteDatabase
from feedback.service.reaction_cache import ReactionRefresher


class FakeGitHub:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.calls: list[tuple[int, Mapping[str, object]]] = []

    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]:
        self.calls.append((installation_id, variables))
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
