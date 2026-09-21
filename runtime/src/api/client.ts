import { validateResourceId } from "../feedback/resources.js";
import type { Resource } from "../feedback/resources.js";
import {
  addComment as addGitHubComment,
  toggleUpvote as toggleGitHubUpvote,
  viewerUpvotes,
} from "../protocol/github.js";
import type { UpvoteResult } from "../protocol/github.js";

interface CounterState {
  id: string | null;
  number?: number | null;
  upvotes: number;
  reactions?: Record<string, number>;
}

type StoredReactionState = CounterState & {
  viewerHasUpvoted: boolean;
  viewerKnown?: boolean;
};

export interface ReactionState extends CounterState {
  viewerHasUpvoted: boolean;
  viewerKnown: boolean;
}

interface ReactionEnvelope {
  v: 1;
  site: string;
  items: Record<string, CounterState>;
}

export interface ClientOptions {
  apiOrigin: string;
  site: string;
  fetch?: typeof globalThis.fetch;
  githubFetch?: typeof globalThis.fetch;
  counterStorage?: CounterStorage;
}

export interface CounterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Authorization {
  authorizationUrl: string;
  state: string;
}

export interface AccessToken {
  value: string;
  expiresAt: number;
  creationGrant: string;
  viewerId?: string;
  viewerLogin?: string;
  viewerAvatarUrl?: string;
}

export interface EnsuredDiscussion {
  id: string;
  number: number;
}

export interface DiscussionContent {
  readonly discussion: Record<string, unknown>;
  readonly comments: readonly Record<string, unknown>[];
}

export interface AddedComment {
  readonly id: string;
  readonly body?: string;
  readonly url?: string;
}

export class FeedbackClient {
  readonly #apiOrigin: string;
  readonly #site: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #githubFetch: typeof globalThis.fetch;
  readonly #counterStorage: CounterStorage | undefined;

  constructor(options: ClientOptions) {
    const origin = new URL(options.apiOrigin);
    if (origin.pathname !== "/" || origin.search || origin.hash) {
      throw new TypeError("apiOrigin must contain only an origin");
    }
    validateResourceId(options.site);
    this.#apiOrigin = origin.origin;
    this.#site = options.site;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#githubFetch = options.githubFetch ?? globalThis.fetch.bind(globalThis);
    this.#counterStorage = options.counterStorage ?? browserStorage();
  }

  cachedReactions(keys: Iterable<string>): ReadonlyMap<string, ReactionState> {
    const result = new Map<string, ReactionState>();
    for (const key of new Set(Array.from(keys, validateResourceId))) {
      const cached = this.#cachedReaction(key);
      if (cached !== null) result.set(key, cached);
    }
    return result;
  }

  async reactions(keys: Iterable<string>, signal?: AbortSignal): Promise<ReadonlyMap<string, ReactionState>> {
    const normalized = [...new Set(Array.from(keys, validateResourceId))].sort();
    if (normalized.length === 0) throw new TypeError("At least one resource key is required");
    const url = new URL(`/v1/sites/${encodeURIComponent(this.#site)}/reactions`, this.#apiOrigin);
    url.searchParams.set("keys", normalized.join(","));
    const init: RequestInit = { headers: { Accept: "application/json" } };
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) throw new FeedbackError(response.status, await errorCode(response));
    const payload: unknown = await response.json();
    if (!isEnvelope(payload, this.#site)) throw new TypeError("Invalid feedback service response");
    const result = new Map<string, ReactionState>();
    for (const key of normalized) {
      const state = payload.items[key] ?? emptyState();
      if (!isCounterState(state)) throw new TypeError("Invalid feedback service response");
      const cached = this.#cachedReaction(key);
      const combined = {
        ...state,
        viewerHasUpvoted: cached?.viewerHasUpvoted ?? false,
        viewerKnown: cached?.viewerKnown ?? false,
      };
      result.set(key, combined);
      this.#storeReaction(key, combined);
    }
    return result;
  }

  async syncViewerUpvotes(
    keys: Iterable<string>,
    token: AccessToken,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, ReactionState>> {
    const normalized = [...new Set(Array.from(keys, validateResourceId))].sort();
    if (normalized.length === 0) throw new TypeError("At least one resource key is required");
    const pending = normalized.filter((key) => this.#viewerNeedsSync(key, token.viewerId));
    if (pending.length > 0) {
      const missing = pending.filter((key) => this.#cachedReaction(key)?.id === null);
      if (missing.length > 0) await this.reactions(missing, signal);
      const ids = pending.flatMap((key) => {
        const id = this.#cachedReaction(key)?.id;
        return id === null || id === undefined ? [] : [id];
      });
      const states = await viewerUpvotes(token, ids, this.#githubFetch, signal);
      for (const key of pending) {
        const cached = this.#cachedReaction(key) ?? emptyState();
        const viewerHasUpvoted = cached.id === null ? false : states.get(cached.id) ?? false;
        this.#storeReaction(
          key,
          {
            ...cached,
            viewerHasUpvoted,
            viewerKnown: true,
          },
          true,
          token.viewerId,
        );
      }
    }
    return this.cachedReactions(normalized);
  }

  async authorize(challenge: string, nonce: string, signal?: AbortSignal): Promise<Authorization> {
    const payload = await this.#post("oauth/authorize", { challenge, nonce }, signal);
    const url = payload.authorization_url;
    const state = payload.state;
    if (typeof url !== "string" || new URL(url).origin !== "https://github.com" || typeof state !== "string") {
      throw new TypeError("Invalid authorization response");
    }
    return { authorizationUrl: url, state };
  }

  async exchange(code: string, state: string, verifier: string, signal?: AbortSignal): Promise<AccessToken> {
    const payload = await this.#post("oauth/exchange", { code, state, verifier }, signal);
    const value = payload.access_token;
    const expiresAt = payload.expires_at;
    const creationGrant = payload.creation_grant;
    if (
      typeof value !== "string" ||
      !value.startsWith("ghu_") ||
      !Number.isSafeInteger(expiresAt) ||
      typeof creationGrant !== "string"
    ) {
      throw new TypeError("Invalid token response");
    }
    return { value, expiresAt: expiresAt as number, creationGrant };
  }

  async ensure(resource: Resource, grant: string, signal?: AbortSignal): Promise<EnsuredDiscussion> {
    const body: Record<string, unknown> = { ...resource, grant };
    const payload = await this.#post(
      "discussions/ensure",
      body,
      signal,
    );
    if (
      typeof payload.id !== "string" ||
      typeof payload.number !== "number" ||
      !Number.isSafeInteger(payload.number) ||
      payload.number < 1
    ) {
      throw new TypeError("Invalid discussion response");
    }
    return { id: payload.id, number: payload.number };
  }

  async discussionContent(key: string, signal?: AbortSignal): Promise<DiscussionContent> {
    const contents = await this.discussionContents([key], signal);
    const content = contents.get(key);
    if (content === undefined) throw new TypeError("Invalid discussion content response");
    return content;
  }

  async discussionContents(
    keys: Iterable<string>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, DiscussionContent>> {
    const normalized = [...new Set(Array.from(keys, validateResourceId))].sort();
    if (normalized.length === 0) throw new TypeError("At least one resource key is required");
    const url = new URL(`/v1/sites/${encodeURIComponent(this.#site)}/discussion`, this.#apiOrigin);
    url.searchParams.set("keys", normalized.join(","));
    const init: RequestInit = { headers: { Accept: "application/json" } };
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) throw new FeedbackError(response.status, await errorCode(response));
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || (payload as { v?: unknown }).v !== 1) {
      throw new TypeError("Invalid discussion content response");
    }
    const items = (payload as { items?: unknown }).items;
    if (!items || typeof items !== "object") throw new TypeError("Invalid discussion content response");
    const result = new Map<string, DiscussionContent>();
    for (const key of normalized) {
      const content = (items as Record<string, unknown>)[key];
      if (!content || typeof content !== "object") throw new TypeError("Invalid discussion content response");
      result.set(key, { discussion: content as Record<string, unknown>, comments: [] });
    }
    return result;
  }

  async addComment(
    key: string,
    body: string,
    token: AccessToken,
    replyTo?: string,
    signal?: AbortSignal,
  ): Promise<AddedComment> {
    validateResourceId(key);
    if (!body.trim() || body.length > 16_000) throw new TypeError("Invalid comment body");
    const discussionId = await this.#discussionId(key, signal);
    return addGitHubComment(token, discussionId, body, replyTo, this.#githubFetch, signal);
  }

  async toggleUpvote(
    key: string,
    token: AccessToken,
    signal?: AbortSignal,
  ): Promise<UpvoteResult> {
    validateResourceId(key);
    const discussionId = await this.#discussionId(key, signal);
    const cachedBefore = this.#cachedReaction(key);
    const current = cachedBefore?.viewerKnown === true ? cachedBefore.viewerHasUpvoted
      : (await viewerUpvotes(token, [discussionId], this.#githubFetch, signal))
        .get(discussionId) ?? false;
    const result = await toggleGitHubUpvote(
      token, discussionId, current, this.#githubFetch, signal,
    );
    const cached = this.#cachedReaction(key);
    this.#storeReaction(key, {
      id: cached?.id ?? null,
      ...(cached?.number === undefined ? {} : { number: cached.number }),
      upvotes: result.count,
      ...(cached?.reactions === undefined ? {} : { reactions: cached.reactions }),
      viewerHasUpvoted: result.viewerHasUpvoted,
      viewerKnown: true,
    }, true, token.viewerId);
    return result;
  }

  async #discussionId(key: string, signal?: AbortSignal): Promise<string> {
    const cached = this.#cachedReaction(key);
    if (cached?.id) return cached.id;
    const state = (await this.reactions([key], signal)).get(key);
    if (!state?.id) throw new FeedbackError(404, "discussion_not_found");
    return state.id;
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`/v1/sites/${encodeURIComponent(this.#site)}/${path}`, this.#apiOrigin);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) throw new FeedbackError(response.status, await errorCode(response));
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || (payload as { v?: unknown }).v !== 1) {
      throw new TypeError("Invalid feedback service response");
    }
    return payload as Record<string, unknown>;
  }

  #cachedReaction(key: string): ReactionState | null {
    if (this.#counterStorage === undefined) return null;
    try {
      const raw = this.#counterStorage.getItem(counterKey(this.#site, key));
      if (raw === null) return null;
      const value = JSON.parse(raw) as { savedAt?: unknown; state?: unknown };
      if (
        !Number.isSafeInteger(value.savedAt) ||
        Date.now() - (value.savedAt as number) > 7 * 24 * 60 * 60 * 1000 ||
        !isStoredReactionState(value.state)
      ) {
        this.#counterStorage.removeItem(counterKey(this.#site, key));
        return null;
      }
      return {
        ...value.state,
        viewerKnown: value.state.viewerKnown ?? false,
      };
    } catch {
      return null;
    }
  }

  #storeReaction(
    key: string,
    state: ReactionState,
    viewerConfirmed = false,
    viewerId?: string,
  ): void {
    try {
      let viewerCheckedAt: number | null = null;
      let existingViewerId: string | undefined;
      const existing = this.#counterStorage?.getItem(counterKey(this.#site, key));
      if (existing !== null && existing !== undefined) {
        const parsed = JSON.parse(existing) as { viewerCheckedAt?: unknown; viewerId?: unknown };
        if (Number.isSafeInteger(parsed.viewerCheckedAt)) viewerCheckedAt = parsed.viewerCheckedAt as number;
        if (typeof parsed.viewerId === "string") existingViewerId = parsed.viewerId;
      }
      this.#counterStorage?.setItem(
        counterKey(this.#site, key),
        JSON.stringify({
          savedAt: Date.now(),
          viewerCheckedAt: viewerConfirmed ? Date.now() : viewerCheckedAt,
          viewerId: viewerConfirmed ? viewerId : existingViewerId,
          state,
        }),
      );
    } catch {
      // Storage may be disabled or full; counters still work from the network.
    }
  }


  #viewerNeedsSync(key: string, viewerId?: string): boolean {
    if (this.#counterStorage === undefined) return true;
    try {
      const raw = this.#counterStorage.getItem(counterKey(this.#site, key));
      if (raw === null) return true;
      const value = JSON.parse(raw) as {
        viewerCheckedAt?: unknown;
        viewerId?: unknown;
        state?: unknown;
      };
      return !isStoredReactionState(value.state) ||
        !value.state.viewerKnown ||
        (viewerId !== undefined && value.viewerId !== viewerId) ||
        !Number.isSafeInteger(value.viewerCheckedAt) ||
        Date.now() - (value.viewerCheckedAt as number) >= 5 * 60 * 1000;
    } catch {
      return true;
    }
  }
}

export class FeedbackError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Feedback request failed: ${code}`);
  }
}

function emptyState(): ReactionState {
  return {
    id: null,
    upvotes: 0,
    viewerHasUpvoted: false,
    viewerKnown: false,
  };
}

function isEnvelope(value: unknown, site: string): value is ReactionEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReactionEnvelope>;
  return candidate.v === 1 && candidate.site === site && !!candidate.items && typeof candidate.items === "object";
}

function isCounterState(value: unknown): value is CounterState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ReactionState>;
  return (
    (state.id === null || typeof state.id === "string") &&
    (state.number === undefined || state.number === null ||
      Number.isSafeInteger(state.number) && state.number > 0) &&
    Number.isSafeInteger(state.upvotes) && (state.upvotes ?? -1) >= 0 &&
    (state.reactions === undefined || typeof state.reactions === "object")
  );
}

function isStoredReactionState(value: unknown): value is StoredReactionState {
  return isCounterState(value) &&
    typeof (value as Partial<ReactionState>).viewerHasUpvoted === "boolean" &&
    ((value as Partial<ReactionState>).viewerKnown === undefined ||
      typeof (value as Partial<ReactionState>).viewerKnown === "boolean");
}

function counterKey(site: string, resource: string): string {
  return `cppsocial.feedback.v1.${site}.reaction.${resource}`;
}

function browserStorage(): CounterStorage | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : "request_failed";
  } catch {
    return "request_failed";
  }
}
