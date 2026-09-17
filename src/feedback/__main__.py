from __future__ import annotations

import argparse
import logging
from pathlib import Path

import uvicorn

from feedback.app import SecretFiles, create_app
from feedback.config import load_config


def main() -> None:
    args = argument_parser().parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    application = create_app(
        load_config(args.config),
        secret_files=SecretFiles(
            github_app_private_key=args.github_app_private_key_file,
            github_client_secret=args.github_client_secret_file,
            oauth_state_hmac_key=args.oauth_state_hmac_key_file,
        ),
    )
    uvicorn.run(
        application,
        host=args.host,
        port=args.port,
        workers=1,
        access_log=False,
        server_header=False,
        limit_concurrency=args.limit_concurrency,
        timeout_keep_alive=args.keep_alive_seconds,
        forwarded_allow_ips=args.forwarded_allow_ips,
        log_level=args.log_level,
    )


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the cpp.social feedback service")
    parser.add_argument("--config", type=Path, default=Path("/run/config/sites.toml"))
    parser.add_argument(
        "--github-app-private-key-file",
        type=Path,
        default=Path("/run/secrets/github-app-private-key"),
    )
    parser.add_argument(
        "--github-client-secret-file",
        type=Path,
        default=Path("/run/secrets/github-client-secret"),
    )
    parser.add_argument(
        "--oauth-state-hmac-key-file",
        type=Path,
        default=Path("/run/secrets/oauth-state-hmac-key"),
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=_port, default=8080)
    parser.add_argument("--forwarded-allow-ips", default="127.0.0.1")
    parser.add_argument("--limit-concurrency", type=_positive_int, default=64)
    parser.add_argument("--keep-alive-seconds", type=_positive_int, default=5)
    parser.add_argument(
        "--log-level",
        choices=("debug", "info", "warning", "error", "critical"),
        default="info",
    )
    return parser


def _port(value: str) -> int:
    result = int(value)
    if not 1 <= result <= 65_535:
        raise argparse.ArgumentTypeError("port must be from 1 through 65535")
    return result


def _positive_int(value: str) -> int:
    result = int(value)
    if not 1 <= result <= 1024:
        raise argparse.ArgumentTypeError("value must be from 1 through 1024")
    return result


if __name__ == "__main__":
    main()
