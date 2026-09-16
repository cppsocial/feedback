from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass

_BASE64URL = re.compile(r"[A-Za-z0-9_-]+\Z")


class StateError(ValueError):
    pass


class GrantError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class OAuthState:
    site: str
    origin: str
    challenge: str
    nonce: str
    issued_at: int
    expires_at: int


class StateSigner:
    def __init__(
        self,
        key: bytes,
        *,
        lifetime_seconds: int = 300,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if len(key) < 32:
            raise ValueError("state signing key must contain at least 32 bytes")
        if not 60 <= lifetime_seconds <= 600:
            raise ValueError("state lifetime must be from 60 through 600 seconds")
        self._key = key
        self._lifetime = lifetime_seconds
        self._clock = clock

    def issue(self, *, site: str, origin: str, challenge: str, nonce: str) -> str:
        _validate_protocol_values(challenge, nonce)
        issued_at = int(self._clock())
        payload = _encode(
            json.dumps(
                {
                    "v": 1,
                    "site": site,
                    "origin": origin,
                    "challenge": challenge,
                    "nonce": nonce,
                    "iat": issued_at,
                    "exp": issued_at + self._lifetime,
                },
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        )
        signature = _encode(hmac.digest(self._key, payload.encode(), "sha256"))
        return f"{payload}.{signature}"

    def verify(self, token: str, *, site: str, origin: str, verifier: str) -> OAuthState:
        try:
            payload, supplied_signature = token.split(".")
        except ValueError as exc:
            raise StateError("invalid state") from exc
        expected_signature = _encode(hmac.digest(self._key, payload.encode(), "sha256"))
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise StateError("invalid state")
        try:
            value = json.loads(_decode(payload))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise StateError("invalid state") from exc
        if not isinstance(value, dict) or set(value) != {
            "v",
            "site",
            "origin",
            "challenge",
            "nonce",
            "iat",
            "exp",
        }:
            raise StateError("invalid state")
        if value["v"] != 1 or value["site"] != site or value["origin"] != origin:
            raise StateError("state binding mismatch")
        if not isinstance(value["iat"], int) or not isinstance(value["exp"], int):
            raise StateError("invalid state")
        now = int(self._clock())
        if value["iat"] > now + 30 or value["exp"] < now or value["exp"] - value["iat"] > 600:
            raise StateError("state expired")
        challenge = value["challenge"]
        nonce = value["nonce"]
        if not isinstance(challenge, str) or not isinstance(nonce, str):
            raise StateError("invalid state")
        _validate_protocol_values(challenge, nonce)
        if not hmac.compare_digest(pkce_challenge(verifier), challenge):
            raise StateError("PKCE verification failed")
        return OAuthState(site, origin, challenge, nonce, value["iat"], value["exp"])


class CreationGrantSigner:
    def __init__(
        self,
        key: bytes,
        *,
        lifetime_seconds: int = 300,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if len(key) < 32:
            raise ValueError("grant signing key must contain at least 32 bytes")
        if not 60 <= lifetime_seconds <= 600:
            raise ValueError("grant lifetime must be from 60 through 600 seconds")
        self._key = hmac.digest(key, b"discussion-creation-grant", "sha256")
        self._lifetime = lifetime_seconds
        self._clock = clock

    def issue(self, *, site: str, origin: str, nonce: str) -> str:
        issued_at = int(self._clock())
        payload = _encode(
            json.dumps(
                {
                    "v": 1,
                    "site": site,
                    "origin": origin,
                    "nonce": nonce,
                    "iat": issued_at,
                    "exp": issued_at + self._lifetime,
                },
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        )
        signature = _encode(hmac.digest(self._key, payload.encode(), "sha256"))
        return f"{payload}.{signature}"

    def verify(self, token: str, *, site: str, origin: str) -> None:
        try:
            payload, supplied_signature = token.split(".")
            expected_signature = _encode(hmac.digest(self._key, payload.encode(), "sha256"))
            if not hmac.compare_digest(supplied_signature, expected_signature):
                raise GrantError("invalid creation grant")
            value = json.loads(_decode(payload))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GrantError("invalid creation grant") from exc
        if not isinstance(value, dict) or set(value) != {
            "v",
            "site",
            "origin",
            "nonce",
            "iat",
            "exp",
        }:
            raise GrantError("invalid creation grant")
        now = int(self._clock())
        if (
            value["v"] != 1
            or value["site"] != site
            or value["origin"] != origin
            or not isinstance(value["iat"], int)
            or not isinstance(value["exp"], int)
            or value["iat"] > now + 30
            or value["exp"] < now
            or value["exp"] - value["iat"] > 600
        ):
            raise GrantError("invalid creation grant")


def pkce_challenge(verifier: str) -> str:
    if not 43 <= len(verifier) <= 128 or not _BASE64URL.fullmatch(verifier):
        raise StateError("invalid PKCE verifier")
    return _encode(hashlib.sha256(verifier.encode()).digest())


def _validate_protocol_values(challenge: str, nonce: str) -> None:
    if len(challenge) != 43 or not _BASE64URL.fullmatch(challenge):
        raise StateError("invalid PKCE challenge")
    if not 22 <= len(nonce) <= 128 or not _BASE64URL.fullmatch(nonce):
        raise StateError("invalid nonce")


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _decode(value: str) -> str:
    if not _BASE64URL.fullmatch(value):
        raise ValueError
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
