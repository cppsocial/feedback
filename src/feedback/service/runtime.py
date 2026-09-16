from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field

from feedback.config import Config, SiteConfig
from feedback.database.sqlite import ReactionCounts, SiteDatabase
from feedback.protocol.github.oauth import OAuthClient
from feedback.service.discussions import DiscussionService
from feedback.service.oauth_state import CreationGrantSigner
from feedback.service.reaction_cache import ReactionRefresher

logger = logging.getLogger("feedback.runtime")


@dataclass(slots=True)
class FeedbackRuntime:
    config: Config
    databases: dict[str, SiteDatabase]
    clock: Callable[[], float]
    oauth: OAuthClient | None = None
    refresher: ReactionRefresher | None = None
    grants: CreationGrantSigner | None = None
    discussions: DiscussionService | None = None
    _refresh_tasks: dict[str, asyncio.Task[int]] = field(default_factory=dict)
    _refresh_last: dict[tuple[str, str], float] = field(default_factory=dict)

    def schedule_refresh(self, site: SiteConfig, cached: dict[str, ReactionCounts]) -> None:
        if self.refresher is None:
            return
        running = self._refresh_tasks.get(site.id)
        if running is not None and not running.done():
            return
        now = self.clock()
        eligible: list[ReactionCounts] = []
        for key, value in cached.items():
            last = self._refresh_last.get((site.id, key), 0)
            if (
                now - value.fetched_at > site.cache_fresh_seconds
                and now - last >= site.refresh_cooldown_seconds
            ):
                eligible.append(value)
                self._refresh_last[(site.id, key)] = now
        if not eligible:
            return
        task = asyncio.create_task(self.refresher.refresh(site, self.databases[site.id], eligible))
        self._refresh_tasks[site.id] = task
        task.add_done_callback(_consume_task)

    async def close(self) -> None:
        tasks = list(self._refresh_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _consume_task(task: asyncio.Task[int]) -> None:
    if not task.cancelled():
        error = task.exception()
        if error is not None:
            logger.warning(
                "Background reaction refresh failed: error_type=%s error=%s",
                type(error).__name__,
                error,
            )
