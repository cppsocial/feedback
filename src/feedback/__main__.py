import os

import uvicorn


def main() -> None:
    host = os.environ.get("FEEDBACK_HOST", "0.0.0.0")
    port = _bounded_int("FEEDBACK_PORT", 8080, 1, 65535)
    concurrency = _bounded_int("FEEDBACK_LIMIT_CONCURRENCY", 64, 1, 1024)
    keep_alive = _bounded_int("FEEDBACK_KEEP_ALIVE_SECONDS", 5, 1, 60)
    uvicorn.run(
        "feedback.app:app",
        host=host,
        port=port,
        workers=1,
        access_log=False,
        server_header=False,
        limit_concurrency=concurrency,
        timeout_keep_alive=keep_alive,
        forwarded_allow_ips=os.environ.get("FEEDBACK_FORWARDED_ALLOW_IPS", "127.0.0.1"),
    )


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise SystemExit(f"{name} must be from {minimum} through {maximum}")
    return value


if __name__ == "__main__":
    main()
