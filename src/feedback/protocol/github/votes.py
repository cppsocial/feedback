from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypedDict

import httpx

from feedback.protocol.github.client import GitHubError
from feedback.protocol.github.queries import load

_VIEWER_VOTE = load("viewer_vote")
_VOTE = load("vote")


@dataclass(frozen=True, slots=True)
class VoteResult:
    up: int
    down: int
    viewer: str


class _VoteOperations(TypedDict):
    removeUp: bool
    removeDown: bool
    addUp: bool
    addDown: bool
    finalOperation: str


class GitHubVotes:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http

    async def viewer_vote(self, token: str, discussion_id: str) -> str:
        data = await self._graphql(token, _VIEWER_VOTE, {"id": discussion_id})
        node = data.get("node")
        if not isinstance(node, dict) or not isinstance(node.get("reactionGroups"), list):
            raise GitHubError("github_malformed_response")
        up = False
        down = False
        for group in node["reactionGroups"]:
            if not isinstance(group, dict):
                raise GitHubError("github_malformed_response")
            if group.get("viewerHasReacted") is True:
                if group.get("content") == "THUMBS_UP":
                    up = True
                elif group.get("content") == "THUMBS_DOWN":
                    down = True
        return _viewer_state(up, down)

    async def vote(
        self, token: str, discussion_id: str, current: str, requested: str
    ) -> VoteResult:
        operations = _vote_operations(current, requested)
        data = await self._graphql(
            token,
            _VOTE,
            {
                "id": discussion_id,
                "removeUp": operations["removeUp"],
                "removeDown": operations["removeDown"],
                "addUp": operations["addUp"],
                "addDown": operations["addDown"],
            },
        )
        result = data.get(operations["finalOperation"])
        subject = result.get("subject") if isinstance(result, dict) else None
        groups = subject.get("reactionGroups") if isinstance(subject, dict) else None
        if not isinstance(groups, list):
            raise GitHubError("github_malformed_response")
        up = 0
        down = 0
        viewer_up = False
        viewer_down = False
        for group in groups:
            if not isinstance(group, dict):
                raise GitHubError("github_malformed_response")
            users = group.get("users")
            count = users.get("totalCount") if isinstance(users, dict) else None
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise GitHubError("github_malformed_response")
            content = group.get("content")
            if content == "THUMBS_UP":
                up = count
                if group.get("viewerHasReacted") is True:
                    viewer_up = True
            elif content == "THUMBS_DOWN":
                down = count
                if group.get("viewerHasReacted") is True:
                    viewer_down = True
        return VoteResult(up, down, _viewer_state(viewer_up, viewer_down))

    async def _graphql(
        self, token: str, query: str, variables: dict[str, object]
    ) -> dict[str, Any]:
        try:
            response = await self._http.post(
                "https://api.github.com/graphql",
                headers={"Authorization": f"Bearer {token}"},
                json={"query": query, "variables": variables},
            )
        except httpx.TimeoutException as exc:
            raise GitHubError("github_timeout") from exc
        except httpx.RequestError as exc:
            raise GitHubError("github_transport_error") from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise GitHubError(
                "github_malformed_response",
                status=response.status_code,
                request_id=response.headers.get("x-github-request-id"),
            ) from exc
        if response.status_code >= 400 or not isinstance(body, dict) or body.get("errors"):
            raise GitHubError(
                "github_user_request_failed",
                status=response.status_code,
                request_id=response.headers.get("x-github-request-id"),
            )
        data = body.get("data")
        if not isinstance(data, dict):
            raise GitHubError("github_malformed_response")
        return data


def _vote_operations(current: str, requested: str) -> _VoteOperations:
    if current == "both":
        return {
            "removeUp": requested == "down",
            "removeDown": requested == "up",
            "addUp": False,
            "addDown": False,
            "finalOperation": "removeDown" if requested == "up" else "removeUp",
        }
    return {
        "removeUp": current == "up",
        "removeDown": current == "down",
        "addUp": requested == "up" and current != "up",
        "addDown": requested == "down" and current != "down",
        "finalOperation": (
            ("removeUp" if requested == "up" else "removeDown")
            if current == requested
            else ("addUp" if requested == "up" else "addDown")
        ),
    }


def _viewer_state(up: bool, down: bool) -> str:
    if up and down:
        return "both"
    if up:
        return "up"
    if down:
        return "down"
    return "none"
