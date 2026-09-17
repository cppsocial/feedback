import { validateResourceId } from "../feedback/resources.js";
import type { Resource } from "../feedback/resources.js";
import type { ViewerVote, Vote, VoteResult } from "../protocol/github.js";

interface CounterState {
  id: string | null;
  up: number;
  down: number;
  age: number;
  stale: boolean;
}

export interface ReactionState extends CounterState {
  viewer: ViewerVote;
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
      const combined = { ...state, viewer: this.#cachedReaction(key)?.viewer ?? "none" };
      result.set(key, combined);
      this.#storeReaction(key, combined);
    }
    return result;
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
    });
    return result;
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
        !isReactionState(value.state)
      ) {
        this.#counterStorage.removeItem(counterKey(this.#site, key));
        return null;
      }
      const elapsed = Math.max(0, Math.floor((Date.now() - (value.savedAt as number)) / 1000));
      return { ...value.state, age: value.state.age + elapsed, stale: true };
    } catch {
      return null;
    }
  }

  #storeReaction(key: string, state: ReactionState): void {
    try {
      this.#counterStorage?.setItem(
        counterKey(this.#site, key),
        JSON.stringify({ savedAt: Date.now(), state }),
      );
    } catch {
      // Storage may be disabled or full; counters still work from the network.
    }
  }
}

export class FeedbackError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Feedback request failed: ${code}`);
  }
}

function emptyState(): ReactionState {
  return { id: null, up: 0, down: 0, age: 0, stale: false, viewer: "none" };
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
    Number.isSafeInteger(state.age) && (state.age ?? -1) >= 0 &&
    typeof state.stale === "boolean"
  );
}

function isReactionState(value: unknown): value is ReactionState {
  return isCounterState(value) && isViewerVote((value as Partial<ReactionState>).viewer);
}

function isViewerVote(value: unknown): value is ViewerVote {
  return value === "up" || value === "down" || value === "both" || value === "none";
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
