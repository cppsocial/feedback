from __future__ import annotations

import logging
import os
import stat
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.routing import Route

from feedback.api.http import ApiError
from feedback.api.middleware import SecurityHeadersMiddleware
from feedback.api.routes import (
    api_error,
    ensure_discussion,
    homepage,
    oauth_authorize,
    oauth_exchange,
    reactions,
    submit_vote,
)
from feedback.config import Config, load_config_from_environment
from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.client import GitHubClient
from feedback.protocol.github.discussions import GitHubDiscussions
from feedback.protocol.github.oauth import OAuthClient
from feedback.protocol.github.votes import GitHubVotes
from feedback.service.discussions import DiscussionService
from feedback.service.oauth_state import CreationGrantSigner, StateSigner
from feedback.service.reaction_cache import ReactionRefresher
from feedback.service.runtime import FeedbackRuntime
from feedback.service.votes import VoteService

logger = logging.getLogger("feedback.runtime")


def create_app(
    config: Config | None = None,
    *,
    clock: Callable[[], float] = time.time,
    oauth: OAuthClient | None = None,
    refresher: ReactionRefresher | None = None,
    grants: CreationGrantSigner | None = None,
    discussions: DiscussionService | None = None,
    votes: VoteService | None = None,
) -> Starlette:
    if oauth is not None and grants is None:
        raise ValueError("OAuth and creation grants must be configured together")

    @asynccontextmanager
    async def lifespan(application: Starlette) -> AsyncIterator[None]:
        loaded = config or load_config_from_environment()
        owned_http: httpx.AsyncClient | None = None
        resolved_oauth: OAuthClient | None
        resolved_refresher: ReactionRefresher | None
        resolved_grants: CreationGrantSigner | None
        resolved_discussions: DiscussionService | None
        resolved_votes: VoteService | None
        if config is None and oauth is None:
            owned_http = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    loaded.service.http_request_timeout_seconds,
                    connect=loaded.service.http_connect_timeout_seconds,
                ),
                follow_redirects=False,
            )
            signing_key = _secret("FEEDBACK_OAUTH_STATE_HMAC_KEY_FILE")
            resolved_oauth = _oauth_client(loaded, owned_http, clock, signing_key)
            resolved_grants = CreationGrantSigner(signing_key, clock=clock)
            github = _github_client(loaded, owned_http, clock)
            resolved_refresher = ReactionRefresher(github, clock=clock)
            resolved_discussions = DiscussionService(GitHubDiscussions(github))
            resolved_votes = VoteService(GitHubVotes(owned_http))
        else:
            resolved_oauth = oauth
            resolved_refresher = refresher
            resolved_grants = grants
            resolved_discussions = discussions
            resolved_votes = votes
        databases = {
            site_id: SiteDatabase(loaded.service.data_directory / f"{site_id}.sqlite3")
            for site_id in loaded.sites
        }
        for database in databases.values():
            database.migrate()
        services = FeedbackRuntime(
            loaded,
            databases,
            clock,
            oauth=resolved_oauth,
            refresher=resolved_refresher,
            grants=resolved_grants,
            discussions=resolved_discussions,
            votes=resolved_votes,
        )
        application.state.services = services
        logger.info(
            "Feedback service started: public_origin=%s sites=%s",
            loaded.service.public_origin,
            ",".join(sorted(loaded.sites)),
        )
        try:
            yield
        finally:
            await services.close()
            if owned_http is not None:
                await owned_http.aclose()

    application = Starlette(
        routes=[
            Route("/", homepage, methods=["GET"]),
            Route("/v1/sites/{site}/reactions", reactions, methods=["GET", "OPTIONS"]),
            Route(
                "/v1/sites/{site}/oauth/authorize",
                oauth_authorize,
                methods=["POST", "OPTIONS"],
            ),
            Route(
                "/v1/sites/{site}/oauth/exchange",
                oauth_exchange,
                methods=["POST", "OPTIONS"],
            ),
            Route(
                "/v1/sites/{site}/discussions/ensure",
                ensure_discussion,
                methods=["POST", "OPTIONS"],
            ),
            Route(
                "/v1/sites/{site}/votes",
                submit_vote,
                methods=["POST", "OPTIONS"],
            ),
        ],
        lifespan=lifespan,
        exception_handlers={ApiError: api_error},
        middleware=[Middleware(SecurityHeadersMiddleware)],
    )
    return application


def _oauth_client(
    config: Config,
    http: httpx.AsyncClient,
    clock: Callable[[], float],
    signing_key: bytes,
) -> OAuthClient:
    return OAuthClient(
        client_id=config.service.github_client_id,
        client_secret=_secret("FEEDBACK_GITHUB_CLIENT_SECRET_FILE").decode().strip(),
        callback_url=config.service.oauth_callback,
        signer=StateSigner(signing_key, clock=clock),
        http=http,
        clock=clock,
    )


def _github_client(
    config: Config,
    http: httpx.AsyncClient,
    clock: Callable[[], float],
) -> GitHubClient:
    return GitHubClient(
        app_id=config.service.github_app_id,
        private_key=_secret("FEEDBACK_GITHUB_APP_PRIVATE_KEY_FILE").decode(),
        http=http,
        clock=clock,
        concurrency=config.service.github_concurrency,
    )


def _secret(environment_name: str) -> bytes:
    path = os.environ.get(environment_name)
    if not path:
        raise RuntimeError(f"{environment_name} is required")
    secret = Path(path)
    metadata = secret.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022:
        raise RuntimeError(f"{environment_name} must name a non-writable regular file")
    if metadata.st_size > 65_536:
        raise RuntimeError(f"{environment_name} is too large")
    value = secret.read_bytes()
    if not value:
        raise RuntimeError(f"{environment_name} is empty")
    return value


app = create_app()
