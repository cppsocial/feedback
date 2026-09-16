import assert from "node:assert/strict";
import test from "node:test";

import { viewerVote, vote } from "../src/protocol/github.js";

const token = { value: "ghu_user", expiresAt: 2_000_000_000, creationGrant: "grant" };

void test("switching votes removes the old reaction before adding the new one", async () => {
  let query = "";
  const fetch = (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    if (typeof body !== "string") throw new TypeError("Expected a string body");
    const request = JSON.parse(body) as { query: string };
    query = request.query;
    return Promise.resolve(Response.json({
      data: {
        addDown: {
          subject: {
            reactionGroups: [
              { content: "THUMBS_UP", users: { totalCount: 3 }, viewerHasReacted: false },
              { content: "THUMBS_DOWN", users: { totalCount: 2 }, viewerHasReacted: true },
            ],
          },
        },
      },
    }));
  };

  const result = await vote(token, "D_1", "up", "down", fetch);

  assert.ok(query.indexOf("removeUp") < query.indexOf("addDown"));
  assert.deepEqual(result, { up: 3, down: 2, viewer: "down" });
});

void test("viewer state is queried before deciding a mutation", async () => {
  const fetch = (): Promise<Response> => Promise.resolve(Response.json({
    data: {
      node: {
        reactionGroups: [
          { content: "THUMBS_UP", viewerHasReacted: true },
          { content: "THUMBS_DOWN", viewerHasReacted: false },
        ],
      },
    },
  }));

  assert.equal(await viewerVote(token, "D_1", fetch), "up");
});
