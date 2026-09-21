import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubRequestError,
  setPollVote,
  setReaction,
  toggleUpvote,
  viewerSubjectStates,
  viewerUpvotes,
} from "../src/protocol/github.js";

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
    Response.json({ errors: [{ type: "FORBIDDEN", path: ["add"], message: "No access" }] }),
  );

  await assert.rejects(
    viewerUpvotes(token, ["D_1"], fetch),
    (error: unknown) => error instanceof GitHubRequestError &&
      error.details[0] === "FORBIDDEN — add — No access",
  );
});

void test("reaction mutations return the updated count and viewer selection", async () => {
  const fetch = (): Promise<Response> => Promise.resolve(Response.json({ data: {
    add: { subject: { reactionGroups: [
      { content: "HEART", reactors: { totalCount: 4 }, viewerHasReacted: true },
    ] } },
  } }));

  assert.deepEqual(await setReaction(token, "DC_1", "HEART", true, fetch), {
    count: 4,
    viewerHasReacted: true,
  });
});

void test("poll mutations return the updated count and viewer selection", async () => {
  let request: { query: string; variables: Record<string, unknown> } | undefined;
  const fetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") throw new TypeError("Expected a string body");
    request = JSON.parse(init.body) as typeof request;
    return Promise.resolve(Response.json({ data: {
      addDiscussionPollVote: { pollOption: { totalVoteCount: 9, viewerHasVoted: true } },
    } }));
  };

  assert.deepEqual(await setPollVote(token, "DPO_1", true, fetch), {
    count: 9,
    viewerHasVoted: true,
  });
  assert.match(request?.query ?? "", /addDiscussionPollVote/);
  assert.doesNotMatch(request?.query ?? "", /removeDiscussionPollVote/);
  assert.deepEqual(request?.variables, { id: "DPO_1" });
});

void test("viewer subject state batches reactions, votes, and chunks at 100 IDs", async () => {
  const batches: unknown[] = [];
  const fetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") throw new TypeError("Expected a string body");
    const request = JSON.parse(init.body) as { variables: { ids: string[] } };
    batches.push(request.variables.ids);
    return Promise.resolve(Response.json({ data: { nodes: request.variables.ids.map((id) => ({
      id,
      viewerHasUpvoted: id === "D_1",
      viewerHasVoted: id === "D_2",
      reactionGroups: [{ content: "HEART", viewerHasReacted: id === "D_1" }],
    })) } }));
  };

  const ids = Array.from({ length: 101 }, (_, index) => `D_${String(index + 1)}`);
  const states = await viewerSubjectStates(token, ids, fetch);

  assert.deepEqual(batches.map((batch) => (batch as unknown[]).length), [100, 1]);
  assert.equal(states.get("D_1")?.viewerHasUpvoted, true);
  assert.equal(states.get("D_2")?.viewerHasVoted, true);
  assert.equal(states.get("D_1")?.reactions.has("HEART"), true);
});
