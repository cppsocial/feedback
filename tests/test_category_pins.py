from pathlib import Path
from types import MappingProxyType

import httpx
import pytest

from feedback.config import CategoryConfig, SiteConfig
from feedback.database.sqlite import SiteDatabase
from feedback.service.category_pins import CategoryPinRefresher
from feedback.service.counters import counter_items


@pytest.mark.asyncio
async def test_category_pins_are_cached_and_scoped_to_the_category(tmp_path: Path) -> None:
    database = SiteDatabase(tmp_path / "pins.sqlite3")
    database.migrate()
    for number, key in [(1, "feedback/example"), (4, "feedback/design")]:
        database.put_discussion(
            resource_id=key,
            category_key="general",
            lookup_term=key,
            node_id=f"D_{number}",
            number=number,
            title=key,
            url=f"https://github.com/cppsocial/feedback/discussions/{number}",
        )
    site = SiteConfig(
        id="feedback",
        origins=("https://feedback.example.com",),
        mode="discussion",
        mapping="key",
        repository="cppsocial/feedback",
        repository_id="R_feedback",
        installation_id=1,
        categories=MappingProxyType(
            {"general": CategoryConfig("general", "General", "DIC_general")}
        ),
        default_category="general",
        intents=frozenset({"votes", "category_pins"}),
    )
    now = 1000.0
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert str(request.url) == (
            "https://github.com/cppsocial/feedback/discussions/categories/general"
        )
        if request.headers.get("if-none-match") == '"pins-1"':
            return httpx.Response(304)
        return httpx.Response(
            200,
            headers={"etag": '"pins-1"'},
            text="""<a href="/cppsocial/feedback/discussions/1">outside</a>
            <h3 id="pinned-discussions-list">Pinned to General</h3>
            <ul aria-labelledby="pinned-discussions-list">
              <li><a href="/cppsocial/feedback/discussions/4">design</a></li>
            </ul><div id="discussions-list"></div>""",
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        refresher = CategoryPinRefresher(http, clock=lambda: now)
        keys = ["feedback/example", "feedback/design"]
        await refresher.refresh_stale(site, database, keys)
        await refresher.refresh_stale(site, database, keys)
        counts = database.reactions(keys)
        assert counter_items(site, keys, counts)["feedback/design"]["pinnedToCategory"] is True
        assert counts["feedback/example"].pinned_to_category is False
        assert len(requests) == 1

        now = 5000.0
        await refresher.refresh_stale(site, database, keys)
        assert len(requests) == 2
        assert database.pin_snapshot("general") == (5000, '"pins-1"')
        assert database.reactions(keys)["feedback/design"].pinned_to_category is True
