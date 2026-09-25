from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from starlette.requests import Request
from starlette.responses import Response

from feedback.api.http import ApiError, cors, error_response
from feedback.config import SiteConfig
from feedback.database.sqlite import SiteDatabase
from feedback.service.runtime import FeedbackRuntime


@dataclass(frozen=True, slots=True)
class SiteRequest:
    runtime: FeedbackRuntime
    site: SiteConfig
    origin: str | None

    @property
    def database(self) -> SiteDatabase:
        return self.runtime.databases[self.site.id]

    def require(self, *intents: str) -> None:
        if not self.site.intents.intersection(intents):
            raise ApiError("feature_disabled", "This feature is not enabled for the site.", 404)

    def response(self, response: Response) -> Response:
        return cors(response, self.origin)


def site_request(request: Request, *, require_origin: bool = False) -> SiteRequest:
    runtime = cast(FeedbackRuntime, request.app.state.services)
    site = runtime.config.sites.get(request.path_params["site"])
    if site is None:
        raise ApiError("site_not_found", "Unknown site.", 404)
    origin = request.headers.get("origin")
    if (require_origin and origin is None) or (origin is not None and origin not in site.origins):
        raise ApiError("origin_not_allowed", "The request origin is not allowed.", 403)
    return SiteRequest(runtime, site, origin)


async def api_error(request: Request, error: Exception) -> Response:
    assert isinstance(error, ApiError)
    runtime = cast(FeedbackRuntime, request.app.state.services)
    site = runtime.config.sites.get(request.path_params.get("site", ""))
    origin = request.headers.get("origin")
    return cors(
        error_response(error),
        origin if site is not None and origin in site.origins else None,
    )
