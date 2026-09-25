import json
from dataclasses import replace

from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config, KnownDiscussionConfig


def test_configured_known_discussion_is_available_with_a_fresh_database(config: Config) -> None:
    site = config.sites["cpp-social"]
    configured = replace(
        config,
        sites={
            "cpp-social": replace(
                site,
                known_discussions=(
                    KnownDiscussionConfig(
                        "feedback/example", "D_example", 7, "resources", "feedback/example"
                    ),
                ),
            )
        },
    )

    with TestClient(create_app(configured)) as client:
        response = client.get("/v1/sites/cpp-social/reactions?keys=feedback/example")

    assert response.json()["items"]["feedback/example"] == {
        "id": "D_example",
        "up": 0,
        "down": 0,
    }


def test_reactions_returns_sorted_deduplicated_cached_and_unknown_items(
    config: Config,
) -> None:
    app = create_app(config, clock=lambda: 1_100)
    with TestClient(app) as client:
        app.state.services.databases["cpp-social"].put_discussion(
            resource_id="known",
            lookup_term="known",
            node_id="D_known",
            number=1,
            title="Known",
            url="https://github.com/cppsocial/site/discussions/1",
            up=4,
            down=1,
            fetched_at=1_000,
        )
        response = client.get(
            "/v1/sites/cpp-social/reactions?keys=unknown,known,known",
            headers={"Origin": "https://cpp.social"},
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://cpp.social"
    assert response.headers["cache-control"] == "no-cache"
    assert list(response.json()["items"]) == ["known", "unknown"]
    assert response.json()["items"]["known"] == {
        "id": "D_known",
        "up": 4,
        "down": 1,
    }
    assert response.json()["items"]["unknown"]["id"] is None


def test_reactions_honors_etag(config: Config) -> None:
    with TestClient(create_app(config)) as client:
        first = client.get("/v1/sites/cpp-social/reactions?keys=a")
        second = client.get(
            "/v1/sites/cpp-social/reactions?keys=a",
            headers={"If-None-Match": first.headers["etag"]},
        )

    assert first.status_code == 200
    assert second.status_code == 304
    assert second.content == b""


def test_reactions_preflight_is_explicit_and_origin_scoped(config: Config) -> None:
    with TestClient(create_app(config)) as client:
        allowed = client.options(
            "/v1/sites/cpp-social/reactions",
            headers={"Origin": "https://cpp.social"},
        )
        denied = client.options(
            "/v1/sites/cpp-social/reactions",
            headers={"Origin": "https://attacker.example"},
        )

    assert allowed.status_code == 204
    assert allowed.headers["access-control-allow-methods"] == "GET"
    assert denied.status_code == 403


def test_reactions_rejects_cross_site_origin(config: Config) -> None:
    with TestClient(create_app(config)) as client:
        response = client.get(
            "/v1/sites/cpp-social/reactions?keys=a",
            headers={"Origin": "https://attacker.example"},
        )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "origin_not_allowed"
    assert "access-control-allow-origin" not in response.headers


def test_reactions_rejects_invalid_and_empty_keys(config: Config) -> None:
    with TestClient(create_app(config)) as client:
        invalid = client.get("/v1/sites/cpp-social/reactions?keys=../secret")
        empty = client.get("/v1/sites/cpp-social/reactions?keys=")

    assert invalid.status_code == 400
    assert empty.status_code == 400


def test_only_api_routes_are_served(config: Config) -> None:
    with TestClient(create_app(config), follow_redirects=False) as client:
        root = client.get("/")
        docs = client.get("/docs")
        schema = client.get("/openapi.json")
        head = client.head("/v1/sites/cpp-social/reactions?keys=a")
        trailing_slash = client.get("/v1/sites/cpp-social/reactions/?keys=a")

    assert (root.status_code, docs.status_code, schema.status_code) == (404, 404, 404)
    assert head.status_code == 405
    assert trailing_slash.status_code == 404


def test_json_response_is_compact(config: Config) -> None:
    with TestClient(create_app(config)) as client:
        response = client.get("/v1/sites/cpp-social/reactions?keys=a")

    assert (
        response.content
        == json.dumps(response.json(), separators=(",", ":"), sort_keys=True).encode()
    )
