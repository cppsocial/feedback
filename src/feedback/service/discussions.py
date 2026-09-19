from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Protocol
from urllib.parse import urlsplit

from feedback.config import SiteConfig
from feedback.database.sqlite import Discussion, SiteDatabase
from feedback.protocol.github.discussions import GitHubDiscussion
from feedback.service.resources import Resource, lookup_term

logger = logging.getLogger("feedback.github")


class DiscussionError(RuntimeError):
    pass


class DiscussionGateway(Protocol):
    async def find(self, site: SiteConfig, lookup_term: str) -> GitHubDiscussion | None: ...

    async def create(self, site: SiteConfig, *, title: str, body: str) -> GitHubDiscussion: ...

    async def content(self, site: SiteConfig, discussion_id: str, comments: int = 100) -> dict[str, Any]: ...

    async def add_comment(
        self, token: str, discussion_id: str, body: str, reply_to_id: str | None
    ) -> dict[str, Any]: ...


class DiscussionService:
    def __init__(self, github: DiscussionGateway) -> None:
        self._github = github
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def ensure(
        self, site: SiteConfig, database: SiteDatabase, resource: Resource
    ) -> Discussion:
        if (cached := database.discussion(resource.key)) is not None:
            return cached
        canonical_url = _canonical_url(resource.url, site.origins)
        term = lookup_term(site.mapping, resource)
        lock = self._locks.setdefault((site.id, resource.key), asyncio.Lock())
        async with lock:
            if (cached := database.discussion(resource.key)) is not None:
                return cached
            github = await self._github.find(site, term)
            if github is None:
                if site.mapping == "number":
                    raise DiscussionError("numbered discussion does not exist")
                github = await self._github.create(
                    site,
                    title=term,
                    body=f"Feedback for [{resource.title or resource.key}]({canonical_url})",
                )
                action = "created"
            else:
                action = "discovered"
            database.put_discussion(
                resource_id=resource.key,
                lookup_term=term,
                node_id=github.node_id,
                number=github.number,
                title=github.title,
                url=github.url,
                thumbsup=github.thumbsup,
                thumbsdown=github.thumbsdown,
                upvotes=github.upvotes,
                reactions=github.reactions or {},
            )
            result = database.discussion(resource.key)
            if result is None:
                raise RuntimeError("discussion was not stored")
            logger.info(
                "GitHub discussion %s: site=%s discussion_number=%s",
                action,
                site.id,
                github.number,
            )
            return result

    async def content(self, site: SiteConfig, database: SiteDatabase, resource_id: str) -> dict[str, Any]:
        discussion = database.discussion(resource_id)
        if discussion is None:
            raise DiscussionError("discussion does not exist")
        return await self._github.content(site, discussion.node_id)

    async def add_comment(
        self,
        site: SiteConfig,
        database: SiteDatabase,
        resource_id: str,
        token: str,
        body: str,
        reply_to_id: str | None,
    ) -> dict[str, Any]:
        discussion = database.discussion(resource_id)
        if discussion is None:
            raise DiscussionError("discussion does not exist")
        if reply_to_id is not None and not database.comment_can_receive_reply(
            reply_to_id, discussion.node_id
        ):
            raise DiscussionError("reply target does not belong to discussion")
        result = await self._github.add_comment(token, discussion.node_id, body, reply_to_id)
        comment_id = result["id"]
        database.put_comment(
            comment_id=comment_id,
            discussion_id=discussion.node_id,
            parent_id=reply_to_id,
            body=str(result.get("body", body)),
            url=result.get("url") if isinstance(result.get("url"), str) else None,
            fetched_at=int(time.time()),
        )
        return result


def _canonical_url(value: str | None, allowed_origins: tuple[str, ...]) -> str:
    if value is None:
        raise DiscussionError("canonical URL is required")
    parsed = urlsplit(value)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in allowed_origins or parsed.username or parsed.password or parsed.fragment:
        raise DiscussionError("canonical URL is not allowed")
    return value
