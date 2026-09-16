from __future__ import annotations

import os
import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any
from urllib.parse import urlsplit


class ConfigError(ValueError):
    pass


_SITE_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_MAPPINGS = frozenset({"id", "title", "url", "pathname", "specific", "number"})
_SERVICE_KEYS = frozenset(
    {
        "public_origin",
        "oauth_callback",
        "data_directory",
        "github_app_id",
        "github_client_id",
        "github_concurrency",
        "http_connect_timeout_seconds",
        "http_request_timeout_seconds",
    }
)
_SITE_KEYS = frozenset(
    {
        "origins",
        "mapping",
        "repository",
        "repository_id",
        "installation_id",
        "category",
        "category_id",
        "cache_fresh_seconds",
        "cache_stale_seconds",
        "refresh_cooldown_seconds",
        "max_batch_size",
    }
)


@dataclass(frozen=True, slots=True)
class ServiceConfig:
    public_origin: str
    oauth_callback: str
    data_directory: Path
    github_app_id: int
    github_client_id: str
    github_concurrency: int = 2
    http_connect_timeout_seconds: int = 3
    http_request_timeout_seconds: int = 10


@dataclass(frozen=True, slots=True)
class SiteConfig:
    id: str
    origins: tuple[str, ...]
    mapping: str
    repository: str
    repository_id: str
    installation_id: int
    category: str
    category_id: str
    cache_fresh_seconds: int = 60
    cache_stale_seconds: int = 900
    refresh_cooldown_seconds: int = 15
    max_batch_size: int = 100


@dataclass(frozen=True, slots=True)
class Config:
    service: ServiceConfig
    sites: Mapping[str, SiteConfig]


def load_config(path: Path | str, *, data_directory: Path | None = None) -> Config:
    config_path = Path(path)
    try:
        with config_path.open("rb") as stream:
            raw = tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"cannot read configuration: {exc}") from exc

    _reject_keys(raw, {"service", "sites"}, "configuration")
    service_raw = _table(raw, "service")
    sites_raw = _table(raw, "sites")
    _reject_keys(service_raw, _SERVICE_KEYS, "service")

    public_origin = _origin(_string(service_raw, "public_origin"), "service.public_origin")
    callback = _absolute_https_url(_string(service_raw, "oauth_callback"), "service.oauth_callback")
    configured_data = data_directory or Path(_string(service_raw, "data_directory"))
    service = ServiceConfig(
        public_origin=public_origin,
        oauth_callback=callback,
        data_directory=configured_data,
        github_app_id=_bounded_int(service_raw, "github_app_id", 1, 2**63 - 1),
        github_client_id=_string(service_raw, "github_client_id"),
        github_concurrency=_bounded_int(service_raw, "github_concurrency", 1, 8, 2),
        http_connect_timeout_seconds=_bounded_int(
            service_raw, "http_connect_timeout_seconds", 1, 30, 3
        ),
        http_request_timeout_seconds=_bounded_int(
            service_raw, "http_request_timeout_seconds", 1, 60, 10
        ),
    )

    if not sites_raw:
        raise ConfigError("at least one site must be configured")
    origins: set[str] = set()
    sites: dict[str, SiteConfig] = {}
    for site_id, value in sites_raw.items():
        if not isinstance(site_id, str) or not _SITE_ID.fullmatch(site_id):
            raise ConfigError(f"invalid site id: {site_id!r}")
        if not isinstance(value, dict):
            raise ConfigError(f"sites.{site_id} must be a table")
        _reject_keys(value, _SITE_KEYS, f"sites.{site_id}")
        site_origins = tuple(
            _origin(item, f"sites.{site_id}.origins") for item in _string_list(value, "origins")
        )
        if not site_origins:
            raise ConfigError(f"sites.{site_id}.origins must not be empty")
        duplicates = origins.intersection(site_origins)
        if duplicates:
            raise ConfigError(f"origin is assigned to more than one site: {min(duplicates)}")
        if len(set(site_origins)) != len(site_origins):
            raise ConfigError(f"sites.{site_id}.origins contains duplicates")
        origins.update(site_origins)

        mapping = _string(value, "mapping")
        if mapping not in _MAPPINGS:
            raise ConfigError(f"sites.{site_id}.mapping is unsupported")
        repository = _string(value, "repository")
        if repository.count("/") != 1 or any(not part for part in repository.split("/")):
            raise ConfigError(f"sites.{site_id}.repository must be owner/name")

        sites[site_id] = SiteConfig(
            id=site_id,
            origins=site_origins,
            mapping=mapping,
            repository=repository,
            repository_id=_string(value, "repository_id"),
            installation_id=_bounded_int(value, "installation_id", 1, 2**63 - 1),
            category=_string(value, "category"),
            category_id=_string(value, "category_id"),
            cache_fresh_seconds=_bounded_int(value, "cache_fresh_seconds", 1, 3600, 60),
            cache_stale_seconds=_bounded_int(value, "cache_stale_seconds", 1, 86400, 900),
            refresh_cooldown_seconds=_bounded_int(value, "refresh_cooldown_seconds", 1, 3600, 15),
            max_batch_size=_bounded_int(value, "max_batch_size", 1, 100, 100),
        )
        if sites[site_id].cache_stale_seconds < sites[site_id].cache_fresh_seconds:
            raise ConfigError(f"sites.{site_id} stale lifetime must be at least fresh lifetime")

    return Config(service, MappingProxyType(sites))


def load_config_from_environment() -> Config:
    path = Path(os.environ.get("FEEDBACK_CONFIG", "/run/config/sites.toml"))
    override = os.environ.get("FEEDBACK_DATA_DIRECTORY")
    return load_config(path, data_directory=Path(override) if override else None)


def _table(value: Mapping[str, Any], key: str) -> dict[str, Any]:
    result = value.get(key)
    if not isinstance(result, dict):
        raise ConfigError(f"{key} must be a table")
    return result


def _reject_keys(value: Mapping[str, Any], allowed: set[str] | frozenset[str], name: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ConfigError(f"unknown {name} key: {min(unknown)}")


def _string(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result or len(result) > 512:
        raise ConfigError(f"{key} must be a non-empty string")
    return result


def _string_list(value: Mapping[str, Any], key: str) -> list[str]:
    result = value.get(key)
    if not isinstance(result, list) or any(not isinstance(item, str) for item in result):
        raise ConfigError(f"{key} must be an array of strings")
    return result


def _bounded_int(
    value: Mapping[str, Any],
    key: str,
    minimum: int,
    maximum: int,
    default: int | None = None,
) -> int:
    result = value.get(key, default)
    if isinstance(result, bool) or not isinstance(result, int) or not minimum <= result <= maximum:
        raise ConfigError(f"{key} must be an integer from {minimum} through {maximum}")
    return result


def _origin(value: str, name: str) -> str:
    parsed = urlsplit(value)
    if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ConfigError(f"{name} must be an origin without path, query, or credentials")
    _validate_scheme_and_host(parsed.scheme, parsed.hostname, name)
    return value.rstrip("/")


def _absolute_https_url(value: str, name: str) -> str:
    parsed = urlsplit(value)
    _validate_scheme_and_host(parsed.scheme, parsed.hostname, name)
    if (
        parsed.username
        or parsed.password
        or not parsed.path.startswith("/")
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigError(f"{name} must be an absolute URL without credentials")
    return value


def _validate_scheme_and_host(scheme: str, hostname: str | None, name: str) -> None:
    development_http = scheme == "http" and hostname in {
        "localhost",
        "127.0.0.1",
        "::1",
    }
    if not hostname or (scheme != "https" and not development_http):
        raise ConfigError(f"{name} must use HTTPS (HTTP is allowed only for localhost)")
