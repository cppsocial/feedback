from __future__ import annotations

import logging

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from feedback.api.context import SiteRequest, site_request
from feedback.api.http import ApiError, json_strings, preflight
from feedback.protocol.github.oauth import OAuthError
from feedback.service.oauth_state import StateError

logger = logging.getLogger("feedback.oauth")


def _oauth_context(request: Request) -> SiteRequest:
    context = site_request(request, require_origin=True)
    context.require("votes", "discussion", "comments")
    if context.runtime.oauth is None:
        raise ApiError("service_unavailable", "OAuth is unavailable.", 503)
    return context


async def authorize(request: Request) -> Response:
    context = _oauth_context(request)
    assert context.origin is not None and context.runtime.oauth is not None
    body = await json_strings(request, frozenset({"challenge", "nonce"}))
    try:
        url, state = context.runtime.oauth.authorization_url(
            site=context.site.id,
            origin=context.origin,
            challenge=body["challenge"],
            nonce=body["nonce"],
        )
    except StateError, TypeError:
        raise ApiError("invalid_oauth_request", "OAuth parameters are invalid.", 400) from None
    return context.response(
        JSONResponse(
            {"v": 1, "authorization_url": url, "state": state},
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
    )


async def authorize_options(request: Request) -> Response:
    context = _oauth_context(request)
    assert context.origin is not None
    return preflight(context.origin, method="POST", headers="Content-Type")


async def exchange(request: Request) -> Response:
    context = _oauth_context(request)
    assert context.origin is not None and context.runtime.oauth is not None
    body = await json_strings(request, frozenset({"code", "state", "verifier"}))
    try:
        token, state = await context.runtime.oauth.exchange(
            site=context.site.id,
            origin=context.origin,
            code=body["code"],
            state=body["state"],
            verifier=body["verifier"],
        )
    except StateError:
        raise ApiError("invalid_oauth_state", "Authorization must be restarted.", 400) from None
    except OAuthError as exc:
        logger.warning(
            "GitHub OAuth exchange failed: reason=%s status=%s upstream_code=%s "
            "github_request_id=%s site=%s",
            exc.reason,
            exc.status,
            exc.upstream_code,
            exc.request_id,
            context.site.id,
        )
        status = 502 if exc.code == "oauth_exchange_ambiguous" else 400
        raise ApiError(exc.code, "Authorization must be restarted.", status) from exc
    if context.runtime.grants is None:
        raise ApiError("service_unavailable", "Discussion creation is unavailable.", 503)
    grant = context.runtime.grants.issue(
        site=context.site.id, origin=context.origin, nonce=state.nonce
    )
    return context.response(
        JSONResponse(
            {
                "v": 1,
                "access_token": token.value,
                "expires_at": token.expires_at,
                "creation_grant": grant,
            },
            headers={"Cache-Control": "no-store, private", "Pragma": "no-cache"},
        )
    )


async def exchange_options(request: Request) -> Response:
    context = _oauth_context(request)
    assert context.origin is not None
    return preflight(context.origin, method="POST", headers="Content-Type")
