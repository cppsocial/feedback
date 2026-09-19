from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from feedback.config import SiteConfig
from feedback.protocol.github.client import GitHubError
from feedback.protocol.github.queries import load


@dataclass(frozen=True, slots=True)
class GitHubDiscussion:
    node_id: str
    number: int
    title: str
    url: str
    locked: bool
    thumbsup: int
    thumbsdown: int
    upvotes: int = 0
    reactions: dict[str, int] | None = None


class GraphQLClient(Protocol):
    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]: ...

    async def graphql_as_user(
        self, token: str, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]: ...


class GitHubDiscussions:
    def __init__(self, client: GraphQLClient) -> None:
        self._client = client

    async def find(self, site: SiteConfig, lookup_term: str) -> GitHubDiscussion | None:
        if site.mapping == "number":
            data = await self._client.graphql(
                site.installation_id,
                load("discussion_by_number"),
                {"repository": site.repository_id, "number": int(lookup_term)},
            )
            repository = data.get("node")
            if not isinstance(repository, dict):
                return None
            candidate = repository.get("discussion")
            return _parse(candidate, site) if candidate is not None else None
        escaped = lookup_term.replace("\\", "\\\\").replace('"', '\\"')
        query = f'repo:{site.repository} category:"{site.category}" in:title "{escaped}"'
        data = await self._client.graphql(
            site.installation_id, load("find_discussion"), {"query": query}
        )
        search = data.get("search")
        if not isinstance(search, dict) or not isinstance(search.get("nodes"), list):
            raise GitHubError("github_malformed_response")
        matches = [
            discussion
            for value in search["nodes"]
            if (discussion := _parse(value, site)) is not None and discussion.title == lookup_term
        ]
        if len(matches) > 1:
            raise GitHubError("discussion_mapping_ambiguous")
        return matches[0] if matches else None

    async def create(self, site: SiteConfig, *, title: str, body: str) -> GitHubDiscussion:
        data = await self._client.graphql(
            site.installation_id,
            load("create_discussion"),
            {
                "input": {
                    "repositoryId": site.repository_id,
                    "categoryId": site.category_id,
                    "title": title,
                    "body": body,
                }
            },
        )
        result = data.get("createDiscussion")
        if not isinstance(result, dict):
            raise GitHubError("github_malformed_response")
        discussion = _parse(result.get("discussion"), site)
        if discussion is None:
            raise GitHubError("github_malformed_response")
        return discussion

    async def content(
        self, site: SiteConfig, discussion_id: str, comments: int = 100
    ) -> dict[str, Any]:
        return await self._client.graphql(
            site.installation_id,
            load("discussion"),
            {"id": discussion_id, "comments": comments},
        )

    async def add_comment(
        self, token: str, discussion_id: str, body: str, reply_to_id: str | None
    ) -> dict[str, Any]:
        data = await self._client.graphql_as_user(
            token,
            load("add_comment"),
            {"discussionId": discussion_id, "body": body, "replyToId": reply_to_id},
        )
        result = data.get("addDiscussionComment")
        comment = result.get("comment") if isinstance(result, dict) else None
        if not isinstance(comment, dict) or not isinstance(comment.get("id"), str):
            raise GitHubError("github_malformed_response")
        return comment


def _parse(value: object, site: SiteConfig) -> GitHubDiscussion | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise GitHubError("github_malformed_response")
    repository = value.get("repository")
    category = value.get("category")
    if not isinstance(repository, dict) or not isinstance(category, dict):
        raise GitHubError("github_malformed_response")
    if repository.get("id") != site.repository_id or category.get("id") != site.category_id:
        return None
    node_id = value.get("id")
    number = value.get("number")
    title = value.get("title")
    url = value.get("url")
    locked = value.get("locked")
    if (
        not isinstance(node_id, str)
        or isinstance(number, bool)
        or not isinstance(number, int)
        or not isinstance(title, str)
        or not isinstance(url, str)
        or not isinstance(locked, bool)
    ):
        raise GitHubError("github_malformed_response")
    thumbsup, thumbsdown, reactions = _vote_counts(value.get("reactionGroups"))
    upvotes = value.get("upvoteCount", 0)
    if isinstance(upvotes, bool) or not isinstance(upvotes, int) or upvotes < 0:
        raise GitHubError("github_malformed_response")
    return GitHubDiscussion(
        node_id, number, title, url, locked, thumbsup, thumbsdown, upvotes, reactions
    )


def _vote_counts(value: object) -> tuple[int, int, dict[str, int]]:
    if not isinstance(value, list):
        raise GitHubError("github_malformed_response")
    counts: dict[str, int] = {}
    for group in value:
        if not isinstance(group, dict) or not isinstance(group.get("content"), str):
            raise GitHubError("github_malformed_response")
        users = group.get("users")
        count = users.get("totalCount") if isinstance(users, dict) else None
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise GitHubError("github_malformed_response")
        counts[group["content"]] = count
    return (
        counts.get("THUMBS_UP", 0),
        counts.get("THUMBS_DOWN", 0),
        counts,
    )
