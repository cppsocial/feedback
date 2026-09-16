import assert from "node:assert/strict";
import test from "node:test";

import { PendingVoteStore } from "../src/auth/pending-vote.js";
import type { KeyValueStorage } from "../src/feedback/stars.js";

void test("a pending vote is session-scoped and consumed once", () => {
  const values = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const pending = new PendingVoteStore("cpp-social", storage);

  pending.set("feedback/example", "up");

  assert.deepEqual(pending.take(), { resourceKey: "feedback/example", vote: "up" });
  assert.equal(pending.take(), null);
});
