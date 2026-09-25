# cpp.social feedback

GitHub Discussions-backed feedback controls for cpp.social. The browser runtime is
published to `https://feedback.cpp.social`; the API runs at
`https://feedback-api.cpp.social`.

## Deployment

GitHub Pages is built and deployed by `.github/workflows/pages.yml`. The Pages
artifact contains the example at `/example/`, the versioned runtime under `/v1/`,
and the OAuth callback at the exact registered URI:

`https://feedback.cpp.social/v1/oauth/callback.html`

The VPS checkout must be at `/srv/feedback`. Before enabling the NixOS
configuration, place these non-empty, non-group/world-writable files in
`/srv/feedback/config/secrets/`:

- `github-app-private-key.pem`
- `github-client-secret`
- `oauth-state-hmac-key`

The secret files must be readable by UID 10001 in the container. Root-owned mode
`0444` is suitable because Docker bind-mounts them read-only. The application
configuration itself is committed as `config/sites.toml`.

The GitHub App must be public (installable by any account), have Discussions
read/write permission, and register the exact callback URL
`https://feedback.cpp.social/v1/oauth/callback.html`. A private GitHub App shows
GitHub's 404 page to users who do not own it, before this service receives a
callback. After adding or changing the Discussions permission, the repository
owner must approve the installation's requested permission update. Existing
browser sessions should then log out and sign in again so their user token is
issued with the current installation permissions. Voting uses GitHub thumbs-up
and thumbs-down reactions because native Discussion upvote mutations are not
usable with this GitHub App token.

Production SQLite files are persisted in the checkout's `db/` directory. The
deployment bind-mounts `/srv/feedback/db` to `/data` in the container, so the
site databases are `/srv/feedback/db/<site-id>.sqlite3`. They are ignored by
Git and survive container rebuilds and replacement.
The reaction-backed voting schema is version 5. Existing version-4 SQLite
files cannot be reused; before deploying this change, archive or remove the
site database files in `/srv/feedback/db/` while the service is stopped, then
start the service with fresh files. No automatic destructive migration runs.

The process is configured with explicit command-line arguments rather than
environment variables. `python -m feedback --help` lists the config, secret-file,
listener, proxy-trust, concurrency, and keep-alive options. Docker Compose passes
those arguments directly and uses fixed read-only mounts.

The `vps-8def0ca8` NixOS configuration imports and enables the feedback service.
Rebuilding that host builds the image from `/srv/feedback`, starts it with Docker
Compose, and provisions the `feedback-api.cpp.social` nginx virtual host and ACME
certificate. No `.env` file is required.

Useful verification commands on the VPS:

```sh
systemctl status feedback-service
curl --fail --silent --show-error --compressed \
  'https://feedback-api.cpp.social/v1/sites/cpp-social/reactions?keys=feedback/example'
```

## Site mappings and metadata

Each site maps a browser resource to one GitHub Discussion. The configured
`mapping` selects the value used as the discussion lookup term and title:

- `key`: the stable application-provided `resource.key` (recommended when URLs or
  titles may change).
- `title`: the resource title.
- `url`: the complete canonical URL, including its origin.
- `pathname`: only the canonical URL path, allowing equivalent pages on multiple
  origins to share a discussion.
- `custom`: an arbitrary consumer-provided string for custom routing schemes.
- `number`: the numeric number of an already existing GitHub Discussion. Unlike
  `key`, it is not a resource identifier and missing discussions are never created.

The browser package exports `resourceFromDocument()`. By default it reads the
first non-empty title from `meta[property="og:title"]` and then `<title>`, reads
`link[rel="canonical"]` when present, and otherwise uses the current location.
Consumers can override `titleSelectors` and `canonicalSelector`, or construct a
`Resource` directly and supply `custom`, `pathname`, or `number`. Metadata
selection is intentionally client-side; the service only receives validated
resource values and applies the site mapping.

```ts
const resource = resourceFromDocument({
  key: "articles/stable-id",
  titleSelectors: ['meta[name="feedback-title"]', 'meta[property="og:title"]', "title"],
  canonicalSelector: 'link[rel="canonical"]',
  custom: document.body.dataset.feedbackKey ?? "default-feedback-key",
});
```

The bundled example exercises multiple threads, batched reaction-backed votes,
reactions, labels, polls, comments, replies, accepted
answers, author associations, and GitHub links. Supply
comma-separated resource keys with `keys`:

`https://feedback.cpp.social/example/?site=feedback-cpp-social&keys=feedback%2Fexample%2Cfeedback%2Fexample-two&github=link`

Add `firstPost=hidden` when the host page already represents the discussion's
opening post. This frontend-only option keeps post reactions and votes,
poll controls, and comments visible. `title=hidden` also starts with the
discussion title hidden. The example toolbar can toggle the title, root post,
metadata, poll, and post actions without another request configuration.
Add `votes=separate` to display thumbs-up/down as a distinct single-choice vote
control instead of ordinary reactions in full discussion panels. The example
toolbar can toggle this mode. Voting cards always use the separate vote control.

## API and intent configuration

Every site must list its required `intents`. Disabled intents return 404 and do
not activate their refresh paths. The route contract, intent matrix, and audit
of every server-side GitHub request path are in [docs/API.md](docs/API.md).

The browser runtime sends user-specific viewer queries, reactions, and comments
directly to GitHub. The service handles OAuth, discussion discovery/creation, and
shared anonymous reads where caching prevents every visitor consuming a GitHub
request.

Use `--verbose` for privacy-safe route/status/timing and cache-decision logs. It
does not log credentials, OAuth codes, bodies, origins, resource URLs, or client
addresses.

## Counter cache and discussion content

The service database keeps discussion identifiers and aggregate counters only.
Discussion and comment bodies are not persisted. Filtered thread responses are
held in a bounded ten-second memory cache keyed by discussion ID, so a recently
deleted comment may remain visible briefly. Identical concurrent reads share an
in-flight GitHub call.

This revision uses schema version 7. It does not migrate existing older
databases. Remove the service's SQLite database files before starting this build;
configured `known_discussions` are seeded again and counters refill from GitHub.

When `category_pins` is enabled for a site, the same batched counter response
includes `pinnedToCategory` for each card. The service reads GitHub's public
category page once per requested category per `pin_cache_seconds` (default one
hour), using ETags when available. Concurrent requests share a refresh. Failed
refreshes retain the last good snapshot and wait five minutes before retrying.
This uses the category's pinned list, so repository-wide pins do not affect it.

`cache_fresh_seconds` is the age at which a requested tracked counter needs an
authoritative GitHub refresh. The default is 60 seconds. A batched request
refreshes only stale resources; recently refreshed resources in the same request
are served from SQLite. For example, if A was last refreshed 90 seconds ago and B
30 seconds ago, requesting `[A, B]` sends only A's discussion ID to GitHub and
returns B from SQLite in the same response.

`refresh_cooldown_seconds` is the minimum delay before retrying a refresh attempt
for the same resource. It primarily prevents repeated GitHub calls after a failed
or concurrent attempt. Concurrent requests also join the same in-flight site
batch. The default is 60 seconds.

`refresh_sweep_seconds` controls the low-priority full maintenance cycle. The
default is 86400 seconds (daily). The service walks only discussions whose last
authoritative snapshot is that old, in batches of 50 with pacing between full
batches. Targeted requests and successful votes continue independently.

Successful browser mutations update the displayed counters immediately, without
submitting a second vote or trusting an unverified client count on the server.
The next successful
targeted or maintenance refresh replaces counters with GitHub's absolute counts.
Counter responses use `no-cache`, so
browsers revalidate with this service; that does not imply a GitHub request while
the relevant snapshot remains fresh.

The browser runtime keeps the last anonymous counter snapshot in local storage for
up to seven days and renders cards synchronously before the batched API request.
Snapshots contain no token or viewer identity. Once authenticated, viewer reaction
state for the visible discussions is fetched in a batched GitHub query.

Operational logs are emitted at GitHub boundaries rather than for every HTTP
request. Reaction-refresh lines include the site, trigger (`requested` or
`sweep`), batch size, updated-row count, and duration. Failures include safe
GitHub status/request IDs where available. Discussion discovery/creation, OAuth
failures, rejected creation grants, one-off GitHub App bearer retries, vote
failures, startup, and sweep summaries are also logged. Client IPs, origins,
resource URLs, authorization codes, and tokens are not logged.

## Local checks

```sh
python -m pytest -q
cd runtime && npm ci && npm run check && npm run lint && npm test && npm run build
docker compose -f compose.deploy.yaml config
```
