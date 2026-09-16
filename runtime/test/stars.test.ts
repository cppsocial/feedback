import assert from "node:assert/strict";
import test from "node:test";

import { Stars, type KeyValueStorage } from "../src/feedback/stars.js";

void test("stars persist per site and sort without disturbing order within groups", () => {
  const values = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const stars = new Stars("cpp-social", storage);
  stars.toggle("b");

  assert.deepEqual(stars.starredFirst(["a", "b", "c"], (value) => value), ["b", "a", "c"]);
  assert.equal(new Stars("cpp-social", storage).has("b"), true);
  assert.equal(new Stars("other-site", storage).has("b"), false);
});
