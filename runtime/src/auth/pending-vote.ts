import type { KeyValueStorage } from "../storage.js";

export interface PendingVote {
  resourceKey: string;
}

export class PendingVoteStore {
  readonly #storage: KeyValueStorage;
  readonly #key: string;

  constructor(site: string, storage: KeyValueStorage = sessionStorage) {
    this.#storage = storage;
    this.#key = `cppsocial.feedback.v1.${site}.pending-vote`;
  }

  set(resourceKey: string): void {
    this.#storage.setItem(this.#key, JSON.stringify({ resourceKey }));
  }

  take(): PendingVote | null {
    const raw = this.#storage.getItem(this.#key);
    this.clear();
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Partial<PendingVote>;
      if (
        typeof value.resourceKey !== "string"
      ) {
        return null;
      }
      return { resourceKey: value.resourceKey };
    } catch {
      return null;
    }
  }

  clear(): void {
    this.#storage.removeItem(this.#key);
  }
}
