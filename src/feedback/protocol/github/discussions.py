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


class GitHubDiscussions:
    def __init__(self, client: GraphQLClient) -> None:
        self._client = client

    async def find(
        self, site: SiteConfig, lookup_term: str, category_key: str
    ) -> GitHubDiscussion | None:
        category_config = site.categories[category_key]
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
            return _parse(candidate, site, category_key) if candidate is not None else None
        escaped = lookup_term.replace("\\", "\\\\").replace('"', '\\"')
        query = f'repo:{site.repository} category:"{category_config.name}" in:title "{escaped}"'
        data = await self._client.graphql(
            site.installation_id, load("find_discussion"), {"query": query}
        )
        search = data.get("search")
        if not isinstance(search, dict) or not isinstance(search.get("nodes"), list):
            raise GitHubError("github_malformed_response")
        matches = [
            discussion
            for value in search["nodes"]
            if (discussion := _parse(value, site, category_key)) is not None
            and discussion.title == lookup_term
        ]
        if len(matches) > 1:
            raise GitHubError("discussion_mapping_ambiguous")
        return matches[0] if matches else None

    async def create(
        self, site: SiteConfig, category_key: str, *, title: str, body: str
    ) -> GitHubDiscussion:
        data = await self._client.graphql(
            site.installation_id,
            load("create_discussion"),
            {
                "input": {
                    "repositoryId": site.repository_id,
                    "categoryId": site.categories[category_key].node_id,
                    "title": title,
                    "body": body,
                }
            },
        )
        result = data.get("createDiscussion")
        if not isinstance(result, dict):
            raise GitHubError("github_malformed_response")
        discussion = _parse(result.get("discussion"), site, category_key)
        if discussion is None:
            raise GitHubError("github_malformed_response")
        return discussion

    async def content(
        self, site: SiteConfig, discussion_ids: list[str], comments: int = 25
    ) -> dict[str, Any]:
        return await self._client.graphql(
            site.installation_id,
            load("discussion"),
            {
                "ids": discussion_ids,
                "comments": comments,
                "includeComments": "comments" in site.intents,
                "includeLabels": "labels" in site.intents,
                "includeLink": "github_link" in site.intents,
                "includeReactions": "reactions" in site.intents,
                "includeAnswers": "answers" in site.intents,
                "includePolls": "polls" in site.intents,
                "includeAuthors": "authors" in site.intents,
                "includeModeration": "moderation" in site.intents,
                "includeCommentReactions": "comment_reactions" in site.intents,
                "includeCommentUpvotes": "comment_upvotes" in site.intents,
            },
        )


def _parse(value: object, site: SiteConfig, category_key: str) -> GitHubDiscussion | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise GitHubError("github_malformed_response")
    repository = value.get("repository")
    category = value.get("category")
    if not isinstance(repository, dict) or not isinstance(category, dict):
        raise GitHubError("github_malformed_response")
    if (
        repository.get("id") != site.repository_id
        or category.get("id") != site.categories[category_key].node_id
    ):
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
        reactors = group.get("reactors", group.get("users"))
        count = reactors.get("totalCount") if isinstance(reactors, dict) else None
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise GitHubError("github_malformed_response")
        counts[group["content"]] = count
    return (
        counts.get("THUMBS_UP", 0),
        counts.get("THUMBS_DOWN", 0),
        counts,
    )
