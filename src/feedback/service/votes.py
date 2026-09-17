from __future__ import annotations

from typing import Protocol

from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.votes import VoteResult


class VoteError(ValueError):
    pass


class VoteGateway(Protocol):
    async def viewer_vote(self, token: str, discussion_id: str) -> str: ...

    async def viewer_votes(
        self, token: str, discussion_ids: list[str]
    ) -> dict[str, tuple[str, bool]]: ...

    async def star(self, token: str, discussion_id: str, current: bool) -> bool: ...

    async def vote(
        self, token: str, discussion_id: str, current: str, requested: str
    ) -> VoteResult: ...


class VoteService:
    def __init__(self, github: VoteGateway) -> None:
        self._github = github

    async def viewer_votes(
        self, database: SiteDatabase, *, resource_ids: list[str], token: str
    ) -> dict[str, tuple[str, bool]]:
        discussions = {
            resource_id: discussion
            for resource_id in resource_ids
            if (discussion := database.discussion(resource_id)) is not None
        }
        states = await self._github.viewer_votes(
            token, [discussion.node_id for discussion in discussions.values()]
        )
        return {
            resource_id: states.get(discussion.node_id, ("none", False))
            for resource_id, discussion in discussions.items()
        }

    async def star(self, database: SiteDatabase, *, resource_id: str, token: str) -> bool:
        discussion = database.discussion(resource_id)
        if discussion is None:
            raise VoteError("discussion does not exist")
        current = (await self._github.viewer_votes(token, [discussion.node_id])).get(
            discussion.node_id, ("none", False)
        )[1]
        return await self._github.star(token, discussion.node_id, current)

    async def vote(
        self,
        database: SiteDatabase,
        *,
        resource_id: str,
        requested: str,
        token: str,
    ) -> VoteResult:
        discussion = database.discussion(resource_id)
        if discussion is None:
            raise VoteError("discussion does not exist")
        current = await self._github.viewer_vote(token, discussion.node_id)
        result = await self._github.vote(token, discussion.node_id, current, requested)
        up_delta, down_delta = _vote_delta(current, result.viewer)
        counts = database.adjust_reactions(
            resource_id=resource_id,
            node_id=discussion.node_id,
            up_delta=up_delta,
            down_delta=down_delta,
        )
        if counts is None:
            raise VoteError("discussion changed during vote")
        return VoteResult(counts[0], counts[1], result.viewer)


def _vote_delta(before: str, after: str) -> tuple[int, int]:
    up = int(after in {"up", "both"}) - int(before in {"up", "both"})
    down = int(after in {"down", "both"}) - int(before in {"down", "both"})
    return up, down
