from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Callable
from html.parser import HTMLParser

import httpx

from feedback.config import SiteConfig
from feedback.database.sqlite import SiteDatabase

logger = logging.getLogger("feedback.runtime")


class _CategoryPage(HTMLParser):
    def __init__(self, repository: str) -> None:
        super().__init__()
        self.pattern = re.compile(rf"/{re.escape(repository)}/discussions/([1-9][0-9]*)\Z")
        self.has_discussions = False
        self.depth = 0
        self.numbers: set[int] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get("id") == "discussions-list":
            self.has_discussions = True
        if self.depth:
            if tag == "ul":
                self.depth += 1
            elif (
                tag == "a"
                and (href := values.get("href"))
                and (match := self.pattern.fullmatch(href))
            ):
                self.numbers.add(int(match.group(1)))
        elif tag == "ul" and values.get("aria-labelledby") == "pinned-discussions-list":
            self.depth = 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "ul" and self.depth:
            self.depth -= 1


class CategoryPinRefresher:
    def __init__(self, http: httpx.AsyncClient, *, clock: Callable[[], float]) -> None:
        self.http = http
        self.clock = clock
        self._tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        self._retry_after: dict[tuple[str, str], float] = {}
        self._limit = asyncio.Semaphore(2)

    async def refresh_stale(
        self, site: SiteConfig, database: SiteDatabase, keys: list[str]
    ) -> None:
        categories = database.categories_for(keys) & site.categories.keys()
        tasks: list[asyncio.Task[None]] = []
        now = self.clock()
        for category in sorted(categories):
            identity = (site.id, category)
            task = self._tasks.get(identity)
            if task is not None and not task.done():
                tasks.append(task)
                continue
            snapshot = database.pin_snapshot(category)
            if snapshot is not None and now - snapshot[0] < site.pin_cache_seconds:
                continue
            if now < self._retry_after.get(identity, 0):
                continue
            task = asyncio.create_task(self._refresh(site, database, category, snapshot))
            self._tasks[identity] = task
            tasks.append(task)
        if tasks:
            await asyncio.gather(*(asyncio.shield(task) for task in tasks))

    async def _refresh(
        self,
        site: SiteConfig,
        database: SiteDatabase,
        category: str,
        snapshot: tuple[int, str | None] | None,
    ) -> None:
        slug = site.categories[category].slug or category
        url = f"https://github.com/{site.repository}/discussions/categories/{slug}"
        headers = {"If-None-Match": snapshot[1]} if snapshot and snapshot[1] else {}
        try:
            async with self._limit:
                response = await self.http.get(url, headers=headers)
            fetched_at = int(self.clock())
            if response.status_code == 304 and snapshot is not None:
                database.touch_category_pins(category, fetched_at)
                return
            if response.status_code != 200 or len(response.content) > 1_000_000:
                raise ValueError(f"unexpected category page status or size: {response.status_code}")
            page = _CategoryPage(site.repository)
            page.feed(response.text)
            if not page.has_discussions:
                raise ValueError("unexpected GitHub category page structure")
            database.replace_category_pins(
                category, page.numbers, response.headers.get("etag"), fetched_at
            )
        except (httpx.HTTPError, ValueError) as error:
            self._retry_after[(site.id, category)] = self.clock() + 300
            logger.warning(
                "GitHub category pins refresh failed: site=%s category=%s error_type=%s",
                site.id,
                category,
                type(error).__name__,
            )

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
