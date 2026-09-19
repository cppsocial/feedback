import { validateResourceId } from "../feedback/resources.js";
import type { Resource } from "../feedback/resources.js";
import type { ViewerVote, Vote, VoteResult } from "../protocol/github.js";

interface CounterState {
  id: string | null;
  up: number;
  down: number;
  upvotes: number;
  reactions: Record<string, number>;
  age: number;
  stale: boolean;
}

type StoredReactionState = CounterState & {
  viewer: ViewerVote;
  viewerKnown?: boolean;
  starred?: boolean;
};

export interface ReactionState extends CounterState {
  viewer: ViewerVote;
  viewerKnown: boolean;
  starred: boolean;
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
}

export interface EnsuredDiscussion {
  id: string;
  number: number;
}

export class FeedbackClient {
  readonly #apiOrigin: string;
  readonly #site: string;
  readonly #fetch: typeof globalThis.fetch;
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
        viewer: cached?.viewer ?? "none",
        viewerKnown: cached?.viewerKnown ?? false,
        starred: cached?.starred ?? false,
      };
      result.set(key, combined);
      this.#storeReaction(key, combined);
    }
    return result;
  }

  async syncViewerReactions(
    keys: Iterable<string>,
    token: AccessToken,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, ReactionState>> {
    const normalized = [...new Set(Array.from(keys, validateResourceId))].sort();
    if (normalized.length === 0) throw new TypeError("At least one resource key is required");
    const pending = normalized.filter((key) => this.#viewerNeedsSync(key, token.viewerId));
    if (pending.length > 0) {
      const url = new URL(`/v1/sites/${encodeURIComponent(this.#site)}/viewer-reactions`, this.#apiOrigin);
      url.searchParams.set("keys", pending.join(","));
      const headers = { Accept: "application/json", Authorization: `Bearer ${token.value}` };
      const init: RequestInit = { headers };
      if (signal) init.signal = signal;
      const response = await this.#fetch(url, init);
      if (!response.ok) throw new FeedbackError(response.status, await errorCode(response));
      const payload: unknown = await response.json();
      if (!isViewerEnvelope(payload, this.#site, pending)) {
        throw new TypeError("Invalid feedback service response");
      }
      for (const key of pending) {
        const cached = this.#cachedReaction(key) ?? emptyState();
        this.#storeReaction(
          key,
          {
            ...cached,
            viewer: payload.items[key]?.vote ?? "none",
            starred: payload.items[key]?.starred ?? false,
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

  async vote(
    key: string,
    requested: Vote,
    token: AccessToken,
    signal?: AbortSignal,
  ): Promise<VoteResult> {
    validateResourceId(key);
    const payload = await this.#post(
      "votes",
      { key, vote: requested },
      signal,
      token.value,
    );
    const up = payload.up;
    const down = payload.down;
    const viewer = payload.viewer;
    if (
      !Number.isSafeInteger(up) || (up as number) < 0 ||
      !Number.isSafeInteger(down) || (down as number) < 0 ||
      (viewer !== "up" && viewer !== "down" && viewer !== "both" && viewer !== "none")
    ) {
      throw new TypeError("Invalid vote response");
    }
    const result: VoteResult = { up: up as number, down: down as number, viewer };
    const cached = this.#cachedReaction(key);
    this.#storeReaction(key, {
      id: cached?.id ?? null,
      up: result.up,
      down: result.down,
      age: 0,
      stale: true,
      viewer: result.viewer,
      viewerKnown: true,
      starred: cached?.starred ?? false,
    }, true, token.viewerId);
    return result;
  }

  async toggleStar(key: string, token: AccessToken, signal?: AbortSignal): Promise<boolean> {
    validateResourceId(key);
    const payload = await this.#post("stars", { key }, signal, token.value);
    if (typeof payload.starred !== "boolean") throw new TypeError("Invalid star response");
    const cached = this.#cachedReaction(key) ?? emptyState();
    this.#storeReaction(
      key,
      { ...cached, starred: payload.starred, viewerKnown: true },
      true,
      token.viewerId,
    );
    return payload.starred;
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
      const elapsed = Math.max(0, Math.floor((Date.now() - (value.savedAt as number)) / 1000));
      return {
        ...value.state,
        viewerKnown: value.state.viewerKnown ?? false,
        starred: value.state.starred ?? false,
        age: value.state.age + elapsed,
        stale: true,
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
    up: 0,
    down: 0,
    upvotes: 0,
    reactions: {},
    age: 0,
    stale: false,
    viewer: "none",
    viewerKnown: false,
    starred: false,
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
    Number.isSafeInteger(state.up) && (state.up ?? -1) >= 0 &&
    Number.isSafeInteger(state.down) && (state.down ?? -1) >= 0 &&
    Number.isSafeInteger(state.upvotes) && (state.upvotes ?? -1) >= 0 &&
    !!state.reactions && typeof state.reactions === "object" &&
    Number.isSafeInteger(state.age) && (state.age ?? -1) >= 0 &&
    typeof state.stale === "boolean"
  );
}

function isStoredReactionState(value: unknown): value is StoredReactionState {
  return isCounterState(value) &&
    isViewerVote((value as Partial<ReactionState>).viewer) &&
    ((value as Partial<ReactionState>).viewerKnown === undefined ||
      typeof (value as Partial<ReactionState>).viewerKnown === "boolean") &&
    ((value as Partial<ReactionState>).starred === undefined ||
      typeof (value as Partial<ReactionState>).starred === "boolean");
}

function isViewerVote(value: unknown): value is ViewerVote {
  return value === "up" || value === "down" || value === "both" || value === "none";
}

function isViewerEnvelope(
  value: unknown,
  site: string,
  keys: readonly string[],
): value is {
  v: 1;
  site: string;
  items: Record<string, { vote: ViewerVote; starred: boolean }>;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { v?: unknown; site?: unknown; items?: unknown };
  if (candidate.v !== 1 || candidate.site !== site || !candidate.items || typeof candidate.items !== "object") {
    return false;
  }
  const items = candidate.items as Record<string, unknown>;
  return Object.keys(items).length === keys.length && keys.every((key) => {
    const item = items[key];
    return !!item && typeof item === "object" &&
      isViewerVote((item as { vote?: unknown }).vote) &&
      typeof (item as { starred?: unknown }).starred === "boolean";
  });
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
