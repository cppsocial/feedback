from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from feedback.service.oauth_state import OAuthState, StateSigner


class OAuthError(RuntimeError):
    def __init__(
        self,
        code: str,
        *,
        reason: str,
        status: int | None = None,
        upstream_code: str | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.reason = reason
        self.status = status
        self.upstream_code = upstream_code
        self.request_id = request_id


@dataclass(frozen=True, slots=True)
class AccessToken:
    value: str
    expires_at: int


class OAuthClient:
    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        callback_url: str,
        signer: StateSigner,
        http: httpx.AsyncClient,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._callback_url = callback_url
        self._signer = signer
        self._http = http
        self._clock = clock

    def authorization_url(
        self, *, site: str, origin: str, challenge: str, nonce: str
    ) -> tuple[str, str]:
        state = self._signer.issue(site=site, origin=origin, challenge=challenge, nonce=nonce)
        query = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": self._callback_url,
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"https://github.com/login/oauth/authorize?{query}", state

    async def exchange(
        self,
        *,
        site: str,
        origin: str,
        code: str,
        state: str,
        verifier: str,
    ) -> tuple[AccessToken, OAuthState]:
        verified_state = self._signer.verify(state, site=site, origin=origin, verifier=verifier)
        try:
            response = await self._http.post(
                "https://github.com/login/oauth/access_token",
                headers={"Accept": "application/json"},
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "code": code,
                    "redirect_uri": self._callback_url,
                    "code_verifier": verifier,
                },
            )
        except httpx.TimeoutException as exc:
            raise OAuthError("oauth_exchange_ambiguous", reason="timeout") from exc
        except httpx.RequestError as exc:
            raise OAuthError("oauth_exchange_failed", reason="transport_error") from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise OAuthError(
                "oauth_exchange_failed",
                reason="invalid_json",
                status=response.status_code,
                request_id=response.headers.get("x-github-request-id"),
            ) from exc
        if not isinstance(body, dict):
            raise OAuthError(
                "oauth_exchange_failed",
                reason="invalid_payload",
                status=response.status_code,
                request_id=response.headers.get("x-github-request-id"),
            )
        upstream_code = body.get("error")
        if response.status_code != 200 or isinstance(upstream_code, str):
            raise OAuthError(
                "oauth_exchange_failed",
                reason="upstream_rejected",
                status=response.status_code,
                upstream_code=upstream_code if isinstance(upstream_code, str) else None,
                request_id=response.headers.get("x-github-request-id"),
            )
        token = body.get("access_token")
        expires_in = body.get("expires_in")
        # GitHub Apps may disable expiring user access tokens. Such responses do
        # not include expires_in; keep our browser session bounded to eight hours.
        if expires_in is None:
            expires_in = 8 * 60 * 60
        if (
            not isinstance(token, str)
            or not token.startswith("ghu_")
            or isinstance(expires_in, bool)
            or not isinstance(expires_in, int)
            or not 1 <= expires_in <= 8 * 60 * 60
        ):
            raise OAuthError(
                "oauth_exchange_failed",
                reason="invalid_token_payload",
                status=response.status_code,
                request_id=response.headers.get("x-github-request-id"),
            )
        return AccessToken(token, int(self._clock()) + expires_in), verified_state
