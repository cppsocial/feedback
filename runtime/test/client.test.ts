import assert from "node:assert/strict";
import test from "node:test";

import { FeedbackClient } from "../src/api/client.js";

void test("reaction requests have stable sorted cache keys", async () => {
  let requested = "";
  const fetch = (input: URL | RequestInfo): Promise<Response> => {
    requested = input instanceof Request ? input.url : input.toString();
    return Promise.resolve(Response.json({
      v: 1,
      site: "cpp-social",
      items: { a: { id: null, up: 0, down: 0, age: 0, stale: false } },
    }));
  };
  const client = new FeedbackClient({ apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch });

  const result = await client.reactions(["b", "a", "b"]);

  assert.equal(requested, "https://feedback-api.cpp.social/v1/sites/cpp-social/reactions?keys=a%2Cb");
  assert.equal(result.get("b")?.id, null);
});

void test("OAuth transport sends JSON only to the configured site", async () => {
  const requests: Request[] = [];
  const fetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("oauth/authorize")) {
      return Promise.resolve(Response.json({
        v: 1,
        authorization_url: "https://github.com/login/oauth/authorize?client_id=x",
        state: "signed-state",
      }));
    }
    return Promise.resolve(Response.json({
      v: 1,
      access_token: "ghu_user",
      expires_at: 1234,
      creation_grant: "grant",
    }));
  };
  const client = new FeedbackClient({ apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch });

  const authorization = await client.authorize("challenge", "nonce");
  const token = await client.exchange("code", authorization.state, "verifier");

  assert.equal(requests.length, 2);
  const authorizationRequest = requests[0];
  assert.ok(authorizationRequest);
  assert.equal(authorizationRequest.headers.get("content-type"), "application/json");
  assert.deepEqual(await authorizationRequest.json(), { challenge: "challenge", nonce: "nonce" });
  assert.equal(token.value, "ghu_user");
});

void test("default browser fetch keeps its global receiver", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = function (this: unknown): Promise<Response> {
    assert.equal(this, globalThis);
    called = true;
    return Promise.resolve(Response.json({
      v: 1,
      site: "cpp-social",
      items: {},
    }));
  };
  try {
    const client = new FeedbackClient({
      apiOrigin: "https://feedback-api.cpp.social",
      site: "cpp-social",
    });
    await client.reactions(["example"]);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(called, true);
});

void test("votes are submitted through the service with the user token", async () => {
  let request: Request | undefined;
  const fetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    request = new Request(input, init);
    return Promise.resolve(Response.json({
      v: 1,
      up: 12,
      down: 3,
      viewer: "up",
    }));
  };
  const client = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social",
    site: "cpp-social",
    fetch,
  });
  const token = {
    value: "ghu_user",
    expiresAt: 2_000_000_000,
    creationGrant: "grant",
    viewerId: "U_one",
  };

  const result = await client.vote("feedback/example", "up", token);

  assert.ok(request);
  assert.equal(request.url, "https://feedback-api.cpp.social/v1/sites/cpp-social/votes");
  assert.equal(request.headers.get("authorization"), "Bearer ghu_user");
  assert.deepEqual(await request.json(), { key: "feedback/example", vote: "up" });
  assert.deepEqual(result, { up: 12, down: 3, viewer: "up" });
});

void test("last counter values are available before the network responds", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const response = {
    v: 1,
    site: "cpp-social",
    items: { article: { id: "D_article", up: 14, down: 2, age: 1, stale: false } },
  };
  const first = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social",
    site: "cpp-social",
    counterStorage: storage,
    fetch: (input) => Promise.resolve(Response.json(
      (input instanceof Request ? input.url : input.toString()).endsWith("/votes")
        ? { v: 1, up: 15, down: 2, viewer: "up" }
        : response,
    )),
  });
  await first.reactions(["article"]);
  await first.vote(
    "article",
    "up",
    { value: "ghu_user", expiresAt: 2_000_000_000, creationGrant: "grant" },
  );
  const reloaded = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social",
    site: "cpp-social",
    counterStorage: storage,
    fetch: () => Promise.reject(new Error("network should not be used")),
  });

  const cached = reloaded.cachedReactions(["article"]).get("article");

  assert.ok(cached);
  assert.equal(cached.id, "D_article");
  assert.equal(cached.up, 15);
  assert.equal(cached.down, 2);
  assert.equal(cached.stale, true);
  assert.equal(cached.viewer, "up");
  assert.equal(cached.viewerKnown, true);
});

void test("viewer reactions sync once per freshness window and survive reloads", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  let viewerRequests = 0;
  const fetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url.includes("/viewer-reactions")) {
      viewerRequests += 1;
      assert.equal(request.headers.get("authorization"), "Bearer ghu_user");
      return Promise.resolve(Response.json({
        v: 1,
        site: "cpp-social",
        items: { article: { vote: "both", starred: true } },
      }));
    }
    return Promise.resolve(Response.json({
      v: 1,
      site: "cpp-social",
      items: { article: { id: "D_article", up: 4, down: 2, age: 0, stale: false } },
    }));
  };
  const token = {
    value: "ghu_user",
    expiresAt: 2_000_000_000,
    creationGrant: "grant",
    viewerId: "U_one",
  };
  const first = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch, counterStorage: storage,
  });
  await first.reactions(["article"]);
  const synced = await first.syncViewerReactions(["article"], token);
  const reloaded = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch, counterStorage: storage,
  });
  const reused = await reloaded.syncViewerReactions(["article"], token);

  assert.equal(synced.get("article")?.viewer, "both");
  assert.equal(synced.get("article")?.starred, true);
  assert.equal(reused.get("article")?.viewer, "both");
  assert.equal(viewerRequests, 1);

  await reloaded.syncViewerReactions(["article"], { ...token, viewerId: "U_two" });
  assert.equal(viewerRequests, 2);
});

void test("stars are toggled through the service and cached", async () => {
  let request: Request | undefined;
  const values = new Map<string, string>();
  const client = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social",
    site: "cpp-social",
    fetch: (input, init) => {
      request = new Request(input, init);
      return Promise.resolve(Response.json({ v: 1, starred: true }));
    },
    counterStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
  });
  const token = { value: "ghu_user", expiresAt: 2_000_000_000, creationGrant: "grant" };

  const starred = await client.toggleStar("article", token);

  assert.equal(starred, true);
  assert.ok(request);
  assert.equal(request.url, "https://feedback-api.cpp.social/v1/sites/cpp-social/stars");
  assert.equal(request.headers.get("authorization"), "Bearer ghu_user");
  assert.deepEqual(await request.json(), { key: "article" });
  assert.equal(client.cachedReactions(["article"]).get("article")?.starred, true);
});
