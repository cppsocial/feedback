from __future__ import annotations

import hashlib
import json
import logging
import time
from contextlib import suppress
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
from feedback.service.resources import ResourceError, validate_resource_id
from feedback.service.runtime import FeedbackRuntime
from feedback.service.votes import VoteError

oauth_logger = logging.getLogger("feedback.oauth")
github_logger = logging.getLogger("feedback.github")


async def homepage(request: Request) -> Response:
    callback = services(request).config.service.oauth_callback
    return RedirectResponse(callback.split("/v1/oauth/", 1)[0] + "/", status_code=308)


async def reactions(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=request.method == "OPTIONS")
    if request.method == "OPTIONS":
        assert origin is not None
        return preflight(origin, method="GET", headers="If-None-Match")
    keys = resource_keys(request.query_params, site.max_batch_size)
    cached = container.databases[site.id].reactions(keys)
    with suppress(GitHubError):
        await container.refresh_stale(site, cached)
    cached = container.databases[site.id].reactions(keys)
    now = int(container.clock())
    items: dict[str, dict[str, object]] = {}
    for key in keys:
        item = cached.get(key)
        if item is None:
            items[key] = {
                "id": None, "up": 0, "down": 0, "upvotes": 0,
                "reactions": {name: 0 for name in site.reaction_counters},
                "age": 0, "stale": False,
            }
            continue
        age = max(0, now - item.fetched_at)
        reactions = {
            name: item.reactions.get(name, 0)
            for name in site.reaction_counters
        }
        thumbsup = item.up
        up = item.up if site.upvote_source == "thumbsup" else item.upvotes
        if site.upvote_source == "both":
            up = item.up + item.upvotes
        items[key] = {
            "id": item.node_id,
            "up": up,
            "down": item.down if site.downvotes else 0,
            "upvotes": item.upvotes,
            "reactions": {**reactions, "THUMBS_UP": thumbsup},
            "age": age,
            "stale": age >= site.cache_fresh_seconds,
        }
    payload = {"v": 1, "site": site.id, "items": items}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    etag = f'"{hashlib.sha256(body).hexdigest()}"'
    headers = {
        # Revalidate with the service so a successful vote is visible after a
        # reload. GitHub traffic is still bounded by the server-side freshness
        # window and coalesced refresh task.
        "Cache-Control": "no-cache",
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
            code=body["code"],
            state=body["state"],
            verifier=body["verifier"],
        )
    except StateError:
        raise ApiError("invalid_oauth_state", "Authorization must be restarted.", 400) from None
    except OAuthError as exc:
        oauth_logger.warning(
            "GitHub OAuth exchange failed: reason=%s status=%s upstream_code=%s "
            "github_request_id=%s site=%s",
            exc.reason,
            exc.status,
            exc.upstream_code,
            exc.request_id,
            site.id,
        )
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
    except GrantError as exc:
        oauth_logger.warning(
            "Discussion creation grant rejected: reason=%s site=%s",
            str(exc),
            site.id,
        )
        raise ApiError("invalid_creation_grant", "Authentication must be restarted.", 401) from None
    except DiscussionError as exc:
        raise ApiError("discussion_invalid", str(exc), 400) from exc
    except GitHubError as exc:
        github_logger.warning(
            "GitHub discussion request failed: code=%s status=%s github_request_id=%s site=%s",
            exc.code,
            exc.status,
            exc.request_id,
            site.id,
        )
        raise ApiError("github_unavailable", "GitHub is temporarily unavailable.", 502) from exc
    return cors(
        JSONResponse(
            {"v": 1, "id": discussion.node_id, "number": discussion.number},
            headers={"Cache-Control": "no-store"},
        ),
        origin,
    )


async def submit_vote(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=True)
    assert origin is not None
    if container.votes is None:
        raise ApiError("service_unavailable", "Voting is unavailable.", 503)
    if request.method == "OPTIONS":
        return preflight(origin, method="POST", headers="Authorization, Content-Type")
    body = await json_strings(request, frozenset({"key", "vote"}))
    try:
        resource_id = validate_resource_id(body["key"])
    except ResourceError:
        raise ApiError("invalid_vote", "Vote parameters are invalid.", 400) from None
    if body["vote"] not in {"up", "down"}:
        raise ApiError("invalid_vote", "Vote parameters are invalid.", 400)
    cached = container.databases[site.id].reactions([resource_id])
    with suppress(GitHubError):
        await container.refresh_stale(site, cached)
    try:
        result = await container.votes.vote(
            container.databases[site.id],
            resource_id=resource_id,
            requested=body["vote"],
            token=bearer_token(request),
        )
    except VoteError as exc:
        raise ApiError("discussion_not_found", str(exc), 404) from exc
    except GitHubError as exc:
        github_logger.warning(
            "GitHub vote failed: code=%s status=%s github_request_id=%s site=%s",
            exc.code,
            exc.status,
            exc.request_id,
            site.id,
        )
        status = 401 if exc.status == 401 else 502
        raise ApiError("github_vote_failed", "GitHub rejected the vote.", status) from exc
    return cors(
        JSONResponse(
            {"v": 1, "up": result.up, "down": result.down, "viewer": result.viewer},
            headers={"Cache-Control": "no-store"},
        ),
        origin,
    )


async def viewer_reactions(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=True)
    assert origin is not None
    if container.votes is None:
        raise ApiError("service_unavailable", "Voting is unavailable.", 503)
    if request.method == "OPTIONS":
        return preflight(origin, method="GET", headers="Authorization")
    keys = resource_keys(request.query_params, site.max_batch_size)
    started = time.monotonic()
    try:
        known = await container.votes.viewer_votes(
            container.databases[site.id],
            resource_ids=keys,
            token=bearer_token(request),
        )
    except GitHubError as exc:
        github_logger.warning(
            "GitHub viewer reaction lookup failed: code=%s status=%s "
            "github_request_id=%s site=%s nodes=%s",
            exc.code,
            exc.status,
            exc.request_id,
            site.id,
            len(keys),
        )
        status = 401 if exc.status == 401 else 502
        raise ApiError(
            "github_viewer_lookup_failed", "GitHub rejected the lookup.", status
        ) from exc
    items = {
        key: {
            "vote": known.get(key, ("none", False))[0],
            "starred": known.get(key, ("none", False))[1],
        }
        for key in keys
    }
    github_logger.info(
        "GitHub viewer reactions queried: site=%s nodes=%s elapsed_ms=%s",
        site.id,
        len(known),
        round((time.monotonic() - started) * 1000),
    )
    return cors(
        JSONResponse(
            {"v": 1, "site": site.id, "items": items},
            headers={"Cache-Control": "no-store"},
        ),
        origin,
    )


async def toggle_star(request: Request) -> Response:
    container, site, origin = site_context(request, require_origin=True)
    assert origin is not None
    if container.votes is None:
        raise ApiError("service_unavailable", "Stars are unavailable.", 503)
    if request.method == "OPTIONS":
        return preflight(origin, method="POST", headers="Authorization, Content-Type")
    body = await json_strings(request, frozenset({"key"}))
    try:
        resource_id = validate_resource_id(body["key"])
        starred = await container.votes.star(
            container.databases[site.id],
            resource_id=resource_id,
            token=bearer_token(request),
        )
    except ResourceError:
        raise ApiError("invalid_star", "Star parameters are invalid.", 400) from None
    except VoteError as exc:
        raise ApiError("discussion_not_found", str(exc), 404) from exc
    except GitHubError as exc:
        github_logger.warning(
            "GitHub star failed: code=%s status=%s github_request_id=%s site=%s",
            exc.code,
            exc.status,
            exc.request_id,
            site.id,
        )
        status = 401 if exc.status == 401 else 502
        raise ApiError("github_star_failed", "GitHub rejected the star.", status) from exc
    return cors(
        JSONResponse(
            {"v": 1, "starred": starred},
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


def bearer_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if (
        separator != " "
        or scheme.lower() != "bearer"
        or not token.startswith("ghu_")
        or not 8 <= len(token) <= 512
        or any(character.isspace() for character in token)
    ):
        raise ApiError("invalid_token", "A GitHub user token is required.", 401)
    return token


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
