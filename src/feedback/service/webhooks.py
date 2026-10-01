from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from collections import deque
from collections.abc import Callable
from datetime import datetime

from feedback.config import Config, SiteConfig
from feedback.database.sqlite import SiteDatabase
from feedback.service.category_pins import CategoryPinRefresher
from feedback.service.discussions import DiscussionService

logger = logging.getLogger("feedback.webhook")
_DELIVERY = re.compile(r"[a-fA-F0-9-]{36}\Z")
_SIGNATURE = re.compile(r"sha256=[a-fA-F0-9]{64}\Z")
_ACTION = re.compile(r"[a-z_]{1,48}\Z")
_REACTION_NAMES = {
    "+1": "THUMBS_UP",
    "-1": "THUMBS_DOWN",
    "laugh": "LAUGH",
    "hooray": "HOORAY",
    "confused": "CONFUSED",
    "heart": "HEART",
    "rocket": "ROCKET",
    "eyes": "EYES",
}


class GitHubWebhookHandler:
    def __init__(
        self,
        *,
        secret: bytes,
        config: Config,
        databases: dict[str, SiteDatabase],
        discussions: DiscussionService | None,
        pins: CategoryPinRefresher | None,
        clock: Callable[[], float],
    ) -> None:
        self.secret = secret
        self.config = config
        self.databases = databases
        self.discussions = discussions
        self.pins = pins
        self.clock = clock
        self._seen: set[str] = set()
        self._order: deque[str] = deque()

    def process(self, body: bytes | bytearray, *, signature: str, delivery: str, event: str) -> int:
        if not _SIGNATURE.fullmatch(signature):
            return 401
        expected = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature.lower(), expected):
            return 401
        if not _DELIVERY.fullmatch(delivery):
            return 400
        if delivery in self._seen:
            return 204
        try:
            payload = json.loads(body)
        except ValueError, UnicodeDecodeError:
            return 400
        if not isinstance(payload, dict):
            return 400
        if event == "ping":
            logger.info("GitHub webhook received: event=ping delivery=%s", delivery)
            self._remember(delivery)
            return 204
        repository = payload.get("repository")
        installation = payload.get("installation")
        if not isinstance(repository, dict) or not isinstance(installation, dict):
            return 400
        repo = repository.get("full_name")
        installation_id = installation.get("id")
        if (
            not isinstance(repo, str)
            or not isinstance(installation_id, int)
            or isinstance(installation_id, bool)
        ):
            return 400
        sites = [
            site
            for site in self.config.sites.values()
            if site.repository == repo and site.installation_id == installation_id
        ]
        if not sites:
            return 204
        self._handle(event, payload, sites, repo, delivery)
        self._remember(delivery)
        return 204

    def _remember(self, delivery: str) -> None:
        self._seen.add(delivery)
        self._order.append(delivery)
        if len(self._order) > 1024:
            self._seen.remove(self._order.popleft())

    def _handle(
        self,
        event: str,
        payload: dict[str, object],
        sites: list[SiteConfig],
        repo: str,
        delivery: str,
    ) -> None:
        action = payload.get("action")
        discussion = payload.get("discussion")
        if not isinstance(discussion, dict):
            discussion = {}
        category = discussion.get("category")
        category_name = category.get("name") if isinstance(category, dict) else None
        if not isinstance(category_name, str):
            category_name = None
        number = discussion.get("number")
        node_id = discussion.get("node_id")
        content_caches_removed = 0
        pin_snapshots_expired = 0
        counter_snapshots_updated = 0
        if (
            event in {"discussion", "discussion_comment"}
            and isinstance(node_id, str)
            and self.discussions is not None
        ):
            for site in sites:
                content_caches_removed += self.discussions.invalidate(site.id, node_id)
        if event == "discussion" and action in {"pinned", "unpinned", "category_changed"}:
            for site in sites:
                if self.pins is not None and "category_pins" in site.intents:
                    pin_snapshots_expired += self.pins.invalidate(
                        site,
                        self.databases[site.id],
                        None if action == "category_changed" else category_name,
                    )
        if event in {"discussion", "discussion_comment"} and action != "deleted":
            snapshot = _reaction_snapshot(discussion)
            if (
                snapshot is not None
                and isinstance(node_id, str)
                and isinstance(number, int)
                and not isinstance(number, bool)
            ):
                counts, locked, updated_at = snapshot
                received_at = int(self.clock())
                if updated_at <= received_at + 300:
                    for site in sites:
                        if "votes" in site.intents:
                            counter_snapshots_updated += self.databases[
                                site.id
                            ].update_webhook_reactions(
                                node_id=node_id,
                                number=number,
                                thumbsup=counts["THUMBS_UP"],
                                thumbsdown=counts["THUMBS_DOWN"],
                                reactions={name: counts[name] for name in site.reaction_counters},
                                locked=locked,
                                updated_at=updated_at,
                                fetched_at=max(received_at, updated_at),
                            )
        logger.info(
            "GitHub webhook processed: event=%s action=%s repository=%s sites=%s "
            "discussion_number=%s category=%r delivery=%s "
            "content_caches_removed=%s pin_snapshots_expired=%s "
            "counter_snapshots_updated=%s",
            event if event in {"discussion", "discussion_comment"} else "other",
            action if isinstance(action, str) and _ACTION.fullmatch(action) else "unknown",
            repo,
            ",".join(site.id for site in sites),
            number if isinstance(number, int) and not isinstance(number, bool) else None,
            category_name if category_name is not None and len(category_name) < 80 else None,
            delivery,
            content_caches_removed,
            pin_snapshots_expired,
            counter_snapshots_updated,
        )


def _reaction_snapshot(
    discussion: dict[str, object],
) -> tuple[dict[str, int], bool, int] | None:
    raw = discussion.get("reactions")
    locked = discussion.get("locked")
    updated = discussion.get("updated_at")
    if not isinstance(raw, dict) or not isinstance(locked, bool) or not isinstance(updated, str):
        return None
    counts: dict[str, int] = {}
    for key, name in _REACTION_NAMES.items():
        value = raw.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < 2**63:
            return None
        counts[name] = value
    total = raw.get("total_count")
    if (
        not isinstance(total, int)
        or isinstance(total, bool)
        or not 0 <= total < 2**63
        or total != sum(counts.values())
    ):
        return None
    try:
        when = datetime.fromisoformat(updated.replace("Z", "+00:00"))
        if when.utcoffset() is None:
            return None
        timestamp = int(when.timestamp())
    except ValueError, OverflowError:
        return None
    return counts, locked, timestamp
