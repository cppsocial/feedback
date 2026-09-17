import { validateResourceId } from "../feedback/resources.js";
import type { Resource } from "../feedback/resources.js";
import type { Vote, VoteResult } from "../protocol/github.js";

export interface ReactionState {
  id: string | null;
  up: number;
  down: number;
  age: number;
  stale: boolean;
}

interface ReactionEnvelope {
  v: 1;
  site: string;
  items: Record<string, ReactionState>;
}

export interface ClientOptions {
  apiOrigin: string;
  site: string;
  fetch?: typeof globalThis.fetch;
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

  constructor(options: ClientOptions) {
    const origin = new URL(options.apiOrigin);
    if (origin.pathname !== "/" || origin.search || origin.hash) {
      throw new TypeError("apiOrigin must contain only an origin");
    }
    validateResourceId(options.site);
    this.#apiOrigin = origin.origin;
    this.#site = options.site;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
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
    return new Map(normalized.map((key) => [key, payload.items[key] ?? emptyState()]));
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
      (viewer !== "up" && viewer !== "down" && viewer !== "none")
    ) {
      throw new TypeError("Invalid vote response");
    }
    return { up: up as number, down: down as number, viewer };
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
}

export class FeedbackError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Feedback request failed: ${code}`);
  }
}

function emptyState(): ReactionState {
  return { id: null, up: 0, down: 0, age: 0, stale: false };
}

function isEnvelope(value: unknown, site: string): value is ReactionEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReactionEnvelope>;
  return candidate.v === 1 && candidate.site === site && !!candidate.items && typeof candidate.items === "object";
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : "request_failed";
  } catch {
    return "request_failed";
  }
}
