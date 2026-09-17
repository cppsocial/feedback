from __future__ import annotations

from dataclasses import dataclass
from typing import Any

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


class GitHubVotes:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http

    async def viewer_vote(self, token: str, discussion_id: str) -> str:
        data = await self._graphql(token, _VIEWER_VOTE, {"id": discussion_id})
        node = data.get("node")
        if not isinstance(node, dict) or not isinstance(node.get("reactionGroups"), list):
            raise GitHubError("github_malformed_response")
        viewer = "none"
        for group in node["reactionGroups"]:
            if not isinstance(group, dict):
                raise GitHubError("github_malformed_response")
            if group.get("viewerHasReacted") is True:
                if group.get("content") == "THUMBS_UP":
                    viewer = "up"
                elif group.get("content") == "THUMBS_DOWN":
                    viewer = "down"
        return viewer

    async def vote(
        self, token: str, discussion_id: str, current: str, requested: str
    ) -> VoteResult:
        operation = _final_operation(current, requested)
        data = await self._graphql(
            token,
            _VOTE,
            {
                "id": discussion_id,
                "removeUp": current == "up",
                "removeDown": current == "down",
                "addUp": requested == "up" and current != "up",
                "addDown": requested == "down" and current != "down",
            },
        )
        result = data.get(operation)
        subject = result.get("subject") if isinstance(result, dict) else None
        groups = subject.get("reactionGroups") if isinstance(subject, dict) else None
        if not isinstance(groups, list):
            raise GitHubError("github_malformed_response")
        up = 0
        down = 0
        viewer = "none"
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
                    viewer = "up"
            elif content == "THUMBS_DOWN":
                down = count
                if group.get("viewerHasReacted") is True:
                    viewer = "down"
        return VoteResult(up, down, viewer)

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


def _final_operation(current: str, requested: str) -> str:
    if current != requested:
        return "addUp" if requested == "up" else "addDown"
    return "removeUp" if requested == "up" else "removeDown"
