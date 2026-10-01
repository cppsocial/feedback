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
        self._locks: dict[str, asyncio.Lock] = {}
        self._content_tasks: dict[tuple[str, str], asyncio.Task[dict[str, Any]]] = {}
        self._content_cache: dict[tuple[str, str], tuple[float, Any]] = {}

    def invalidate(self, site_id: str, node_id: str) -> bool:
        return self._content_cache.pop((site_id, node_id), None) is not None

    async def ensure(
        self, site: SiteConfig, database: SiteDatabase, resource: Resource
    ) -> Discussion:
        if (cached := database.discussion(resource.key)) is not None:
            return cached
        canonical_url = _canonical_url(resource.url, site.origins)
        term = lookup_term(site.mapping, resource)
        category = site.category_for(resource.key)
        lock = self._locks.setdefault(site.id, asyncio.Lock())
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
        discussion = database.discussion(resource_id)
        if discussion is None:
            raise DiscussionError("discussion does not exist")
        node_id = discussion.node_id
        cache_key = (site.id, node_id)
        cached = self._content_cache.get(cache_key)
        if cached is None or self._clock() - cached[0] >= 10:
            key = cache_key
            task = self._content_tasks.get(key)
            if task is None or task.done():
                gateway = cast(DiscussionContentGateway, self._github)
                task = asyncio.create_task(gateway.content(site, [node_id]))
                self._content_tasks[key] = task
            try:
                payload = _without_hidden_content(await asyncio.shield(task))
                nodes = payload.get("nodes")
                if not isinstance(nodes, list) or len(nodes) != 1 or not isinstance(nodes[0], dict):
                    raise DiscussionError("discussion response is incomplete")
                if len(self._content_cache) >= 128 and cache_key not in self._content_cache:
                    for cached_key in list(self._content_cache):
                        if cached_key != cache_key:
                            self._content_cache.pop(cached_key)
                        if len(self._content_cache) < 128:
                            break
                self._content_cache[cache_key] = (self._clock(), nodes[0])
            finally:
                if self._content_tasks.get(key) is task and task.done():
                    self._content_tasks.pop(key, None)
        return copy.deepcopy(self._content_cache[cache_key][1])


def _without_hidden_content(data: dict[str, Any]) -> dict[str, Any]:
    """Exclude deleted or minimized comments and their reply subtrees."""
    result = copy.deepcopy(data)

    def scrub(value: object) -> None:
        if isinstance(value, list):
            for item in value:
                scrub(item)
            return
        if not isinstance(value, dict):
            return
        nodes = value.get("nodes")
        if isinstance(nodes, list):
            visible = [
                node
                for node in nodes
                if not isinstance(node, dict)
                or (node.get("deletedAt") is None and node.get("isMinimized") is not True)
            ]
            value["nodes"] = visible
            if "totalCount" in value:
                value["totalCount"] = len(visible)
        for child in value.values():
            scrub(child)

    scrub(result)
    return result


def _canonical_url(value: str | None, allowed_origins: tuple[str, ...]) -> str:
    if value is None:
        raise DiscussionError("canonical URL is required")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise DiscussionError("canonical URL is not allowed") from exc
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in allowed_origins or parsed.username or parsed.password or parsed.fragment:
        raise DiscussionError("canonical URL is not allowed")
    return value
