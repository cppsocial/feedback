import assert from "node:assert/strict";
import test from "node:test";

import { lookupTerm, validateResourceId } from "../src/feedback/resources.js";

void test("resource IDs and mappings match the protocol", () => {
  assert.equal(validateResourceId("books/cpp-concurrency"), "books/cpp-concurrency");
  assert.throws(() => validateResourceId("../book"), /Invalid/);
  assert.equal(lookupTerm("title", { key: "book", title: " A Book " }), "A Book");
  assert.equal(lookupTerm("pathname", { key: "book", url: "https://cpp.social/books/a" }), "/books/a");
  assert.equal(lookupTerm("number", { key: "book", number: 42 }), "42");
});
