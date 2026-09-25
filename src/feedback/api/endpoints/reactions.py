from __future__ import annotations

import hashlib
import json
from contextlib import suppress

from starlette.requests import Request
from starlette.responses import Response

from feedback.api.context import site_request
from feedback.api.http import preflight, resource_keys
from feedback.protocol.github.client import GitHubError
from feedback.service.counters import counter_items


async def get_reactions(request: Request) -> Response:
    context = site_request(request)
    context.require("votes")
    keys = resource_keys(request.query_params, context.site.max_batch_size)
    cached = context.database.reactions(keys)
    with suppress(GitHubError):
        await context.runtime.refresh_stale(context.site, cached)
    await context.runtime.refresh_pins(context.site, keys)
    payload = {
        "v": 1,
        "site": context.site.id,
        "items": counter_items(context.site, keys, context.database.reactions(keys)),
    }
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    etag = f'"{hashlib.sha256(body).hexdigest()}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag, "Vary": "Origin"}
    response = (
        Response(status_code=304, headers=headers)
        if request.headers.get("if-none-match") == etag
        else Response(body, media_type="application/json", headers=headers)
    )
    return context.response(response)


async def options_reactions(request: Request) -> Response:
    context = site_request(request, require_origin=True)
    context.require("votes")
    assert context.origin is not None
    return preflight(context.origin, method="GET", headers="If-None-Match")
