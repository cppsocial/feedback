from __future__ import annotations

import logging

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from feedback.api.context import site_request
from feedback.api.http import ApiError, ensure_discussion_request, preflight, resource_keys
from feedback.protocol.github.client import GitHubError
from feedback.service.discussions import DiscussionError
from feedback.service.oauth_state import GrantError
from feedback.service.resources import ResourceError

oauth_logger = logging.getLogger("feedback.oauth")
github_logger = logging.getLogger("feedback.github")


async def ensure(request: Request) -> Response:
    context = site_request(request, require_origin=True)
    context.require("votes", "discussion")
    assert context.origin is not None
    if context.runtime.grants is None or context.runtime.discussions is None:
        raise ApiError("service_unavailable", "Discussion creation is unavailable.", 503)
    body = await ensure_discussion_request(request)
    try:
        context.runtime.grants.verify(body.grant, site=context.site.id, origin=context.origin)
        discussion = await context.runtime.discussions.ensure(
            context.site, context.database, body.resource
        )
    except GrantError as exc:
        oauth_logger.warning(
            "Discussion creation grant rejected: reason=%s site=%s",
            str(exc),
            context.site.id,
        )
        raise ApiError("invalid_creation_grant", "Authentication must be restarted.", 401) from None
    except (DiscussionError, ResourceError) as exc:
        raise ApiError("discussion_invalid", str(exc), 400) from exc
    except GitHubError as exc:
        github_logger.warning(
            "GitHub discussion request failed: code=%s status=%s github_request_id=%s site=%s",
            exc.code,
            exc.status,
            exc.request_id,
            context.site.id,
        )
        raise ApiError("github_unavailable", "GitHub is temporarily unavailable.", 502) from exc
    return context.response(
        JSONResponse(
            {"v": 1, "id": discussion.node_id, "number": discussion.number},
            headers={"Cache-Control": "no-store"},
        )
    )


async def ensure_options(request: Request) -> Response:
    context = site_request(request, require_origin=True)
    context.require("votes", "discussion")
    if context.runtime.grants is None or context.runtime.discussions is None:
        raise ApiError("service_unavailable", "Discussion creation is unavailable.", 503)
    assert context.origin is not None
    return preflight(context.origin, method="POST", headers="Content-Type")


async def content(request: Request) -> Response:
    context = site_request(request, require_origin=True)
    context.require("discussion")
    if context.runtime.discussions is None:
        raise ApiError("service_unavailable", "Discussion content is unavailable.", 503)
    keys = resource_keys(request.query_params, min(context.site.max_batch_size, 10))
    try:
        items = await context.runtime.discussions.contents(context.site, context.database, keys)
    except DiscussionError as exc:
        raise ApiError("discussion_not_found", str(exc), 404) from exc
    except GitHubError as exc:
        raise ApiError("github_unavailable", "GitHub is temporarily unavailable.", 502) from exc
    return context.response(
        JSONResponse(
            {"v": 1, "site": context.site.id, "items": items},
            headers={"Cache-Control": "no-store"},
        )
    )
