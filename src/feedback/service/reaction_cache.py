from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime
from typing import Any, Protocol

from feedback.config import SiteConfig
from feedback.database.sqlite import ReactionCounts, SiteDatabase
from feedback.protocol.github.client import GitHubError
from feedback.protocol.github.queries import load

_NODES_QUERY = load("discussion_reactions")


class GraphQLClient(Protocol):
    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]: ...


class ReactionRefresher:
    def __init__(
        self,
        github: GraphQLClient,
        *,
        clock: Callable[[], float] = time.time,
        chunk_size: int = 50,
    ) -> None:
        if not 1 <= chunk_size <= 100:
            raise ValueError("chunk size must be from 1 through 100")
        self._github = github
        self._clock = clock
        self._chunk_size = chunk_size

    async def refresh(
        self,
        site: SiteConfig,
        database: SiteDatabase,
        cached: Iterable[ReactionCounts],
    ) -> int:
        node_ids = sorted({item.node_id for item in cached})
        refreshed = 0
        for offset in range(0, len(node_ids), self._chunk_size):
            chunk = node_ids[offset : offset + self._chunk_size]
            data = await self._github.graphql(site.installation_id, _NODES_QUERY, {"ids": chunk})
            nodes = data.get("nodes")
            if not isinstance(nodes, list):
                raise GitHubError("github_malformed_response")
            fetched_at = int(self._clock())
            for node in nodes:
                parsed = _parse_node(node)
                if parsed is None:
                    continue
                node_id, thumbsup, thumbsdown, upvotes, reactions, locked, updated_at = parsed
                refreshed += database.update_reactions(
                    node_id=node_id,
                    thumbsup=thumbsup,
                    thumbsdown=thumbsdown,
                    upvotes=upvotes,
                    reactions=reactions,
                    locked=locked,
                    updated_at=updated_at,
                    fetched_at=fetched_at,
                )
        return refreshed


def _parse_node(
    value: object,
) -> tuple[str, int, int, int, dict[str, tuple[int, tuple[str, ...]]], bool, int | None] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise GitHubError("github_malformed_response")
    node_id = value.get("id")
    locked = value.get("locked")
    updated = value.get("updatedAt")
    groups = value.get("reactionGroups")
    if not isinstance(node_id, str) or not isinstance(locked, bool) or not isinstance(groups, list):
        raise GitHubError("github_malformed_response")
    counts: dict[str, tuple[int, tuple[str, ...]]] = {}
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("content"), str):
            raise GitHubError("github_malformed_response")
        users = group.get("users")
        if not isinstance(users, dict):
            raise GitHubError("github_malformed_response")
        count = users.get("totalCount")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise GitHubError("github_malformed_response")
        nodes = users.get("nodes", [])
        if not isinstance(nodes, list):
            raise GitHubError("github_malformed_response")
        accounts = tuple(
            node["id"] for node in nodes
            if isinstance(node, dict) and isinstance(node.get("id"), str)
        )
        if len(accounts) != len(nodes):
            raise GitHubError("github_malformed_response")
        counts[group["content"]] = (count, accounts)
    updated_at: int | None = None
    if updated is not None:
        if not isinstance(updated, str):
            raise GitHubError("github_malformed_response")
        try:
            updated_at = int(datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp())
        except ValueError as exc:
            raise GitHubError("github_malformed_response") from exc
    upvotes = value.get("upvoteCount", 0)
    if isinstance(upvotes, bool) or not isinstance(upvotes, int) or upvotes < 0:
        raise GitHubError("github_malformed_response")
    return (
        node_id,
        counts.get("THUMBS_UP", (0, ()))[0],
        counts.get("THUMBS_DOWN", (0, ()))[0],
        upvotes,
        counts,
        locked, updated_at,
    )
