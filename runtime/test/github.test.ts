import assert from "node:assert/strict";
import test from "node:test";

import { toggleUpvote, viewerUpvotes } from "../src/protocol/github.js";

const token = { value: "ghu_user", expiresAt: 2_000_000_000, creationGrant: "grant" };

void test("native discussion upvotes use addUpvote and return authoritative state", async () => {
  let variables: Record<string, unknown> = {};
  let query = "";
  const fetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") throw new TypeError("Expected a string body");
    const request = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    query = request.query;
    variables = request.variables;
    return Promise.resolve(Response.json({ data: {
      add: { subject: { upvoteCount: 12, viewerHasUpvoted: true } },
    } }));
  };

  const result = await toggleUpvote(token, "D_1", false, fetch);

  assert.match(query, /addUpvote/);
  assert.deepEqual(variables, { id: "D_1", remove: false, add: true });
  assert.deepEqual(result, { count: 12, viewerHasUpvoted: true });
});

void test("viewer upvotes are queried in one nodes batch", async () => {
  const fetch = (): Promise<Response> => Promise.resolve(Response.json({ data: { nodes: [
    { id: "D_1", viewerHasUpvoted: true },
    { id: "D_2", viewerHasUpvoted: false },
  ] } }));

  const result = await viewerUpvotes(token, ["D_1", "D_2"], fetch);

  assert.equal(result.get("D_1"), true);
  assert.equal(result.get("D_2"), false);
});

void test("successful HTTP responses with GraphQL errors are rejected", async () => {
  const fetch = (): Promise<Response> => Promise.resolve(
    Response.json({ errors: [{ type: "FORBIDDEN" }] }),
  );

  await assert.rejects(
    viewerUpvotes(token, ["D_1"], fetch),
    /rejected the GraphQL operation/,
  );
});
