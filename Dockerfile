# syntax=docker/dockerfile:1

ARG PYTHON_IMAGE=python:3.14.7-slim-trixie@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6

FROM ${PYTHON_IMAGE} AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN python -m venv "$VIRTUAL_ENV"
WORKDIR /app

FROM base AS development

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-dev.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements-dev.txt

# The Dev Containers extension bind-mounts the workspace at runtime, so keep
# source code out of this development image.  This also avoids requiring a
# particular source-tree layout merely to open the repository in VS Code.

CMD ["python", "-m", "feedback"]

FROM development AS test

COPY pyproject.toml ./
COPY src ./src
COPY tests ./tests
RUN pip install --no-deps .
CMD ["pytest", "-q"]

FROM base AS production-builder

COPY requirements.txt pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY src ./src
RUN pip install --no-deps .
RUN pip uninstall --yes pip setuptools msgpack

FROM ${PYTHON_IMAGE} AS production

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random

RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip uninstall --yes pip setuptools msgpack
RUN groupadd --gid 10001 feedback \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin feedback \
    && mkdir --parents /app /data \
    && chown 10001:10001 /data

COPY --from=production-builder --chown=10001:10001 /opt/venv /opt/venv

WORKDIR /app
USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 8080), 2).close()"]

ENTRYPOINT ["python", "-m", "feedback"]
