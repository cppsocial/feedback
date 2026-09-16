from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TypeGuard, cast

from starlette.datastructures import QueryParams
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from feedback.service.resources import Resource, ResourceError, validate_resource_id


@dataclass(frozen=True, slots=True)
class ApiError(Exception):
    code: str
    message: str
    status: int


@dataclass(frozen=True, slots=True)
class EnsureDiscussionRequest:
    resource: Resource
    grant: str


def resource_keys(query: QueryParams, maximum: int) -> list[str]:
    parameters = list(query.multi_items())
    if len(parameters) != 1 or parameters[0][0] != "keys":
        raise ApiError("invalid_keys", "Exactly one keys query parameter is required.", 400)
    parts = parameters[0][1].split(",")
    if any(not part for part in parts):
        raise ApiError("invalid_keys", "Keys must be a comma-separated list.", 400)
    try:
        keys = sorted({validate_resource_id(part) for part in parts})
    except ResourceError as exc:
        raise ApiError("invalid_keys", "One or more resource keys are invalid.", 400) from exc
    if len(keys) > maximum:
        raise ApiError("batch_too_large", f"At most {maximum} keys are allowed.", 400)
    return keys


async def json_strings(
    request: Request,
    fields: frozenset[str],
    *,
    maximum_body_size: int = 16_384,
    maximum_value_size: int = 4_096,
) -> dict[str, str]:
    body = await json_object(request, maximum_body_size=maximum_body_size)
    if set(body) != fields:
        raise ApiError("invalid_request", "Request fields are invalid.", 400)
    if any(not _is_string(body[field], maximum_value_size) for field in fields):
        raise ApiError("invalid_request", "Request fields are invalid.", 400)
    return cast(dict[str, str], body)


async def json_object(request: Request, *, maximum_body_size: int = 16_384) -> dict[str, object]:
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise ApiError("unsupported_media_type", "Content-Type must be application/json.", 415)
    declared_length = _content_length(request)
    if declared_length is not None and declared_length > maximum_body_size:
        raise ApiError("request_too_large", "Request body is too large.", 413)
    content = await request.body()
    if len(content) > maximum_body_size:
        raise ApiError("request_too_large", "Request body is too large.", 413)
    try:
        pairs: object = json.loads(content, object_pairs_hook=list)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(pairs, list) or any(
        not isinstance(pair, tuple) or len(pair) != 2 for pair in pairs
    ):
        raise ApiError("invalid_json", "Request body must be a JSON object.", 400)
    if len({pair[0] for pair in pairs}) != len(pairs):
        raise ApiError("invalid_request", "Request fields are invalid.", 400)
    return dict(pairs)


async def ensure_discussion_request(request: Request) -> EnsureDiscussionRequest:
    body = await json_object(request)
    allowed = {"key", "title", "url", "pathname", "specific", "number", "grant"}
    if set(body) - allowed or not {"key", "url", "grant"} <= set(body):
        raise ApiError("invalid_request", "Discussion fields are invalid.", 400)
    for field in ("key", "url", "grant"):
        if not _is_string(body[field], 4096):
            raise ApiError("invalid_request", "Discussion fields are invalid.", 400)
    for field in ("title", "pathname", "specific"):
        value = body.get(field)
        if value is not None and (not isinstance(value, str) or not value or len(value) > 512):
            raise ApiError("invalid_request", "Discussion fields are invalid.", 400)
    number = body.get("number")
    if number is not None and (
        isinstance(number, bool) or not isinstance(number, int) or number < 1
    ):
        raise ApiError("invalid_request", "Discussion fields are invalid.", 400)
    return EnsureDiscussionRequest(
        Resource(
            key=cast(str, body["key"]),
            title=cast(str | None, body.get("title")),
            url=cast(str, body["url"]),
            pathname=cast(str | None, body.get("pathname")),
            specific=cast(str | None, body.get("specific")),
            number=number,
        ),
        cast(str, body["grant"]),
    )


def error_response(error: ApiError) -> JSONResponse:
    return JSONResponse(
        {"v": 1, "error": {"code": error.code, "message": error.message}},
        status_code=error.status,
        headers={"Cache-Control": "no-store"},
    )


def cors(response: Response, origin: str | None) -> Response:
    if origin is not None:
        response.headers["Access-Control-Allow-Origin"] = origin
    return response


def preflight(origin: str, *, method: str, headers: str) -> Response:
    return cors(
        Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Methods": method,
                "Access-Control-Allow-Headers": headers,
                "Access-Control-Max-Age": "86400",
                "Cache-Control": "no-store",
            },
        ),
        origin,
    )


def _content_length(request: Request) -> int | None:
    value = request.headers.get("content-length")
    if value is None:
        return None
    try:
        length = int(value)
    except ValueError as exc:
        raise ApiError("invalid_request", "Content-Length is invalid.", 400) from exc
    if length < 0:
        raise ApiError("invalid_request", "Content-Length is invalid.", 400)
    return length


def _is_string(value: object, maximum: int) -> TypeGuard[str]:
    return isinstance(value, str) and bool(value) and len(value) <= maximum
