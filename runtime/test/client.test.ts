import assert from "node:assert/strict";
import test from "node:test";

import { FeedbackClient } from "../src/api/client.js";

const token = { value: "ghu_user", expiresAt: 2_000_000_000, creationGrant: "grant" };

void test("reaction counters are requested in a sorted batch", async () => {
  let requested = "";
  const fetch = (input: URL | RequestInfo): Promise<Response> => {
    requested = input instanceof Request ? input.url : input.toString();
    return Promise.resolve(Response.json({ v: 1, site: "cpp-social", items: {
      a: { id: null, up: 0, down: 0 },
      b: { id: "D_b", up: 3, down: 1 },
    } }));
  };
  const client = new FeedbackClient({ apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch });

  const states = await client.reactions(["b", "a", "b"]);

  assert.equal(requested, "https://feedback-api.cpp.social/v1/sites/cpp-social/reactions?keys=a%2Cb");
  assert.equal(states.get("b")?.up, 3);
  assert.equal(states.get("a")?.down, 0);
});

void test("OAuth transport sends JSON only to the configured site", async () => {
  const requests: Request[] = [];
  const fetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json(request.url.endsWith("oauth/authorize")
      ? { v: 1, authorization_url: "https://github.com/login/oauth/authorize?client_id=x", state: "signed-state" }
      : { v: 1, access_token: "ghu_user", expires_at: 1234, creation_grant: "grant" }));
  };
  const client = new FeedbackClient({ apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch });

  const authorization = await client.authorize("challenge", "nonce");
  const result = await client.exchange("code", authorization.state, "verifier");

  assert.equal(requests.length, 2);
  assert.deepEqual(await requests[0]?.json(), { challenge: "challenge", nonce: "nonce" });
  assert.equal(result.value, "ghu_user");
});

void test("votes use reactions directly, removing the opposite before adding the new direction", async () => {
  const mutations: string[] = [];
  const fetch = (): Promise<Response> => Promise.resolve(Response.json({ v: 1, site: "cpp-social", items: {
    card: { id: "D_card", up: 5, down: 2 },
  } }));
  const githubFetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") throw new TypeError("Expected JSON request body");
    const body = JSON.parse(init.body) as { variables: { content?: string } };
    if (!body.variables.content) return Promise.resolve(Response.json({ data: { nodes: [{
      id: "D_card", reactionGroups: [
        { content: "THUMBS_UP", viewerHasReacted: false },
        { content: "THUMBS_DOWN", viewerHasReacted: true },
      ],
    }] } }));
    mutations.push(body.variables.content);
    return Promise.resolve(Response.json({ data: mutations.length === 1
      ? { remove: { subject: { reactionGroups: [
        { content: "THUMBS_DOWN", reactors: { totalCount: 1 }, viewerHasReacted: false },
      ] } } }
      : { add: { subject: { reactionGroups: [
        { content: "THUMBS_UP", reactors: { totalCount: 6 }, viewerHasReacted: true },
      ] } } } }));
  };
  const client = new FeedbackClient({ apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch, githubFetch });
  await client.reactions(["card"]);

  const result = await client.vote("card", token, "up");

  assert.deepEqual(mutations, ["THUMBS_DOWN", "THUMBS_UP"]);
  assert.deepEqual(result, { up: 6, down: 1, selected: "up" });
});

void test("cached counters render before a network request", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
    removeItem: (key: string): void => { values.delete(key); },
  };
  const first = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", counterStorage: storage,
    fetch: () => Promise.resolve(Response.json({ v: 1, site: "cpp-social", items: {
      card: { id: "D_card", up: 7, down: 2 },
    } })),
  });
  await first.reactions(["card"]);
  const reloaded = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", counterStorage: storage,
    fetch: () => Promise.reject(new Error("network should not be used")),
  });

  assert.equal(reloaded.cachedReactions(["card"]).get("card")?.up, 7);
});
