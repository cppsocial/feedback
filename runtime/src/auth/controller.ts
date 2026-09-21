import type { AccessToken, Authorization } from "../api/client.js";
import type { KeyValueStorage } from "../storage.js";
import { trustedOrigin } from "./origin.js";
import { SessionTokenStore } from "./session.js";
import viewerQuery from "../protocol/queries/viewer.graphql";

export interface OAuthTransport {
  authorize(challenge: string, nonce: string, signal?: AbortSignal): Promise<Authorization>;
  exchange(code: string, state: string, verifier: string, signal?: AbortSignal): Promise<AccessToken>;
}

export interface AuthPopup {
  readonly source: unknown;
  readonly closed: boolean;
  navigate(url: string): void;
  close(): void;
}

export interface AuthMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface AuthEnvironment {
  crypto: Crypto;
  openPopup(): AuthPopup | null;
  listen(handler: (message: AuthMessage) => void): () => void;
  timeout(handler: () => void, milliseconds: number): () => void;
  interval(handler: () => void, milliseconds: number): () => void;
}

export interface AuthenticationOptions {
  site: string;
  callbackOrigin: string;
  service: OAuthTransport;
  storage?: KeyValueStorage;
  githubFetch?: typeof globalThis.fetch;
  environment?: AuthEnvironment;
  timeoutMilliseconds?: number;
}

export class AuthenticationError extends Error {
  constructor(readonly code: string) {
    super(`Authentication failed: ${code}`);
  }
}

export class Authentication {
  readonly #service: OAuthTransport;
  readonly #callbackOrigin: string;
  readonly #tokens: SessionTokenStore;
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: AuthEnvironment;
  readonly #timeout: number;

  constructor(options: AuthenticationOptions) {
    this.#service = options.service;
    this.#callbackOrigin = trustedOrigin(options.callbackOrigin, "callbackOrigin");
    this.#tokens = new SessionTokenStore(
      options.site,
      options.storage ?? sessionStorage,
    );
    this.#fetch = options.githubFetch ?? globalThis.fetch.bind(globalThis);
    this.#environment = options.environment ?? browserEnvironment();
    this.#timeout = options.timeoutMilliseconds ?? 120_000;
  }

  token(): AccessToken | null {
    return this.#tokens.get();
  }

  clear(): void {
    this.#tokens.clear();
  }

  authenticate(signal?: AbortSignal): Promise<AccessToken> {
    const popup = this.#environment.openPopup();
    if (popup === null) return Promise.reject(new AuthenticationError("popup_blocked"));
    return this.#complete(popup, signal);
  }

  async #complete(popup: AuthPopup, signal?: AbortSignal): Promise<AccessToken> {
    try {
      const verifier = randomBase64Url(this.#environment.crypto, 32);
      const nonce = randomBase64Url(this.#environment.crypto, 24);
      const challenge = await sha256Base64Url(this.#environment.crypto, verifier);
      const authorization = await this.#service.authorize(challenge, nonce, signal);
      popup.navigate(authorization.authorizationUrl);
      const code = await waitForCallback(
        this.#environment,
        popup,
        this.#callbackOrigin,
        authorization.state,
        this.#timeout,
        signal,
      );
      const token = await this.#service.exchange(code, authorization.state, verifier, signal);
      const viewer = await validateViewer(this.#fetch, token.value, signal);
      const authenticated = {
        ...token,
        viewerId: viewer.id,
        viewerLogin: viewer.login,
        viewerAvatarUrl: viewer.avatarUrl,
      };
      this.#tokens.set(authenticated);
      return authenticated;
    } catch (error) {
      this.#tokens.clear();
      throw error;
    } finally {
      popup.close();
    }
  }
}

interface CallbackData {
  type: "cppsocial-feedback-oauth";
  state: string;
  code?: string;
  error?: string;
}

function waitForCallback(
  environment: AuthEnvironment,
  popup: AuthPopup,
  callbackOrigin: string,
  state: string,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten = (): void => undefined;
    let cancelTimeout = (): void => undefined;
    let cancelInterval = (): void => undefined;
    const finish = (result: string | AuthenticationError): void => {
      if (settled) return;
      settled = true;
      unlisten();
      cancelTimeout();
      cancelInterval();
      signal?.removeEventListener("abort", aborted);
      if (typeof result === "string") resolve(result);
      else reject(result);
    };
    unlisten = environment.listen((message) => {
      if (message.origin !== callbackOrigin || message.source !== popup.source) return;
      if (!isCallbackData(message.data) || message.data.state !== state) return;
      if (message.data.error) finish(new AuthenticationError("authorization_denied"));
      else if (message.data.code) finish(message.data.code);
    });
    cancelTimeout = environment.timeout(
      () => { finish(new AuthenticationError("timeout")); },
      timeoutMilliseconds,
    );
    cancelInterval = environment.interval(() => {
      if (popup.closed) finish(new AuthenticationError("popup_closed"));
    }, 250);
    const aborted = (): void => { finish(new AuthenticationError("aborted")); };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function isCallbackData(value: unknown): value is CallbackData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CallbackData>;
  return (
    data.type === "cppsocial-feedback-oauth" &&
    typeof data.state === "string" &&
    (typeof data.code === "string" || typeof data.error === "string")
  );
}

async function validateViewer(
  fetch: typeof globalThis.fetch,
  token: string,
  signal?: AbortSignal,
): Promise<{ id: string; login: string; avatarUrl: string }> {
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: viewerQuery }),
  };
  if (signal) init.signal = signal;
  const response = await fetch("https://api.github.com/graphql", init);
  if (!response.ok) throw new AuthenticationError("token_invalid");
  const body: unknown = await response.json();
  const result = viewer(body);
  if (result === null) throw new AuthenticationError("token_invalid");
  return result;
}

function viewer(value: unknown): { id: string; login: string; avatarUrl: string } | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const viewer = (data as { viewer?: unknown }).viewer;
  if (!viewer || typeof viewer !== "object") return null;
  const candidate = viewer as { id?: unknown; login?: unknown; avatarUrl?: unknown };
  return typeof candidate.id === "string" && typeof candidate.login === "string" &&
    typeof candidate.avatarUrl === "string"
    ? { id: candidate.id, login: candidate.login, avatarUrl: candidate.avatarUrl }
    : null;
}

function randomBase64Url(crypto: Crypto, size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return base64Url(bytes);
}

async function sha256Base64Url(crypto: Crypto, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function browserEnvironment(): AuthEnvironment {
  return {
    crypto: globalThis.crypto,
    openPopup: () => {
      const popup = window.open("about:blank", "cppsocial-feedback-oauth", "popup,width=720,height=760");
      return popup
        ? {
            source: popup,
            get closed() { return popup.closed; },
            navigate: (url) => { popup.location.replace(url); },
            close: () => { popup.close(); },
          }
        : null;
    },
    listen: (handler) => {
      const listener = (event: MessageEvent<unknown>): void => { handler(event); };
      window.addEventListener("message", listener);
      return () => { window.removeEventListener("message", listener); };
    },
    timeout: (handler, milliseconds) => {
      const id = window.setTimeout(handler, milliseconds);
      return () => { window.clearTimeout(id); };
    },
    interval: (handler, milliseconds) => {
      const id = window.setInterval(handler, milliseconds);
      return () => { window.clearInterval(id); };
    },
  };
}
