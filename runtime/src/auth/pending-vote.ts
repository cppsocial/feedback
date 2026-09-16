import type { Vote } from "../protocol/github.js";
import type { KeyValueStorage } from "../feedback/stars.js";

export interface PendingVote {
  resourceKey: string;
  vote: Vote;
}

export class PendingVoteStore {
  readonly #storage: KeyValueStorage;
  readonly #key: string;

  constructor(site: string, storage: KeyValueStorage = sessionStorage) {
    this.#storage = storage;
    this.#key = `cppsocial.feedback.v1.${site}.pending-vote`;
  }

  set(resourceKey: string, vote: Vote): void {
    this.#storage.setItem(this.#key, JSON.stringify({ resourceKey, vote }));
  }

  take(): PendingVote | null {
    const raw = this.#storage.getItem(this.#key);
    this.clear();
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Partial<PendingVote>;
      if (
        typeof value.resourceKey !== "string" ||
        (value.vote !== "up" && value.vote !== "down")
      ) {
        return null;
      }
      return { resourceKey: value.resourceKey, vote: value.vote };
    } catch {
      return null;
    }
  }

  clear(): void {
    this.#storage.removeItem(this.#key);
  }
}
