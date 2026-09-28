from __future__ import annotations

from starlette.requests import Request
from starlette.responses import Response

from feedback.service.runtime import FeedbackRuntime

_MAX_BODY = 256 * 1024


async def github_webhook(request: Request) -> Response:
    runtime: FeedbackRuntime = request.app.state.services
    if runtime.webhooks is None:
        return Response(status_code=404)
    if request.headers.get("content-type", "").partition(";")[0].strip() != "application/json":
        return Response(status_code=415)
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > _MAX_BODY:
                return Response(status_code=413)
        except ValueError:
            return Response(status_code=400)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_BODY:
            return Response(status_code=413)
    status = runtime.webhooks.process(
        body,
        signature=request.headers.get("x-hub-signature-256", ""),
        delivery=request.headers.get("x-github-delivery", ""),
        event=request.headers.get("x-github-event", ""),
    )
    return Response(status_code=status)
