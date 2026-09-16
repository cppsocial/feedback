from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from feedback.service.oauth_state import OAuthState, StateSigner


class OAuthError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


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
        repository_id: str,
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
                    "repository_id": repository_id,
                },
            )
        except httpx.TimeoutException as exc:
            raise OAuthError("oauth_exchange_ambiguous") from exc
        if response.status_code != 200:
            raise OAuthError("oauth_exchange_failed")
        try:
            body = response.json()
        except ValueError as exc:
            raise OAuthError("oauth_exchange_failed") from exc
        if not isinstance(body, dict) or body.get("error"):
            raise OAuthError("oauth_exchange_failed")
        token = body.get("access_token")
        expires_in = body.get("expires_in")
        if (
            not isinstance(token, str)
            or not token.startswith("ghu_")
            or isinstance(expires_in, bool)
            or not isinstance(expires_in, int)
            or not 1 <= expires_in <= 8 * 60 * 60
        ):
            raise OAuthError("oauth_exchange_failed")
        return AccessToken(token, int(self._clock()) + expires_in), verified_state
