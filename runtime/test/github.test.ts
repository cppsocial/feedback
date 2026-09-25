import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubRequestError,
  setPollVote,
  setReaction,
  viewerSubjectStates,
} from "../src/protocol/github.js";

const token = { value: "ghu_user", expiresAt: 2_000_000_000, creationGrant: "grant" };

void test("successful HTTP responses with GraphQL errors are rejected", async () => {
  const fetch = (): Promise<Response> => Promise.resolve(
    Response.json({ errors: [{ type: "FORBIDDEN", path: ["add"], message: "No access" }] }),
  );

  await assert.rejects(
    viewerSubjectStates(token, ["D_1"], fetch),
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

void test("viewer subject query does not request native upvote state", async () => {
  let query = "";
  const fetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") throw new TypeError("Expected JSON request body");
    query = (JSON.parse(init.body) as { query: string }).query;
    return Promise.resolve(Response.json({ data: { nodes: [] } }));
  };
  await viewerSubjectStates(token, ["D_1"], fetch);
  assert.doesNotMatch(query, /viewerHasUpvoted|upvoteCount/);
});

void test("poll mutations return the updated count and viewer selection", async () => {
  let request: { query: string; variables: Record<string, unknown> } | undefined;
  const fetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") throw new TypeError("Expected a string body");
    request = JSON.parse(init.body) as typeof request;
    return Promise.resolve(Response.json({ data: {
      addDiscussionPollVote: { pollOption: { poll: { options: { nodes: [
        { id: "DPO_1", totalVoteCount: 9, viewerHasVoted: true },
        { id: "DPO_2", totalVoteCount: 4, viewerHasVoted: false },
      ] } } } },
    } }));
  };

  const result = await setPollVote(token, "DPO_1", true, fetch);
  assert.deepEqual([...result.options], [
    ["DPO_1", { count: 9, viewerHasVoted: true }],
    ["DPO_2", { count: 4, viewerHasVoted: false }],
  ]);
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
      viewerHasVoted: id === "D_2",
      reactionGroups: [{ content: "HEART", viewerHasReacted: id === "D_1" }],
    })) } }));
  };

  const ids = Array.from({ length: 101 }, (_, index) => `D_${String(index + 1)}`);
  const states = await viewerSubjectStates(token, ids, fetch);

  assert.deepEqual(batches.map((batch) => (batch as unknown[]).length), [100, 1]);
  assert.equal(states.get("D_2")?.viewerHasVoted, true);
  assert.equal(states.get("D_1")?.reactions.has("HEART"), true);
});
