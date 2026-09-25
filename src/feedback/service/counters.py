from __future__ import annotations

from feedback.config import SiteConfig
from feedback.database.sqlite import ReactionCounts


def counter_items(
    site: SiteConfig, keys: list[str], cached: dict[str, ReactionCounts]
) -> dict[str, dict[str, object]]:
    items: dict[str, dict[str, object]] = {}
    for key in keys:
        item = cached.get(key)
        value: dict[str, object] = {
            "id": item.node_id if item else None,
            "up": item.thumbsup if item else 0,
            "down": item.thumbsdown if item else 0,
        }
        if "github_link" in site.intents:
            value["number"] = item.number if item else None
        if site.reaction_counters:
            value["reactions"] = {
                name: item.reactions.get(name, 0) if item else 0 for name in site.reaction_counters
            }
        items[key] = value
    return items
