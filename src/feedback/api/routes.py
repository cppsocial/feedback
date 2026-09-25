from collections.abc import Callable
from typing import Any

from starlette.routing import Route

from feedback.api.endpoints.discussions import content, ensure, ensure_options
from feedback.api.endpoints.oauth import (
    authorize,
    authorize_options,
    exchange,
    exchange_options,
)
from feedback.api.endpoints.reactions import get_reactions, options_reactions


class ApiRoute(Route):
    def __init__(self, path: str, endpoint: Callable[..., Any], *, method: str) -> None:
        super().__init__(path, endpoint, methods=[method])
        # Starlette adds HEAD to every GET route; these reads can trigger GitHub calls.
        self.methods = {method}


API_ROUTES = (
    ApiRoute("/v1/sites/{site}/reactions", get_reactions, method="GET"),
    ApiRoute("/v1/sites/{site}/reactions", options_reactions, method="OPTIONS"),
    ApiRoute("/v1/sites/{site}/oauth/authorize", authorize, method="POST"),
    ApiRoute("/v1/sites/{site}/oauth/authorize", authorize_options, method="OPTIONS"),
    ApiRoute("/v1/sites/{site}/oauth/exchange", exchange, method="POST"),
    ApiRoute("/v1/sites/{site}/oauth/exchange", exchange_options, method="OPTIONS"),
    ApiRoute("/v1/sites/{site}/discussions/ensure", ensure, method="POST"),
    ApiRoute("/v1/sites/{site}/discussions/ensure", ensure_options, method="OPTIONS"),
    ApiRoute("/v1/sites/{site}/discussion", content, method="GET"),
)
