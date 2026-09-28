from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from collections import deque

from feedback.config import Config, SiteConfig
from feedback.database.sqlite import SiteDatabase
from feedback.service.category_pins import CategoryPinRefresher
from feedback.service.discussions import DiscussionService

logger = logging.getLogger("feedback.webhook")
_DELIVERY = re.compile(r"[a-fA-F0-9-]{36}\Z")
_SIGNATURE = re.compile(r"sha256=[a-fA-F0-9]{64}\Z")
_ACTION = re.compile(r"[a-z_]{1,48}\Z")


class GitHubWebhookHandler:
    def __init__(
        self,
        *,
        secret: bytes,
        config: Config,
        databases: dict[str, SiteDatabase],
        discussions: DiscussionService | None,
        pins: CategoryPinRefresher | None,
    ) -> None:
        self.secret = secret
        self.config = config
        self.databases = databases
        self.discussions = discussions
        self.pins = pins
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
        logger.info(
            "GitHub webhook received: event=%s action=%s repository=%s sites=%s "
            "discussion_number=%s category=%r delivery=%s",
            event if event in {"discussion", "discussion_comment"} else "other",
            action if isinstance(action, str) and _ACTION.fullmatch(action) else "unknown",
            repo,
            ",".join(site.id for site in sites),
            number if isinstance(number, int) and not isinstance(number, bool) else None,
            category_name if category_name is not None and len(category_name) < 80 else None,
            delivery,
        )
        if (
            event in {"discussion", "discussion_comment"}
            and isinstance(node_id, str)
            and self.discussions is not None
        ):
            for site in sites:
                self.discussions.invalidate(site.id, node_id)
        if event == "discussion" and action in {"pinned", "unpinned", "category_changed"}:
            for site in sites:
                if self.pins is not None and "category_pins" in site.intents:
                    self.pins.invalidate(
                        site,
                        self.databases[site.id],
                        None if action == "category_changed" else category_name,
                    )
