import { validateResourceId } from "./resources.js";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class Stars {
  readonly #storage: KeyValueStorage;
  readonly #storageKey: string;
  #values: Set<string>;

  constructor(site: string, storage: KeyValueStorage = localStorage) {
    validateResourceId(site);
    this.#storage = storage;
    this.#storageKey = `cppsocial.feedback.v1.${site}.stars`;
    this.#values = read(storage.getItem(this.#storageKey));
  }

  has(key: string): boolean {
    return this.#values.has(validateResourceId(key));
  }

  toggle(key: string): boolean {
    validateResourceId(key);
    const starred = !this.#values.has(key);
    if (starred) this.#values.add(key);
    else this.#values.delete(key);
    this.#storage.setItem(this.#storageKey, JSON.stringify([...this.#values].sort()));
    return starred;
  }

  starredFirst<T>(values: Iterable<T>, key: (value: T) => string): T[] {
    return Array.from(values).sort((left, right) => Number(this.has(key(right))) - Number(this.has(key(left))));
  }
}

function read(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string").filter(isValid));
  } catch {
    return new Set();
  }
}

function isValid(value: string): boolean {
  try {
    validateResourceId(value);
    return true;
  } catch {
    return false;
  }
}
