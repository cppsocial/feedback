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
      items: { a: {
        id: null, number: null, upvotes: 0,
      } },
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

void test("native upvotes go directly to GitHub while counters come from the service", async () => {
  const githubRequests: Request[] = [];
  const fetch = (): Promise<Response> => {
    return Promise.resolve(Response.json({
      v: 1,
      site: "cpp-social",
      items: { "feedback/example": {
        id: "D_example", number: 7, upvotes: 11,
      } },
    }));
  };
  const githubFetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    githubRequests.push(request);
    return Promise.resolve(Response.json({ data: githubRequests.length === 2
      ? { add: { subject: { upvoteCount: 12, viewerHasUpvoted: true } } }
      : { nodes: [{ id: "D_example", viewerHasUpvoted: false }] } }));
  };
  const client = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social",
    site: "cpp-social",
    fetch,
    githubFetch,
  });
  const token = {
    value: "ghu_user",
    expiresAt: 2_000_000_000,
    creationGrant: "grant",
    viewerId: "U_one",
  };

  const result = await client.toggleUpvote("feedback/example", token);

  assert.equal(githubRequests.length, 2);
  const firstRequest = githubRequests[0];
  assert.ok(firstRequest);
  assert.equal(firstRequest.url, "https://api.github.com/graphql");
  assert.equal(firstRequest.headers.get("authorization"), "Bearer ghu_user");
  assert.deepEqual(result, { count: 12, viewerHasUpvoted: true });
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
    items: { article: {
      id: "D_article", number: 8, upvotes: 14,
    } },
  };
  let voteGitHubCalls = 0;
  const first = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social",
    site: "cpp-social",
    counterStorage: storage,
    fetch: () => Promise.resolve(Response.json(
      response,
    )),
    githubFetch: () => {
      voteGitHubCalls += 1;
      return Promise.resolve(Response.json({ data: voteGitHubCalls === 1
        ? { nodes: [{ id: "D_article", viewerHasUpvoted: false }] }
        : { add: { subject: { upvoteCount: 15, viewerHasUpvoted: true } } } }));
    },
  });
  await first.reactions(["article"]);
  await first.toggleUpvote(
    "article",
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
  assert.equal(cached.upvotes, 15);
  assert.equal(cached.viewerHasUpvoted, true);
  assert.equal(cached.viewerKnown, true);
});

void test("viewer upvotes sync once per freshness window and survive reloads", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  let viewerRequests = 0;
  const fetch = (): Promise<Response> => {
    return Promise.resolve(Response.json({
      v: 1,
      site: "cpp-social",
      items: { article: {
        id: "D_article", number: 9, upvotes: 4,
      } },
    }));
  };
  const githubFetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    viewerRequests += 1;
    const request = new Request(input, init);
    assert.equal(request.headers.get("authorization"), "Bearer ghu_user");
    return Promise.resolve(Response.json({ data: { nodes: [{
      id: "D_article",
      viewerHasUpvoted: true,
    }] } }));
  };
  const token = {
    value: "ghu_user",
    expiresAt: 2_000_000_000,
    creationGrant: "grant",
    viewerId: "U_one",
  };
  const first = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch, githubFetch, counterStorage: storage,
  });
  await first.reactions(["article"]);
  const synced = await first.syncViewerUpvotes(["article"], token);
  const reloaded = new FeedbackClient({
    apiOrigin: "https://feedback-api.cpp.social", site: "cpp-social", fetch, githubFetch, counterStorage: storage,
  });
  const reused = await reloaded.syncViewerUpvotes(["article"], token);

  assert.equal(synced.get("article")?.viewerHasUpvoted, true);
  assert.equal(reused.get("article")?.viewerHasUpvoted, true);
  assert.equal(viewerRequests, 1);

  await reloaded.syncViewerUpvotes(["article"], { ...token, viewerId: "U_two" });
  assert.equal(viewerRequests, 2);
});
