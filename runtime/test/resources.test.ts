import assert from "node:assert/strict";
import test from "node:test";

import { lookupTerm, resourceFromDocument, validateResourceId } from "../src/feedback/resources.js";

void test("resource IDs and mappings match the protocol", () => {
  assert.equal(validateResourceId("books/cpp-concurrency"), "books/cpp-concurrency");
  assert.throws(() => validateResourceId("../book"), /Invalid/);
  assert.equal(lookupTerm("key", { key: "book" }), "book");
  assert.equal(lookupTerm("custom", { key: "book", custom: "feedback:book" }), "feedback:book");
  assert.equal(lookupTerm("title", { key: "book", title: " A Book " }), "A Book");
  assert.equal(lookupTerm("pathname", { key: "book", url: "https://cpp.social/books/a" }), "/books/a");
  assert.equal(lookupTerm("number", { key: "book", number: 42 }), "42");
});

void test("document resources prefer Open Graph metadata and allow custom selectors", () => {
  const values = new Map<string, { getAttribute(name: string): string | null; textContent: string | null }>([
    ['meta[property="og:title"]', { getAttribute: (name) => name === "content" ? "Open Graph" : null, textContent: null }],
    ["title", { getAttribute: () => null, textContent: "Document title" }],
    ['meta[name="custom"]', { getAttribute: (name) => name === "content" ? "Custom title" : null, textContent: null }],
    ['link[rel="canonical"]', { getAttribute: (name) => name === "href" ? "/canonical" : null, textContent: null }],
  ]);
  const document = {
    baseURI: "https://cpp.social/current",
    querySelector: (selector: string) => values.get(selector) ?? null,
  } as unknown as Document;
  const location = { href: "https://cpp.social/current#section" } as Location;

  const defaults = resourceFromDocument({ key: "article", document, location });
  const custom = resourceFromDocument({
    key: "custom",
    document,
    location,
    titleSelectors: ['meta[name="custom"]'],
  });

  assert.equal(defaults.title, "Open Graph");
  assert.equal(defaults.url, "https://cpp.social/canonical");
  assert.equal(defaults.pathname, "/canonical");
  assert.equal(custom.title, "Custom title");
});
