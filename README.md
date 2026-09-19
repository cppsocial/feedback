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
curl --fail --silent --show-error https://feedback-api.cpp.social/
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

The bundled read-only discussion example can render the feedback site's test
thread, including labels, canonical reaction counters, minimized comments, and
replies:

`https://feedback.cpp.social/example/?site=feedback-cpp-social&key=feedback%2Fexample&github=link`

## Counter cache

The service database is a cache of GitHub discussions. It keeps
lightweight discussion and comment metadata in `discussions` and `comments`,
content separately in `content`, main-post reactions in `reactions`, comment
reactions in `comment_reactions`, and discussion labels through
`discussion_labels`. Reaction rows retain GitHub account IDs when the API
returns them; an aggregate remainder row is used for accounts not included in
the returned user page. The public API is read-only for discussion content and
counters; discussion creation, voting, starring, and comment moderation are not
exposed.

`cache_fresh_seconds` is the age at which a requested tracked counter needs an
authoritative GitHub refresh. The default is five seconds. A batched request
refreshes only stale resources; recently refreshed resources in the same request
are served from SQLite. For example, if A was last refreshed 30 seconds ago and B
three seconds ago, requesting `[A, B]` sends only A's discussion ID to GitHub and
returns B from SQLite in the same response.

`refresh_cooldown_seconds` is the minimum delay before retrying a refresh attempt
for the same resource. It primarily prevents repeated GitHub calls after a failed
or concurrent attempt. Concurrent requests also join the same in-flight site
batch. The default is five seconds.

`refresh_sweep_seconds` controls the low-priority full maintenance cycle. The
default is 86400 seconds (daily). The service walks only discussions whose last
authoritative snapshot is that old, in batches of 50 with pacing between full
batches. Targeted requests and successful votes continue independently.

Votes made through the runtime update SQLite immediately using an atomic,
confirmed delta. These local values are tentative: they do not change the last
GitHub-refresh timestamp, and the next successful targeted or maintenance refresh
replaces them with GitHub's absolute counts. Counter responses use `no-cache`, so
browsers revalidate with this service; that does not imply a GitHub request while
the relevant snapshot remains fresh.

The browser runtime keeps the last counter snapshot and the last confirmed viewer
vote/star state in local storage for up to seven days. Consumers can render them
synchronously while the API request is in flight, avoiding a flash of zero counters
or unselected vote buttons. Snapshots contain only the site/resource key, discussion
node ID, counts, viewer state, star state, and save time; authentication tokens are not part of
this cache. Storage is optional and failures fall back to the network normally.

Once authenticated, the runtime also resolves the current user's vote and star
state for all visible discussions in one batched GitHub query. That viewer-specific
snapshot is reused for five minutes, including across reloads, and then refreshed
on demand. This makes reactions created on GitHub or another device visible without
turning every counter request into an authenticated GitHub request. Stars map to
GitHub's `EYES` reaction because Discussions does not provide a star reaction.

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
