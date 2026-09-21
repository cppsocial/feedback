from __future__ import annotations

import asyncio
import logging
import time
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
    _sweep_task: asyncio.Task[None] | None = None

    def start_sweeps(self) -> None:
        if self.refresher is not None and self._sweep_task is None:
            self._sweep_task = asyncio.create_task(self._sweep_loop())

    async def refresh_stale(self, site: SiteConfig, cached: dict[str, ReactionCounts]) -> None:
        if self.refresher is None:
            logger.debug("Reaction refresh skipped: site=%s reason=no_refresher", site.id)
            return
        running = self._refresh_tasks.get(site.id)
        if running is not None and not running.done():
            await asyncio.shield(running)
            # The in-flight batch may have covered the same resources. Re-read
            # their timestamps before deciding whether this request needs a
            # second batch for different keys.
            cached = self.databases[site.id].reactions(cached.keys())
        now = self.clock()
        eligible: list[ReactionCounts] = []
        for key, value in cached.items():
            last = self._refresh_last.get((site.id, key), 0)
            if (
                now - value.fetched_at >= site.cache_fresh_seconds
                and now - last >= site.refresh_cooldown_seconds
            ):
                eligible.append(value)
                self._refresh_last[(site.id, key)] = now
        if not eligible:
            logger.debug(
                "Reaction refresh skipped: site=%s reason=fresh_or_cooldown nodes=%s",
                site.id,
                len(cached),
            )
            return
        await self._refresh_batch(site, eligible, reason="requested")

    async def sweep_once(self) -> None:
        if self.refresher is None:
            return
        for site in self.config.sites.values():
            if "upvotes" not in site.intents:
                continue
            cutoff = int(self.clock()) - site.refresh_sweep_seconds
            after = ""
            batches = 0
            resources = 0
            while True:
                page = self.databases[site.id].tracked_reactions(
                    after=after,
                    fetched_before=cutoff,
                    limit=50,
                )
                if not page:
                    break
                after = page[-1][0]
                try:
                    await self._refresh_batch(site, [counts for _, counts in page], reason="sweep")
                except Exception:
                    # The batch logs safe failure details. Continue this site on
                    # the next scheduled sweep rather than creating a hot loop.
                    break
                batches += 1
                resources += len(page)
                if len(page) < 50:
                    break
                await asyncio.sleep(1)
            logger.info(
                "GitHub reaction sweep completed: site=%s batches=%s resources=%s",
                site.id,
                batches,
                resources,
            )

    async def _refresh_batch(
        self, site: SiteConfig, items: list[ReactionCounts], *, reason: str
    ) -> None:
        assert self.refresher is not None
        running = self._refresh_tasks.get(site.id)
        if running is not None and not running.done():
            await asyncio.shield(running)
        started = time.monotonic()
        task = asyncio.create_task(self.refresher.refresh(site, self.databases[site.id], items))
        self._refresh_tasks[site.id] = task
        try:
            updated = await asyncio.shield(task)
        except Exception as error:
            logger.warning(
                "GitHub reaction refresh failed: site=%s reason=%s nodes=%s "
                "error_type=%s error=%s status=%s github_request_id=%s elapsed_ms=%s",
                site.id,
                reason,
                len(items),
                type(error).__name__,
                error,
                getattr(error, "status", None),
                getattr(error, "request_id", None),
                round((time.monotonic() - started) * 1000),
            )
            raise
        logger.info(
            "GitHub reaction refresh completed: site=%s reason=%s nodes=%s "
            "updated=%s elapsed_ms=%s",
            site.id,
            reason,
            len(items),
            updated,
            round((time.monotonic() - started) * 1000),
        )

    async def _sweep_loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            await self.sweep_once()
            await asyncio.sleep(
                min(site.refresh_sweep_seconds for site in self.config.sites.values())
            )

    async def close(self) -> None:
        if self._sweep_task is not None:
            self._sweep_task.cancel()
        tasks = list(self._refresh_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._sweep_task is not None:
            await asyncio.gather(self._sweep_task, return_exceptions=True)
