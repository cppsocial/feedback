from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config
from feedback.protocol.github.oauth import OAuthClient
from feedback.service.oauth_state import CreationGrantSigner, StateSigner, pkce_challenge

VERIFIER = "v" * 43
NONCE = "n" * 22


def test_authorize_and_exchange_are_stateless_and_origin_bound(config: Config) -> None:
    exchanged: dict[str, list[str]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal exchanged
        exchanged = parse_qs(request.content.decode())
        return httpx.Response(200, json={"access_token": "ghu_user", "expires_in": 28_800})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    oauth = OAuthClient(
        client_id="Iv1.client",
        client_secret="client-secret",
        callback_url=config.service.oauth_callback,
        signer=StateSigner(b"k" * 32, clock=lambda: 1_000),
        http=http,
        clock=lambda: 1_000,
    )
    grants = CreationGrantSigner(b"k" * 32, clock=lambda: 1_000)
    with TestClient(create_app(config, clock=lambda: 1_000, oauth=oauth, grants=grants)) as client:
        authorize = client.post(
            "/v1/sites/cpp-social/oauth/authorize",
            headers={"Origin": "https://cpp.social"},
            json={"challenge": pkce_challenge(VERIFIER), "nonce": NONCE},
        )
        state = authorize.json()["state"]
        exchange = client.post(
            "/v1/sites/cpp-social/oauth/exchange",
            headers={"Origin": "https://cpp.social"},
            json={"code": "temporary-code", "state": state, "verifier": VERIFIER},
        )

    assert authorize.status_code == 200
    query = parse_qs(urlsplit(authorize.json()["authorization_url"]).query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == [state]
    assert exchange.json()["access_token"] == "ghu_user"
    assert exchange.json()["expires_at"] == 29_800
    grants.verify(
        exchange.json()["creation_grant"],
        site="cpp-social",
        origin="https://cpp.social",
    )
    assert exchange.headers["cache-control"] == "no-store, private"
    assert "repository_id" not in exchanged


def test_exchange_bounds_nonexpiring_github_token_to_eight_hours(config: Config) -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"access_token": "ghu_user"})
        )
    )
    oauth = OAuthClient(
        client_id="Iv1.client",
        client_secret="client-secret",
        callback_url=config.service.oauth_callback,
        signer=StateSigner(b"k" * 32, clock=lambda: 1_000),
        http=http,
        clock=lambda: 1_000,
    )
    grants = CreationGrantSigner(b"k" * 32, clock=lambda: 1_000)
    with TestClient(create_app(config, clock=lambda: 1_000, oauth=oauth, grants=grants)) as client:
        authorize = client.post(
            "/v1/sites/cpp-social/oauth/authorize",
            headers={"Origin": "https://cpp.social"},
            json={"challenge": pkce_challenge(VERIFIER), "nonce": NONCE},
        )
        exchange = client.post(
            "/v1/sites/cpp-social/oauth/exchange",
            headers={"Origin": "https://cpp.social"},
            json={
                "code": "temporary-code",
                "state": authorize.json()["state"],
                "verifier": VERIFIER,
            },
        )

    assert exchange.status_code == 200
    assert exchange.json()["expires_at"] == 29_800


def test_exchange_logs_safe_upstream_failure_details(
    config: Config, caplog: pytest.LogCaptureFixture
) -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                headers={"x-github-request-id": "request-123"},
                json={"error": "bad_verification_code", "error_description": "secret detail"},
            )
        )
    )
    oauth = OAuthClient(
        client_id="Iv1.client",
        client_secret="client-secret",
        callback_url=config.service.oauth_callback,
        signer=StateSigner(b"k" * 32, clock=lambda: 1_000),
        http=http,
        clock=lambda: 1_000,
    )
    grants = CreationGrantSigner(b"k" * 32, clock=lambda: 1_000)
    with TestClient(create_app(config, clock=lambda: 1_000, oauth=oauth, grants=grants)) as client:
        authorize = client.post(
            "/v1/sites/cpp-social/oauth/authorize",
            headers={"Origin": "https://cpp.social"},
            json={"challenge": pkce_challenge(VERIFIER), "nonce": NONCE},
        )
        response = client.post(
            "/v1/sites/cpp-social/oauth/exchange",
            headers={"Origin": "https://cpp.social"},
            json={
                "code": "temporary-code",
                "state": authorize.json()["state"],
                "verifier": VERIFIER,
            },
        )

    assert response.status_code == 400
    assert "upstream_code=bad_verification_code" in caplog.text
    assert "github_request_id=request-123" in caplog.text
    assert "secret detail" not in caplog.text


def test_oauth_rejects_origin_content_type_and_duplicate_fields(config: Config) -> None:
    oauth = OAuthClient(
        client_id="Iv1.client",
        client_secret="client-secret",
        callback_url=config.service.oauth_callback,
        signer=StateSigner(b"k" * 32),
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
    )
    grants = CreationGrantSigner(b"k" * 32)
    with TestClient(create_app(config, oauth=oauth, grants=grants)) as client:
        origin = client.post(
            "/v1/sites/cpp-social/oauth/authorize",
            headers={"Origin": "https://attacker.example"},
            json={"challenge": pkce_challenge(VERIFIER), "nonce": NONCE},
        )
        content_type = client.post(
            "/v1/sites/cpp-social/oauth/authorize",
            headers={"Origin": "https://cpp.social"},
            content=b"{}",
        )
        duplicate = client.post(
            "/v1/sites/cpp-social/oauth/authorize",
            headers={"Origin": "https://cpp.social", "Content-Type": "application/json"},
            content=(
                f'{{"challenge":"{pkce_challenge(VERIFIER)}",'
                f'"challenge":"{pkce_challenge(VERIFIER)}","nonce":"{NONCE}"}}'
            ),
        )

    assert origin.status_code == 403
    assert content_type.status_code == 415
    assert duplicate.status_code == 400


def test_oauth_preflight_is_tenant_scoped(config: Config) -> None:
    oauth = OAuthClient(
        client_id="Iv1.client",
        client_secret="client-secret",
        callback_url=config.service.oauth_callback,
        signer=StateSigner(b"k" * 32),
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
    )
    grants = CreationGrantSigner(b"k" * 32)
    with TestClient(create_app(config, oauth=oauth, grants=grants)) as client:
        response = client.options(
            "/v1/sites/cpp-social/oauth/exchange",
            headers={"Origin": "https://cpp.social"},
        )

    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "https://cpp.social"
    assert response.headers["access-control-allow-headers"] == "Content-Type"
