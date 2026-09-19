from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
import jwt

logger = logging.getLogger("feedback.github")


class GitHubError(RuntimeError):
    def __init__(
        self,
        code: str,
        *,
        status: int | None = None,
        request_id: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.retry_after = retry_after


@dataclass(frozen=True, slots=True)
class InstallationToken:
    value: str
    expires_at: float


class GitHubClient:
    def __init__(
        self,
        *,
        app_id: int,
        private_key: str,
        http: httpx.AsyncClient,
        clock: Callable[[], float] = time.time,
        concurrency: int = 2,
    ) -> None:
        if not 1 <= concurrency <= 8:
            raise ValueError("concurrency must be from 1 through 8")
        self._app_id = app_id
        self._private_key = private_key
        self._http = http
        self._clock = clock
        self._tokens: dict[int, InstallationToken] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._requests = asyncio.Semaphore(concurrency)
        self._rate_limited_until = 0.0
        self._rate_limit_failures = 0

    def app_jwt(self) -> str:
        now = int(self._clock())
        return jwt.encode(
            {"iat": now - 60, "exp": now + 8 * 60, "iss": str(self._app_id)},
            self._private_key,
            algorithm="RS256",
        )

    async def installation_token(self, installation_id: int) -> str:
        cached = self._tokens.get(installation_id)
        if cached is not None and cached.expires_at - self._clock() > 300:
            return cached.value
        lock = self._locks.setdefault(installation_id, asyncio.Lock())
        async with lock:
            cached = self._tokens.get(installation_id)
            if cached is not None and cached.expires_at - self._clock() > 300:
                return cached.value
            token = await self._request_installation_token(installation_id)
            self._tokens[installation_id] = token
            return token.value

    async def graphql(
        self, installation_id: int, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]:
        token = await self.installation_token(installation_id)
        response = await self._graphql_request(token, query, variables)
        if response.status_code == 401:
            self._tokens.pop(installation_id, None)
            token = await self.installation_token(installation_id)
            response = await self._graphql_request(token, query, variables)
        data = _json_object(response)
        if response.status_code >= 400:
            raise _response_error(response, "github_http_error")
        if data.get("errors"):
            raise _response_error(response, "github_graphql_error")
        result = data.get("data")
        if not isinstance(result, dict):
            raise _response_error(response, "github_malformed_response")
        return result

    async def graphql_as_user(
        self, token: str, query: str, variables: Mapping[str, object]
    ) -> dict[str, Any]:
        response = await self._graphql_request(token, query, variables)
        data = _json_object(response)
        if response.status_code >= 400:
            raise _response_error(response, "github_http_error")
        if data.get("errors"):
            raise _response_error(response, "github_graphql_error")
        result = data.get("data")
        if not isinstance(result, dict):
            raise _response_error(response, "github_malformed_response")
        return result

    async def _request_installation_token(self, installation_id: int) -> InstallationToken:
        self._raise_if_rate_limited()
        response = await self._installation_token_request(installation_id)
        if response.status_code == 401:
            logger.warning(
                "GitHub App bearer token rejected; retrying once: status=401 "
                "github_request_id=%s installation_id=%s",
                response.headers.get("x-github-request-id"),
                installation_id,
            )
            response = await self._installation_token_request(installation_id)
        if response.status_code != 201:
            raise self._error(response, "installation_token_failed")
        self._rate_limit_failures = 0
        data = _json_object(response)
        value = data.get("token")
        expires = data.get("expires_at")
        if not isinstance(value, str) or not isinstance(expires, str):
            raise _response_error(response, "github_malformed_response")
        try:
            expires_at = datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp()
        except ValueError as exc:
            raise _response_error(response, "github_malformed_response") from exc
        return InstallationToken(value, expires_at)

    async def _installation_token_request(self, installation_id: int) -> httpx.Response:
        async with self._requests:
            try:
                return await self._http.post(
                    f"https://api.github.com/app/installations/{installation_id}/access_tokens",
                    headers={
                        "Accept": "application/vnd.github+json",
                        "Authorization": f"Bearer {self.app_jwt()}",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                )
            except httpx.TimeoutException as exc:
                raise GitHubError("github_timeout") from exc
            except httpx.RequestError as exc:
                raise GitHubError("github_transport_error") from exc

    async def _graphql_request(
        self, token: str, query: str, variables: Mapping[str, object]
    ) -> httpx.Response:
        self._raise_if_rate_limited()
        async with self._requests:
            try:
                response = await self._http.post(
                    "https://api.github.com/graphql",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"query": query, "variables": variables},
                )
            except httpx.TimeoutException as exc:
                raise GitHubError("github_timeout") from exc
            except httpx.RequestError as exc:
                raise GitHubError("github_transport_error") from exc
        if _is_rate_limited(response):
            raise self._error(response, "github_rate_limited")
        self._rate_limit_failures = 0
        return response

    def _raise_if_rate_limited(self) -> None:
        remaining = self._rate_limited_until - self._clock()
        if remaining > 0:
            raise GitHubError("github_rate_limited", retry_after=remaining)

    def _error(self, response: httpx.Response, code: str) -> GitHubError:
        retry_after = _retry_after(response, self._clock())
        if retry_after is not None:
            self._rate_limit_failures += 1
            delay = max(retry_after, min(60 * 2 ** (self._rate_limit_failures - 1), 900))
            self._rate_limited_until = self._clock() + delay
            return _response_error(response, code, retry_after=delay)
        return _response_error(response, code)


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError as exc:
        raise _response_error(response, "github_malformed_response") from exc
    if not isinstance(value, dict):
        raise _response_error(response, "github_malformed_response")
    return value


def _response_error(
    response: httpx.Response, code: str, *, retry_after: float | None = None
) -> GitHubError:
    return GitHubError(
        code,
        status=response.status_code,
        request_id=response.headers.get("x-github-request-id"),
        retry_after=retry_after,
    )


def _is_rate_limited(response: httpx.Response) -> bool:
    return response.status_code == 429 or (
        response.status_code == 403
        and (
            "retry-after" in response.headers
            or response.headers.get("x-ratelimit-remaining") == "0"
        )
    )


def _retry_after(response: httpx.Response, now: float) -> float | None:
    if not _is_rate_limited(response):
        return None
    retry = response.headers.get("retry-after")
    if retry is not None:
        try:
            return max(1.0, float(retry))
        except ValueError:
            pass
    reset = response.headers.get("x-ratelimit-reset")
    if reset is not None:
        try:
            return max(1.0, float(reset) - now)
        except ValueError:
            pass
    return 60.0
