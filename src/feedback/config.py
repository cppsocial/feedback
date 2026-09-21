from __future__ import annotations

import re
import string
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any
from urllib.parse import urlsplit

from feedback.service.resources import ResourceError, validate_resource_id


class ConfigError(ValueError):
    pass


_SITE_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_MAPPINGS = frozenset({"key", "title", "url", "pathname", "custom", "number"})
_REACTIONS = frozenset(
    {"THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"}
)
_INTENTS = frozenset(
    {
        "upvotes",
        "reactions",
        "discussion",
        "comments",
        "answers",
        "polls",
        "authors",
        "moderation",
        "comment_reactions",
        "comment_upvotes",
        "labels",
        "github_link",
    }
)
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
        "mode",
        "mapping",
        "repository",
        "repository_id",
        "installation_id",
        "categories",
        "default_category",
        "discussion_body",
        "known_discussions",
        "cache_fresh_seconds",
        "refresh_cooldown_seconds",
        "refresh_sweep_seconds",
        "max_batch_size",
        "reaction_counters",
        "intents",
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
class CategoryConfig:
    key: str
    name: str
    node_id: str


@dataclass(frozen=True, slots=True)
class KnownDiscussionConfig:
    key: str
    node_id: str
    number: int
    category: str
    title: str


@dataclass(frozen=True, slots=True)
class SiteConfig:
    id: str
    origins: tuple[str, ...]
    mode: str
    mapping: str
    repository: str
    repository_id: str
    installation_id: int
    categories: Mapping[str, CategoryConfig]
    default_category: str
    known_discussions: tuple[KnownDiscussionConfig, ...] = ()
    discussion_body: str = "Feedback for [{title}]({url})"
    cache_fresh_seconds: int = 5
    refresh_cooldown_seconds: int = 5
    refresh_sweep_seconds: int = 86_400
    max_batch_size: int = 100
    reaction_counters: tuple[str, ...] = ()
    intents: frozenset[str] = frozenset({"upvotes"})

    @property
    def features(self) -> frozenset[str]:
        """Compatibility name for callers created before intents were explicit."""
        return self.intents

    def category_for(self, resource_key: str) -> CategoryConfig:
        prefix = resource_key.partition("/")[0]
        return self.categories.get(prefix, self.categories[self.default_category])


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

        mode = _string(value, "mode")
        if mode not in {"ranking", "discussion"}:
            raise ConfigError(f"sites.{site_id}.mode is unsupported")
        mapping = _string(value, "mapping")
        if mapping not in _MAPPINGS:
            raise ConfigError(f"sites.{site_id}.mapping is unsupported")
        repository = _string(value, "repository")
        if repository.count("/") != 1 or any(not part for part in repository.split("/")):
            raise ConfigError(f"sites.{site_id}.repository must be owner/name")
        categories_raw = _table(value, "categories")
        if not categories_raw:
            raise ConfigError(f"sites.{site_id}.categories must not be empty")
        categories: dict[str, CategoryConfig] = {}
        for category_key, category_value in categories_raw.items():
            if not isinstance(category_key, str) or not _SITE_ID.fullmatch(category_key):
                raise ConfigError(f"invalid category key: {category_key!r}")
            if not isinstance(category_value, dict):
                raise ConfigError(f"sites.{site_id}.categories.{category_key} must be a table")
            _reject_keys(
                category_value, {"name", "id"}, f"sites.{site_id}.categories.{category_key}"
            )
            categories[category_key] = CategoryConfig(
                category_key,
                _string(category_value, "name"),
                _string(category_value, "id"),
            )
        if len({category.name for category in categories.values()}) != len(categories):
            raise ConfigError(f"sites.{site_id}.categories contains duplicate names")
        if len({category.node_id for category in categories.values()}) != len(categories):
            raise ConfigError(f"sites.{site_id}.categories contains duplicate ids")
        default_category = _string(value, "default_category")
        if default_category not in categories:
            raise ConfigError(f"sites.{site_id}.default_category is not configured")
        discussion_body = (
            _string(value, "discussion_body")
            if "discussion_body" in value
            else "Feedback for [{title}]({url})"
        )
        _validate_template(discussion_body, f"sites.{site_id}.discussion_body")
        known_discussions: list[KnownDiscussionConfig] = []
        known_raw = value.get("known_discussions", [])
        if not isinstance(known_raw, list):
            raise ConfigError(f"sites.{site_id}.known_discussions must be an array")
        for index, known in enumerate(known_raw):
            name = f"sites.{site_id}.known_discussions[{index}]"
            if not isinstance(known, dict):
                raise ConfigError(f"{name} must be a table")
            _reject_keys(known, {"key", "id", "number", "category", "title"}, name)
            key = _string(known, "key")
            try:
                validate_resource_id(key)
            except ResourceError as exc:
                raise ConfigError(f"{name}.key is invalid") from exc
            category = _string(known, "category")
            if category not in categories:
                raise ConfigError(f"{name}.category is not configured")
            known_discussions.append(
                KnownDiscussionConfig(
                    key=key,
                    node_id=_string(known, "id"),
                    number=_bounded_int(known, "number", 1, 2**31 - 1),
                    category=category,
                    title=_string(known, "title"),
                )
            )
        if len({item.key for item in known_discussions}) != len(known_discussions):
            raise ConfigError(f"sites.{site_id}.known_discussions contains duplicate keys")
        if len({item.node_id for item in known_discussions}) != len(known_discussions):
            raise ConfigError(f"sites.{site_id}.known_discussions contains duplicate ids")
        if len({item.number for item in known_discussions}) != len(known_discussions):
            raise ConfigError(f"sites.{site_id}.known_discussions contains duplicate numbers")
        reaction_counters = (
            tuple(item.upper() for item in _string_list(value, "reaction_counters"))
            if "reaction_counters" in value
            else ()
        )
        if any(item not in _REACTIONS for item in reaction_counters):
            raise ConfigError(f"sites.{site_id}.reaction_counters contains an unsupported reaction")
        if len(set(reaction_counters)) != len(reaction_counters):
            raise ConfigError(f"sites.{site_id}.reaction_counters contains duplicates")
        if "intents" not in value:
            raise ConfigError(f"sites.{site_id}.intents is required")
        intents = frozenset(_string_list(value, "intents"))
        if not intents or not intents <= _INTENTS:
            raise ConfigError(f"sites.{site_id}.intents contains an unsupported intent")
        if (intents - {"upvotes", "reactions"}) and "discussion" not in intents:
            raise ConfigError(
                f"sites.{site_id}.intents requires discussion for discussion metadata"
            )
        if (
            {"answers", "authors", "moderation", "comment_reactions", "comment_upvotes"} & intents
        ) and "comments" not in intents:
            raise ConfigError(f"sites.{site_id}.intents requires comments for comment metadata")
        if mode == "ranking" and not intents <= {"upvotes", "reactions"}:
            raise ConfigError(f"sites.{site_id}.intents is incompatible with ranking mode")
        if reaction_counters and "reactions" not in intents:
            raise ConfigError(f"sites.{site_id}.reaction_counters requires reactions intent")

        sites[site_id] = SiteConfig(
            id=site_id,
            origins=site_origins,
            mode=mode,
            mapping=mapping,
            repository=repository,
            repository_id=_string(value, "repository_id"),
            installation_id=_bounded_int(value, "installation_id", 1, 2**63 - 1),
            categories=MappingProxyType(categories),
            default_category=default_category,
            known_discussions=tuple(known_discussions),
            discussion_body=discussion_body,
            cache_fresh_seconds=_bounded_int(value, "cache_fresh_seconds", 1, 3600, 5),
            refresh_cooldown_seconds=_bounded_int(value, "refresh_cooldown_seconds", 1, 3600, 5),
            refresh_sweep_seconds=_bounded_int(
                value, "refresh_sweep_seconds", 3600, 604_800, 86_400
            ),
            max_batch_size=_bounded_int(value, "max_batch_size", 1, 100, 100),
            reaction_counters=reaction_counters,
            intents=intents,
        )

    return Config(service, MappingProxyType(sites))


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


def _validate_template(value: str, name: str) -> None:
    try:
        parts = list(string.Formatter().parse(value))
        fields = {field for _, field, _, _ in parts if field is not None}
        if not fields <= {"key", "title", "url"} or any(
            format_spec or conversion for _, field, format_spec, conversion in parts if field
        ):
            raise KeyError
        rendered = value.format(key="key", title="title", url="https://example.test/")
    except (AttributeError, IndexError, KeyError, ValueError) as exc:
        raise ConfigError(f"{name} may use only {{key}}, {{title}}, and {{url}}") from exc
    if not rendered or len(rendered) > 4096:
        raise ConfigError(f"{name} is too large")


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
