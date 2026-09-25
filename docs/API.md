# Feedback API and browser package

The system maps a site-defined resource key to one GitHub Discussion. Resource
keys are stable and known by the consuming site; use category-qualified keys such
as `articles/ranges`, `tips/vector-growth`, and `updates/2026-09`. The first path
component selects a configured GitHub Discussion category. Unrecognised prefixes
use `default_category`.

There are two site modes:

- `ranking` exposes batched GitHub thumbs-up/down reaction counts as votes. It
  may also expose explicitly selected other reaction counts. It has no
  discussion-content API.
- `discussion` can expose a full thread, post reactions, comments and replies,
  answers, polls, author associations, moderation state, labels, comment
  reactions, and GitHub links. Each extra group is enabled by an intent.

An unauthenticated visitor can read configured data but cannot mutate it. OAuth
is initiated only by user interaction. The browser then talks directly to
GitHub for viewer state and mutations; the service never receives the user's
GitHub token after exchange and provides no general user-token proxy.

## Permissions

| Principal | Permission used | Operation |
| --- | --- | --- |
| GitHub App installation | Discussions read | Find discussions, read threads, reactions, polls, labels, and author data |
| No GitHub credential | Public category page read | Refresh category pin flags when `category_pins` is enabled |
| GitHub App installation | Discussions write | Create a discussion after a signed creation grant |
| Signed-in GitHub user | Discussions read/write on the target repository | Read viewer state; vote, react, comment, reply, edit, delete, and mark answers where GitHub permits |
| Browser on an allowed site origin | Service read routes | Read public counters and threads without signing in |
| Browser with OAuth state and PKCE verifier | Service OAuth routes | Exchange a code for a user token and creation grant |

The example requests only the target repository's Discussions permission through
the GitHub App. GitHub still enforces repository roles for edits, deletion, and
answer selection. A creation grant does not grant those GitHub privileges.
Origin checks enforce browser CORS policy; non-browser callers can forge an
`Origin` header, so public reads rely on bounded batches, short-lived caching,
and GitHub request concurrency limits rather than origin as authentication.

## Configuration and intents

Every site declares `mode`, `intents`, one or more categories, and a default
category. `discussion_body` is the template used only when creating a thread and
supports `{key}`, `{title}`, and `{url}`.

`known_discussions` can pre-register stable discussion node IDs and numbers. This
avoids discovery requests and makes existing threads readable immediately with a
fresh database. The frontend key may equal the current title; duplicate titles
in different categories should use category-qualified keys.

| Intent | Returned or enabled data |
| --- | --- |
| `votes` | `THUMBS_UP` and `THUMBS_DOWN` counts; required for `/reactions` |
| `reactions` | Main-post reaction groups selected by `reaction_counters` |
| `discussion` | Authoritative thread read and discussion creation |
| `comments` | Comments and replies |
| `answers` | Selected-answer state (`isAnswer`); GitHub GraphQL does not expose the verified-answer badge |
| `polls` | Poll question, options, and totals |
| `authors` | Author identity and `authorAssociation` |
| `moderation` | Moderation reason for visible comments; minimized comments are always excluded |
| `comment_reactions` | Comment/reply reaction totals |
| `labels` | Discussion labels |
| `github_link` | Discussion/comment URLs and discussion number in counter results |
| `category_pins` | `pinnedToCategory` boolean in batched counter results, available anonymously |

Ranking mode accepts `votes`, `reactions`, and `category_pins`. Discussion metadata intents
require `discussion`; comment-specific metadata requires `comments`. Disabled
features return 404 and do not add fields to GitHub queries or API responses.
`reaction_counters` selects individual non-vote reaction fields; `github_link`
selects link and number fields; `category_pins` selects the pin flag. A category
may set `slug` when its GitHub URL slug differs from its local key.

GitHub's public GraphQL discussion schema does not expose category pins. When
enabled, the service reads the pinned list from each requested category's public
GitHub page, bounded to one page per category per hour by default. It requests
only categories present in the card batch, uses ETags when available, coalesces
concurrent refreshes, and keeps the last good snapshot on failure. Repository-wide
pins are excluded. The page parser is a compatibility boundary; monitor the
refresh warning if GitHub changes its HTML.

## HTTP routes

All JSON responses contain `v: 1`. Errors are
`{"v":1,"error":{"code":"...","message":"..."}}`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sites/{site}/reactions?keys=a,b` | Sorted, deduplicated batch of up to `max_batch_size` counters |
| `POST` | `/v1/sites/{site}/oauth/authorize` | Start PKCE OAuth with `challenge` and `nonce` |
| `POST` | `/v1/sites/{site}/oauth/exchange` | Exchange `code`, `state`, and `verifier`; return token plus an origin-bound creation grant |
| `POST` | `/v1/sites/{site}/discussions/ensure` | Find or create a thread for a validated resource and grant |
| `GET` | `/v1/sites/{site}/discussion?keys=a,b` | Fetch up to ten authoritative configured threads in one GitHub `nodes` query |

`OPTIONS` is registered explicitly for the reaction and POST routes. It checks
the site origin and returns the allowed method and headers. `HEAD` is disabled
because a nominally cheap metadata request could otherwise trigger a GitHub read.

The route map lives in `src/feedback/api/routes.py`. Handlers in
`src/feedback/api/endpoints/` handle HTTP validation and responses; shared site
authorization is in `src/feedback/api/context.py`. Counter shaping and GitHub
operations live under `src/feedback/service/` and `src/feedback/protocol/`.

The service registers only these API paths. `/` and documentation/schema paths
return 404. The production reverse proxy rejects all other paths before they
reach the service. It offers Brotli for eligible JSON responses when the client
sends `Accept-Encoding: br`; small responses are left uncompressed.

A minimal counter response is:

```json
{"v":1,"site":"cpp-social","items":{"resources/42":{"id":"D_...","up":17,"down":2}}}
```

`number` is included only for `github_link`; `reactions` is included only when
`reaction_counters` is non-empty. Cache age and server internals are not exposed.
Unknown resources have `id: null` and zero counts. Counter responses revalidate
with an ETag. Discussion and OAuth responses are `no-store`.
Thread reads currently include the first 25 top-level comments and the first
25 replies under each; pagination is not exposed by this API.

## Browser API

`FeedbackClient.reactions(keys)` performs the multi-key service read.
`createVoteControls()` creates accessible thumbs-up/down buttons, batches their
initial read, authenticates on activation, creates a missing discussion lazily,
and sends reactions directly to GitHub. `createAuthenticationStatus()` is deliberately
independent so a site can mount login/status anywhere.

The package also exports direct, typed GitHub helpers for comment/reply creation,
comment editing/deletion, reactions, poll votes, accepted answers, and batched
viewer-reaction state. A discussion UI can compose these
without routing user actions through the service. Authentication tokens are held
in session storage; counter/viewer snapshots contain no token.

The example offers a simple textarea or local Markdown formatting tools. GitHub
renders submitted Markdown. Successful mutations update the visible count from
GitHub's response. Mutations are not aborted after dispatch because cancelling
the network request cannot establish whether GitHub applied the change. After an
uncertain failure, refresh viewer state before retrying.

## GitHub request audit and abuse boundaries

The server can contact GitHub only in these places:

1. OAuth code exchange. State, PKCE, exact origins, expiry, and single-purpose
   creation grants bound the flow.
2. GitHub App installation-token acquisition. Tokens are cached until shortly
   before expiry and acquisition is serialized.
3. Counter refresh. Stale discussion IDs are grouped into `nodes(ids:)` batches
   of at most 50. Per-site in-flight work is shared, failures have a cooldown,
   global GitHub concurrency is capped, and maintenance sweeps are paced.
4. Discussion discovery/creation. Work is serialized per site/resource; exact
   repository and category matches are required, and the resulting ID is stored.
5. Discussion reads. Up to ten threads are grouped in one `nodes(ids:)` request.
   Identical simultaneous batches share in-flight work; completed, filtered
   results are held in a bounded 10-second memory cache. Deleted or minimized
   content can therefore remain visible for up to 10 seconds after moderation.

Request sizes, key syntax, JSON fields, body sizes, origins, and batch size are
bounded. Security headers are applied globally. Logs omit tokens, OAuth codes,
comment bodies, URLs, origins, and client addresses. `--verbose` enables safe
route timing and cache/GitHub-boundary diagnostics.

The database stores discussion identity and aggregate counters only. It does not
store discussion or comment bodies. Deleted or minimized comment nodes are
excluded from discussion responses together with their replies before caching.
The example browser also keeps a 10-second thread snapshot to avoid network
requests when users change local presentation settings.
