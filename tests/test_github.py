from datetime import UTC, datetime

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from feedback.protocol.github.client import GitHubClient, GitHubError


def pem_private_key() -> str:
    from cryptography.hazmat.primitives import serialization

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def test_app_jwt_has_bounded_clock_skew() -> None:
    client = GitHubClient(
        app_id=123,
        private_key=pem_private_key(),
        http=httpx.AsyncClient(),
        clock=lambda: 10_000,
    )

    claims = jwt.decode(client.app_jwt(), options={"verify_signature": False})

    assert claims == {"iat": 9_940, "exp": 10_480, "iss": "123"}


@pytest.mark.asyncio
async def test_installation_tokens_are_cached() -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        assert request.url.path == "/app/installations/7/access_tokens"
        return httpx.Response(
            201,
            json={"token": "ghs_secret", "expires_at": "2030-01-01T00:00:00Z"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = GitHubClient(
            app_id=123, private_key=pem_private_key(), http=http, clock=lambda: 1_000
        )
        first = await client.installation_token(7)
        second = await client.installation_token(7)

    assert first == second == "ghs_secret"
    assert requests == 1


@pytest.mark.asyncio
async def test_graphql_refreshes_once_after_unauthorized() -> None:
    token_requests = 0
    graphql_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_requests, graphql_requests
        if request.url.path.endswith("access_tokens"):
            token_requests += 1
            return httpx.Response(
                201,
                json={
                    "token": f"ghs_{token_requests}",
                    "expires_at": datetime(2030, 1, 1, tzinfo=UTC).isoformat(),
                },
            )
        graphql_requests += 1
        if graphql_requests == 1:
            return httpx.Response(401, json={"message": "Bad credentials"})
        assert request.headers["authorization"] == "Bearer ghs_2"
        return httpx.Response(200, json={"data": {"viewer": {"login": "octocat"}}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = GitHubClient(
            app_id=123, private_key=pem_private_key(), http=http, clock=lambda: 1_000
        )
        result = await client.graphql(7, "query { viewer { login } }", {})

    assert result["viewer"]["login"] == "octocat"
    assert token_requests == 2
    assert graphql_requests == 2


@pytest.mark.asyncio
async def test_rate_limit_blocks_requests_until_retry_window_expires() -> None:
    now = 1_000.0
    graphql_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal graphql_requests
        if request.url.path.endswith("access_tokens"):
            return httpx.Response(
                201,
                json={"token": "ghs_token", "expires_at": "2030-01-01T00:00:00Z"},
            )
        graphql_requests += 1
        return httpx.Response(429, headers={"Retry-After": "120"}, json={"message": "slow down"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = GitHubClient(
            app_id=123, private_key=pem_private_key(), http=http, clock=lambda: now
        )
        with pytest.raises(GitHubError, match="github_rate_limited") as first:
            await client.graphql(7, "query { viewer { login } }", {})
        with pytest.raises(GitHubError, match="github_rate_limited") as blocked:
            await client.graphql(7, "query { viewer { login } }", {})

    assert first.value.retry_after == 120
    assert blocked.value.retry_after == 120
    assert graphql_requests == 1
