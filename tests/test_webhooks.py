import hashlib
import hmac
import json
import logging
from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from feedback.app import create_app
from feedback.config import Config
from feedback.service.category_pins import CategoryPinRefresher


def test_webhook_route_is_closed_without_a_secret(config: Config) -> None:
    with TestClient(create_app(config)) as client:
        assert client.post("/v1/github/webhook", json={}).status_code == 404


def test_signed_pin_event_logs_and_expires_category_snapshot(
    config: Config, caplog: pytest.LogCaptureFixture
) -> None:
    site = config.sites["cpp-social"]
    configured = replace(
        config,
        sites={"cpp-social": replace(site, intents=frozenset({"votes", "category_pins"}))},
    )
    secret = b"webhook-test-secret"
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
    pins = CategoryPinRefresher(http, clock=lambda: 1000)
    app = create_app(configured, pins=pins, webhook_secret=secret)
    payload = {
        "action": "pinned",
        "repository": {"full_name": "cppsocial/site"},
        "installation": {"id": site.installation_id},
        "discussion": {
            "number": 3,
            "node_id": "D_3",
            "category": {"name": "Resources"},
        },
    }
    body = json.dumps(payload).encode()
    signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    headers = {
        "content-type": "application/json",
        "x-github-event": "discussion",
        "x-github-delivery": "12345678-1234-1234-1234-123456789abc",
        "x-hub-signature-256": signature,
    }
    caplog.set_level(logging.INFO, logger="feedback.webhook")
    with TestClient(app) as client:
        database = app.state.services.databases[site.id]
        database.replace_category_pins("resources", {3}, None, 1000)
        assert client.post("/v1/github/webhook", content=body, headers=headers).status_code == 204
        assert database.pin_snapshot("resources") == (0, None)
        assert client.post("/v1/github/webhook", content=body, headers=headers).status_code == 204
        assert database.pin_snapshot("resources") == (0, None)
        assert (
            client.post(
                "/v1/github/webhook",
                content=body,
                headers={**headers, "x-hub-signature-256": "bad"},
            ).status_code
            == 401
        )
        comment_payload = {**payload, "action": "created"}
        comment_body = json.dumps(comment_payload).encode()
        comment_headers = {
            **headers,
            "x-github-event": "discussion_comment",
            "x-github-delivery": "12345678-1234-1234-1234-123456789abd",
            "x-hub-signature-256": "sha256="
            + hmac.new(secret, comment_body, hashlib.sha256).hexdigest(),
        }
        assert (
            client.post(
                "/v1/github/webhook", content=comment_body, headers=comment_headers
            ).status_code
            == 204
        )
        ping_body = b'{"zen":"ready"}'
        ping_headers = {
            **headers,
            "x-github-event": "ping",
            "x-github-delivery": "12345678-1234-1234-1234-123456789abe",
            "x-hub-signature-256": "sha256="
            + hmac.new(secret, ping_body, hashlib.sha256).hexdigest(),
        }
        assert (
            client.post("/v1/github/webhook", content=ping_body, headers=ping_headers).status_code
            == 204
        )
        database.replace_category_pins("resources", {3}, None, 1000)
        foreign_body = json.dumps(
            {**payload, "repository": {"full_name": "another/repository"}}
        ).encode()
        foreign_headers = {
            **headers,
            "x-github-delivery": "12345678-1234-1234-1234-123456789abf",
            "x-hub-signature-256": "sha256="
            + hmac.new(secret, foreign_body, hashlib.sha256).hexdigest(),
        }
        assert (
            client.post(
                "/v1/github/webhook", content=foreign_body, headers=foreign_headers
            ).status_code
            == 204
        )
        assert database.pin_snapshot("resources") == (1000, None)
    assert "action=pinned" in caplog.text
    assert "category='Resources'" in caplog.text
    assert "event=discussion_comment action=created" in caplog.text
    assert "event=ping" in caplog.text
