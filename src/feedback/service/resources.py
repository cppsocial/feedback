import re
from dataclasses import dataclass
from urllib.parse import urlsplit

RESOURCE_ID_PATTERN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._~/-]{0,198}[A-Za-z0-9._~-])?\Z")


class ResourceError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Resource:
    key: str
    title: str | None = None
    url: str | None = None
    pathname: str | None = None
    custom: str | None = None
    number: int | None = None


def validate_resource_id(value: str) -> str:
    if (
        not RESOURCE_ID_PATTERN.fullmatch(value)
        or "//" in value
        or "/./" in value
        or "/../" in value
    ):
        raise ResourceError("invalid resource key")
    return value


def lookup_term(mapping: str, resource: Resource) -> str:
    validate_resource_id(resource.key)
    if mapping == "key":
        return resource.key
    if mapping == "title":
        return _required(resource.title, "title")
    if mapping == "url":
        return _url(resource.url, include_origin=True)
    if mapping == "pathname":
        return _url(resource.pathname or resource.url, include_origin=False)
    if mapping == "custom":
        return _required(resource.custom, "custom")
    if mapping == "number":
        if (
            not isinstance(resource.number, int)
            or isinstance(resource.number, bool)
            or resource.number < 1
        ):
            raise ResourceError("number must be a positive integer")
        return str(resource.number)
    raise ResourceError("unsupported mapping")


def _required(value: str | None, name: str) -> str:
    if value is None or not value.strip() or len(value) > 512 or "\x00" in value:
        raise ResourceError(f"{name} must be a non-empty string")
    return value.strip()


def _url(value: str | None, *, include_origin: bool) -> str:
    raw = _required(value, "url" if include_origin else "pathname")
    parsed = urlsplit(raw)
    if include_origin:
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.fragment:
            raise ResourceError("url must be an absolute HTTP URL without a fragment")
        return raw
    path = parsed.path if parsed.scheme else raw
    if not path.startswith("/") or "?" in path or "#" in path:
        raise ResourceError("pathname must be an absolute path without query or fragment")
    return path
