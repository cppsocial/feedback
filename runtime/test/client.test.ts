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
