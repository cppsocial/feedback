from __future__ import annotations

import hashlib
import json
from typing import cast

from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from feedback.api.http import (
    ApiError,
    cors,
    ensure_discussion_request,
    error_response,
    json_strings,
    preflight,
    resource_keys,
)
from feedback.config import SiteConfig
from feedback.protocol.github.client import GitHubError
from feedback.protocol.github.oauth import OAuthError
from feedback.service.discussions import DiscussionError
from feedback.service.oauth_state import GrantError, StateError
from feedback.service.runtime import FeedbackRuntime


async def homepage(request: Request) -> Response:
    callback = services(request).config.service.oauth_callback
    return RedirectResponse(callback.split("/v1/oauth/", 1)[0] + "/", status_code=308)


async def reactions(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=request.method == "OPTIONS")
    if request.method == "OPTIONS":
        assert origin is not None
        return preflight(origin, method="GET", headers="If-None-Match")
    keys = resource_keys(request.query_params, site.max_batch_size)
    now = int(container.clock())
    cached = container.databases[site.id].reactions(keys)
    container.schedule_refresh(site, cached)
    items: dict[str, dict[str, str | int | bool | None]] = {}
    for key in keys:
        item = cached.get(key)
        if item is None:
            items[key] = {"id": None, "up": 0, "down": 0, "age": 0, "stale": False}
            continue
        age = max(0, now - item.fetched_at)
        items[key] = {
            "id": item.node_id,
            "up": item.up,
            "down": item.down,
            "age": age,
            "stale": age > site.cache_fresh_seconds,
        }
    payload = {"v": 1, "site": site.id, "items": items}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    etag = f'"{hashlib.sha256(body).hexdigest()}"'
    headers = {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        "ETag": etag,
        "Vary": "Origin",
    }
    response = (
        Response(status_code=304, headers=headers)
        if request.headers.get("if-none-match") == etag
        else Response(body, media_type="application/json", headers=headers)
    )
    return cors(response, origin)


async def oauth_authorize(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=True)
    assert origin is not None
    if container.oauth is None:
        raise ApiError("service_unavailable", "OAuth is unavailable.", 503)
    if request.method == "OPTIONS":
        return preflight(origin, method="POST", headers="Content-Type")
    body = await json_strings(request, frozenset({"challenge", "nonce"}))
    try:
        url, state = container.oauth.authorization_url(
            site=site.id,
            origin=origin,
            challenge=body["challenge"],
            nonce=body["nonce"],
        )
    except StateError, TypeError:
        raise ApiError("invalid_oauth_request", "OAuth parameters are invalid.", 400) from None
    return cors(
        JSONResponse(
            {"v": 1, "authorization_url": url, "state": state},
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        ),
        origin,
    )


async def oauth_exchange(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=True)
    assert origin is not None
    if container.oauth is None:
        raise ApiError("service_unavailable", "OAuth is unavailable.", 503)
    if request.method == "OPTIONS":
        return preflight(origin, method="POST", headers="Content-Type")
    body = await json_strings(request, frozenset({"code", "state", "verifier"}))
    try:
        token, state = await container.oauth.exchange(
            site=site.id,
            origin=origin,
            repository_id=site.repository_id,
            code=body["code"],
            state=body["state"],
            verifier=body["verifier"],
        )
    except StateError:
        raise ApiError("invalid_oauth_state", "Authorization must be restarted.", 400) from None
    except OAuthError as exc:
        status = 502 if exc.code == "oauth_exchange_ambiguous" else 400
        raise ApiError(exc.code, "Authorization must be restarted.", status) from exc
    if container.grants is None:
        raise ApiError("service_unavailable", "Discussion creation is unavailable.", 503)
    grant = container.grants.issue(site=site.id, origin=origin, nonce=state.nonce)
    return cors(
        JSONResponse(
            {
                "v": 1,
                "access_token": token.value,
                "expires_at": token.expires_at,
                "creation_grant": grant,
            },
            headers={"Cache-Control": "no-store, private", "Pragma": "no-cache"},
        ),
        origin,
    )


async def ensure_discussion(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=True)
    assert origin is not None
    if container.grants is None or container.discussions is None:
        raise ApiError("service_unavailable", "Discussion creation is unavailable.", 503)
    if request.method == "OPTIONS":
        return preflight(origin, method="POST", headers="Content-Type")
    body = await ensure_discussion_request(request)
    try:
        container.grants.verify(body.grant, site=site.id, origin=origin)
        discussion = await container.discussions.ensure(
            site, container.databases[site.id], body.resource
        )
    except GrantError:
        raise ApiError("invalid_creation_grant", "Authentication must be restarted.", 401) from None
    except DiscussionError as exc:
        raise ApiError("discussion_invalid", str(exc), 400) from exc
    except GitHubError as exc:
        raise ApiError("github_unavailable", "GitHub is temporarily unavailable.", 502) from exc
    return cors(
        JSONResponse(
            {"v": 1, "id": discussion.node_id, "number": discussion.number},
            headers={"Cache-Control": "no-store"},
        ),
        origin,
    )


async def api_error(request: Request, error: Exception) -> Response:
    assert isinstance(error, ApiError)
    response = error_response(error)
    site = services(request).config.sites.get(request.path_params.get("site", ""))
    origin = request.headers.get("origin")
    return cors(response, origin if site is not None and origin in site.origins else None)


def services(request: Request) -> FeedbackRuntime:
    return cast(FeedbackRuntime, request.app.state.services)


def site_context(
    request: Request, *, require_origin: bool = False
) -> tuple[FeedbackRuntime, SiteConfig, str | None]:
    container = services(request)
    site = container.config.sites.get(request.path_params["site"])
    if site is None:
        raise ApiError("site_not_found", "Unknown site.", 404)
    origin = request.headers.get("origin")
    if (require_origin and origin is None) or (origin is not None and origin not in site.origins):
        raise ApiError("origin_not_allowed", "The request origin is not allowed.", 403)
    return container, site, origin
