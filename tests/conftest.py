from pathlib import Path

import pytest

from feedback.config import Config, ServiceConfig, SiteConfig


@pytest.fixture
def config(tmp_path: Path) -> Config:
    return Config(
        service=ServiceConfig(
            public_origin="https://feedback-api.cpp.social",
            oauth_callback="https://feedback.cpp.social/v1/oauth/callback.html",
            data_directory=tmp_path,
            github_app_id=123,
            github_client_id="Iv1.client",
        ),
        sites={
            "cpp-social": SiteConfig(
                id="cpp-social",
                origins=("https://cpp.social",),
                mapping="key",
                repository="cppsocial/site",
                repository_id="R_repo",
                installation_id=123,
                category="Resources",
                category_id="DIC_category",
            )
        },
    )
