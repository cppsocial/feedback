from pathlib import Path

import pytest

from feedback.config import ConfigError, load_config


def write_config(path: Path, sites: str, service_extra: str = "") -> Path:
    path.write_text(
        f"""[service]
public_origin = "https://feedback-api.cpp.social"
oauth_callback = "https://feedback.cpp.social/v1/oauth/callback.html"
data_directory = "data"
github_app_id = 123
github_client_id = "Iv1.client"
{service_extra}
{sites}
"""
    )
    return path


def site(site_id: str = "cpp-social", origin: str = "https://cpp.social") -> str:
    return f"""[sites.{site_id}]
origins = ["{origin}"]
mode = "ranking"
mapping = "key"
repository = "cppsocial/site"
repository_id = "R_repo"
installation_id = 123
default_category = "resources"
intents = ["votes"]

[sites.{site_id}.categories.resources]
name = "Resources"
id = "DIC_category"
"""


def test_loads_valid_config_and_data_override(tmp_path: Path) -> None:
    override = tmp_path / "runtime-data"
    config = load_config(write_config(tmp_path / "sites.toml", site()), data_directory=override)

    assert config.service.data_directory == override
    configured_site = config.sites["cpp-social"]
    assert configured_site.cache_fresh_seconds == 5
    assert configured_site.refresh_cooldown_seconds == 5
    assert configured_site.refresh_sweep_seconds == 86_400
    assert configured_site.max_batch_size == 100


@pytest.mark.parametrize(
    ("sites", "message"),
    [
        (site("UPPER"), "invalid site id"),
        (site(origin="http://cpp.social"), "must use HTTPS"),
        (site() + site("other"), "more than one site"),
        (site().replace('mapping = "key"', 'mapping = "anything"'), "unsupported"),
        (site().replace("default_category", "unexpected"), "unknown sites.cpp-social key"),
    ],
)
def test_rejects_unsafe_configuration(tmp_path: Path, sites: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_config(write_config(tmp_path / "sites.toml", sites))


def test_rejects_unknown_service_key(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="unknown service key"):
        load_config(write_config(tmp_path / "sites.toml", site(), "extra = true"))


def test_requires_each_site_to_declare_intents(tmp_path: Path) -> None:
    without_intents = site().replace('intents = ["votes"]\n', "")

    with pytest.raises(ConfigError, match="intents is required"):
        load_config(write_config(tmp_path / "sites.toml", without_intents))


def test_rejects_ranking_site_with_discussion_intents(tmp_path: Path) -> None:
    invalid = site().replace('intents = ["votes"]', 'intents = ["votes", "comments"]')
    with pytest.raises(ConfigError, match="requires discussion"):
        load_config(write_config(tmp_path / "sites.toml", invalid))


def test_native_upvote_intent_is_not_supported(tmp_path: Path) -> None:
    invalid = site().replace('intents = ["votes"]', 'intents = ["upvotes"]')
    with pytest.raises(ConfigError, match="unsupported intent"):
        load_config(write_config(tmp_path / "sites.toml", invalid))


def test_rejects_unknown_default_category_and_template_field(tmp_path: Path) -> None:
    unknown = site().replace('default_category = "resources"', 'default_category = "missing"')
    with pytest.raises(ConfigError, match="default_category is not configured"):
        load_config(write_config(tmp_path / "sites.toml", unknown))

    invalid_template = site().replace(
        'intents = ["votes"]', 'discussion_body = "Hello {unknown}"\nintents = ["votes"]'
    )
    with pytest.raises(ConfigError, match="may use only"):
        load_config(write_config(tmp_path / "sites.toml", invalid_template))


@pytest.mark.parametrize(
    "setting",
    [
        "github_concurrency = 0",
        "github_concurrency = 9",
        "http_connect_timeout_seconds = 31",
        "http_request_timeout_seconds = 0",
    ],
)
def test_rejects_unsafe_github_runtime_limits(tmp_path: Path, setting: str) -> None:
    with pytest.raises(ConfigError):
        load_config(write_config(tmp_path / "sites.toml", site(), setting))
