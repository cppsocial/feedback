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
mapping = "key"
repository = "cppsocial/site"
repository_id = "R_repo"
installation_id = 123
category = "Resources"
category_id = "DIC_category"
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
        (site().replace("category_id", "unexpected"), "unknown sites.cpp-social key"),
    ],
)
def test_rejects_unsafe_configuration(tmp_path: Path, sites: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_config(write_config(tmp_path / "sites.toml", sites))


def test_rejects_unknown_service_key(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="unknown service key"):
        load_config(write_config(tmp_path / "sites.toml", site(), "extra = true"))


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
