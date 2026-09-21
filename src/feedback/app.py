from __future__ import annotations

import logging
import stat
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.routing import Route

from feedback.api.http import ApiError
from feedback.api.middleware import SecurityHeadersMiddleware, VerboseRequestMiddleware
from feedback.api.routes import (
    api_error,
    discussion_content,
    ensure_discussion,
    homepage,
    oauth_authorize,
    oauth_exchange,
    reactions,
)
from feedback.config import Config
from feedback.database.sqlite import SiteDatabase
from feedback.protocol.github.client import GitHubClient
from feedback.protocol.github.discussions import GitHubDiscussions
from feedback.protocol.github.oauth import OAuthClient
from feedback.service.discussions import DiscussionService
from feedback.service.oauth_state import CreationGrantSigner, StateSigner
from feedback.service.reaction_cache import ReactionRefresher
from feedback.service.runtime import FeedbackRuntime

logger = logging.getLogger("feedback.runtime")


@dataclass(frozen=True, slots=True)
class SecretFiles:
    github_app_private_key: Path
    github_client_secret: Path
    oauth_state_hmac_key: Path


def create_app(
    config: Config,
    *,
    secret_files: SecretFiles | None = None,
    clock: Callable[[], float] = time.time,
    oauth: OAuthClient | None = None,
    refresher: ReactionRefresher | None = None,
    grants: CreationGrantSigner | None = None,
    discussions: DiscussionService | None = None,
    verbose: bool = False,
) -> Starlette:
    if oauth is not None and grants is None:
        raise ValueError("OAuth and creation grants must be configured together")

    @asynccontextmanager
    async def lifespan(application: Starlette) -> AsyncIterator[None]:
        loaded = config
        owned_http: httpx.AsyncClient | None = None
        resolved_oauth: OAuthClient | None
        resolved_refresher: ReactionRefresher | None
        resolved_grants: CreationGrantSigner | None
        resolved_discussions: DiscussionService | None
        if secret_files is not None:
            owned_http = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    loaded.service.http_request_timeout_seconds,
                    connect=loaded.service.http_connect_timeout_seconds,
                ),
                follow_redirects=False,
            )
            signing_key = _secret(secret_files.oauth_state_hmac_key, "OAuth state HMAC key")
            resolved_oauth = _oauth_client(
                loaded, owned_http, clock, signing_key, secret_files.github_client_secret
            )
            resolved_grants = CreationGrantSigner(signing_key, clock=clock)
            github = _github_client(loaded, owned_http, clock, secret_files.github_app_private_key)
            resolved_refresher = ReactionRefresher(github, clock=clock)
            resolved_discussions = DiscussionService(GitHubDiscussions(github), clock=clock)
        else:
            resolved_oauth = oauth
            resolved_refresher = refresher
            resolved_grants = grants
            resolved_discussions = discussions
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
        )
        application.state.services = services
        services.start_sweeps()
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
            Route("/v1/sites/{site}/reactions", reactions, methods=["GET"]),
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
                "/v1/sites/{site}/discussion",
                discussion_content,
                methods=["GET"],
            ),
        ],
        lifespan=lifespan,
        exception_handlers={ApiError: api_error},
        middleware=[
            Middleware(SecurityHeadersMiddleware),
            Middleware(VerboseRequestMiddleware, enabled=verbose),
        ],
    )
    return application


def _oauth_client(
    config: Config,
    http: httpx.AsyncClient,
    clock: Callable[[], float],
    signing_key: bytes,
    client_secret_file: Path,
) -> OAuthClient:
    return OAuthClient(
        client_id=config.service.github_client_id,
        client_secret=_secret(client_secret_file, "GitHub client secret").decode().strip(),
        callback_url=config.service.oauth_callback,
        signer=StateSigner(signing_key, clock=clock),
        http=http,
        clock=clock,
    )


def _github_client(
    config: Config,
    http: httpx.AsyncClient,
    clock: Callable[[], float],
    private_key_file: Path,
) -> GitHubClient:
    return GitHubClient(
        app_id=config.service.github_app_id,
        private_key=_secret(private_key_file, "GitHub App private key").decode(),
        http=http,
        clock=clock,
        concurrency=config.service.github_concurrency,
    )


def _secret(secret: Path, name: str) -> bytes:
    metadata = secret.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022:
        raise RuntimeError(f"{name} must be a non-writable regular file")
    if metadata.st_size > 65_536:
        raise RuntimeError(f"{name} is too large")
    value = secret.read_bytes()
    if not value:
        raise RuntimeError(f"{name} is empty")
    return value
