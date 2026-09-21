from __future__ import annotations

import asyncio
import copy
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

from feedback.config import SiteConfig
from feedback.database.sqlite import Discussion, SiteDatabase
from feedback.protocol.github.discussions import GitHubDiscussion
from feedback.service.resources import Resource, lookup_term

logger = logging.getLogger("feedback.github")


class DiscussionError(RuntimeError):
    pass


class DiscussionGateway(Protocol):
    async def find(
        self, site: SiteConfig, lookup_term: str, category_key: str
    ) -> GitHubDiscussion | None: ...

    async def create(
        self, site: SiteConfig, category_key: str, *, title: str, body: str
    ) -> GitHubDiscussion: ...


class DiscussionContentGateway(Protocol):
    async def content(
        self, site: SiteConfig, discussion_ids: list[str], comments: int = 25
    ) -> dict[str, Any]: ...


class DiscussionService:
    def __init__(
        self, github: DiscussionGateway, *, clock: Callable[[], float] = time.time
    ) -> None:
        self._github = github
        self._clock = clock
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._content_tasks: dict[tuple[str, tuple[str, ...]], asyncio.Task[dict[str, Any]]] = {}

    async def ensure(
        self, site: SiteConfig, database: SiteDatabase, resource: Resource
    ) -> Discussion:
        if (cached := database.discussion(resource.key)) is not None:
            return cached
        canonical_url = _canonical_url(resource.url, site.origins)
        term = lookup_term(site.mapping, resource)
        category = site.category_for(resource.key)
        lock = self._locks.setdefault((site.id, resource.key), asyncio.Lock())
        async with lock:
            if (cached := database.discussion(resource.key)) is not None:
                return cached
            github = await self._github.find(site, term, category.key)
            if github is None:
                if site.mapping == "number":
                    raise DiscussionError("numbered discussion does not exist")
                github = await self._github.create(
                    site,
                    category.key,
                    title=term,
                    body=site.discussion_body.format(
                        key=resource.key,
                        title=resource.title or resource.key,
                        url=canonical_url,
                    ),
                )
                action = "created"
            else:
                action = "discovered"
            database.put_discussion(
                resource_id=resource.key,
                category_key=category.key,
                lookup_term=term,
                node_id=github.node_id,
                number=github.number,
                title=github.title,
                url=github.url,
                up=github.thumbsup,
                down=github.thumbsdown,
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

    async def content(
        self, site: SiteConfig, database: SiteDatabase, resource_id: str
    ) -> dict[str, Any]:
        result = await self.contents(site, database, [resource_id])
        return {"nodes": [result[resource_id]]}

    async def contents(
        self, site: SiteConfig, database: SiteDatabase, resource_ids: list[str]
    ) -> dict[str, Any]:
        discussions = [database.discussion(resource_id) for resource_id in resource_ids]
        if any(discussion is None for discussion in discussions):
            raise DiscussionError("discussion does not exist")
        resolved = [discussion for discussion in discussions if discussion is not None]
        ids = tuple(discussion.node_id for discussion in resolved)
        key = (site.id, ids)
        task = self._content_tasks.get(key)
        if task is None or task.done():
            gateway = cast(DiscussionContentGateway, self._github)
            task = asyncio.create_task(gateway.content(site, list(ids)))
            self._content_tasks[key] = task
        try:
            payload = _without_deleted_content(await asyncio.shield(task))
            nodes = payload.get("nodes")
            if not isinstance(nodes, list) or len(nodes) != len(resource_ids):
                raise DiscussionError("discussion response is incomplete")
            return dict(zip(resource_ids, nodes, strict=True))
        finally:
            if self._content_tasks.get(key) is task and task.done():
                self._content_tasks.pop(key, None)


def _without_deleted_content(data: dict[str, Any]) -> dict[str, Any]:
    """Remove content fields from deleted comments before they cross the API boundary."""
    result = copy.deepcopy(data)

    def scrub(value: object) -> None:
        if isinstance(value, list):
            for item in value:
                scrub(item)
            return
        if not isinstance(value, dict):
            return
        if value.get("deletedAt") is not None:
            for field in ("body", "bodyHTML", "url", "author", "reactionGroups"):
                value.pop(field, None)
        for child in value.values():
            scrub(child)

    scrub(result)
    return result


def _canonical_url(value: str | None, allowed_origins: tuple[str, ...]) -> str:
    if value is None:
        raise DiscussionError("canonical URL is required")
    parsed = urlsplit(value)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in allowed_origins or parsed.username or parsed.password or parsed.fragment:
        raise DiscussionError("canonical URL is not allowed")
    return value
