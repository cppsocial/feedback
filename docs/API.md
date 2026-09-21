# Feedback API and browser package

The system maps a site-defined resource key to one GitHub Discussion. Resource
keys are stable and known by the consuming site; use category-qualified keys such
as `articles/ranges`, `tips/vector-growth`, and `updates/2026-09`. The first path
component selects a configured GitHub Discussion category. Unrecognised prefixes
use `default_category`.

There are two site modes:

- `ranking` exposes batched native GitHub Discussion upvote counts. It may also
  expose explicitly selected reaction counts. It has no discussion-content API.
- `discussion` can expose a full thread, post reactions, comments and replies,
  answers, polls, author associations, moderation state, labels, comment
  reactions/upvotes, and GitHub links. Each extra group is enabled by an intent.

An unauthenticated visitor can read configured data but cannot mutate it. OAuth
is initiated only by user interaction. The browser then talks directly to
GitHub for viewer state and mutations; the service never receives the user's
GitHub token after exchange and provides no general user-token proxy.

## Configuration and intents

Every site declares `mode`, `intents`, one or more categories, and a default
category. `discussion_body` is the template used only when creating a thread and
supports `{key}`, `{title}`, and `{url}`.

| Intent | Returned or enabled data |
| --- | --- |
| `upvotes` | Native Discussion `upvoteCount`; required for `/reactions` |
| `reactions` | Main-post reaction groups selected by `reaction_counters` |
| `discussion` | Authoritative thread read and discussion creation |
| `comments` | Comments and replies |
| `answers` | Accepted-answer state |
| `polls` | Poll question, options, and totals |
| `authors` | Author identity and `authorAssociation` |
| `moderation` | Minimized state and reason |
| `comment_reactions` | Comment/reply reaction totals |
| `comment_upvotes` | Comment/reply native upvote totals |
| `labels` | Discussion labels |
| `github_link` | Discussion/comment URLs and discussion number in counter results |

Ranking mode accepts only `upvotes` and `reactions`. Discussion metadata intents
require `discussion`; comment-specific metadata requires `comments`. Disabled
features return 404 and do not add fields to GitHub queries or API responses.

## HTTP routes

All JSON responses contain `v: 1`. Errors are
`{"v":1,"error":{"code":"...","message":"..."}}`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sites/{site}/reactions?keys=a,b` | Sorted, deduplicated batch of up to `max_batch_size` counters |
| `POST` | `/v1/sites/{site}/oauth/authorize` | Start PKCE OAuth with `challenge` and `nonce` |
| `POST` | `/v1/sites/{site}/oauth/exchange` | Exchange `code`, `state`, and `verifier`; return token plus an origin-bound creation grant |
| `POST` | `/v1/sites/{site}/discussions/ensure` | Find or create a thread for a validated resource and grant |
| `GET` | `/v1/sites/{site}/discussion?keys=a` | Fetch one authoritative configured thread |

A minimal counter response is:

```json
{"v":1,"site":"cpp-social","items":{"resources/42":{"id":"D_...","upvotes":17}}}
```

`number` is included only for `github_link`; `reactions` is included only when
`reaction_counters` is non-empty. Cache age and server internals are not exposed.
Unknown resources have `id: null` and zero counts. Counter responses revalidate
with an ETag. Discussion and OAuth responses are `no-store`.

## Browser API

`FeedbackClient.reactions(keys)` performs the multi-key service read.
`createUpvoteControls()` creates accessible buttons, batches their initial read,
authenticates on activation, creates a missing discussion lazily, and sends the
native upvote directly to GitHub. `createAuthenticationStatus()` is deliberately
independent so a site can mount login/status anywhere.

The package also exports direct, typed GitHub helpers for comment/reply creation,
comment editing/deletion, reactions, poll votes, accepted answers, native
upvotes, and batched viewer-upvote state. A discussion UI can compose these
without routing user actions through the service. Authentication tokens are held
in session storage; counter/viewer snapshots contain no token.

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
5. Discussion reads. A read is authoritative; simultaneous reads of the same
   thread share only the in-flight request. The response is never retained.

Request sizes, key syntax, JSON fields, body sizes, origins, and batch size are
bounded. Security headers are applied globally. Logs omit tokens, OAuth codes,
comment bodies, URLs, origins, and client addresses. `--verbose` enables safe
route timing and cache/GitHub-boundary diagnostics.

The database stores discussion identity and aggregate counters only. It does not
store discussion or comment bodies. Consequently a later request cannot serve a
cached copy of deleted content; deleted nodes returned by GitHub are represented
only by their deletion state, and frontend renderers must not render their body.
