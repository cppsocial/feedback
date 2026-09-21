import type { AccessToken } from "../api/client.js";

import type { KeyValueStorage } from "../storage.js";

interface StoredToken {
  value: string;
  expiresAt: number;
  creationGrant: string;
  viewerId: string;
}

export class SessionTokenStore {
  readonly #storage: KeyValueStorage;
  readonly #key: string;
  readonly #clock: () => number;

  constructor(site: string, storage: KeyValueStorage, clock: () => number = Date.now) {
    this.#storage = storage;
    this.#key = `cppsocial.feedback.v1.${site}.token`;
    this.#clock = clock;
  }

  get(): AccessToken | null {
    const raw = this.#storage.getItem(this.#key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredToken>;
      if (
        typeof parsed.value !== "string" ||
        !parsed.value.startsWith("ghu_") ||
        !Number.isSafeInteger(parsed.expiresAt) ||
        typeof parsed.creationGrant !== "string" ||
        typeof parsed.viewerId !== "string" ||
        parsed.viewerId.length === 0 ||
        (parsed.expiresAt ?? 0) * 1000 <= this.#clock()
      ) {
        this.clear();
        return null;
      }
      return {
        value: parsed.value,
        expiresAt: parsed.expiresAt,
        creationGrant: parsed.creationGrant,
        viewerId: parsed.viewerId,
      } as AccessToken;
    } catch {
      this.clear();
      return null;
    }
  }

  set(token: AccessToken): void {
    this.#storage.setItem(this.#key, JSON.stringify(token));
  }

  clear(): void {
    this.#storage.removeItem(this.#key);
  }
}
