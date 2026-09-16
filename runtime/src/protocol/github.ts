import type { AccessToken } from "../api/client.js";
import viewerVoteQuery from "./queries/viewer_vote.graphql";
import voteMutation from "./queries/vote.graphql";

export type Vote = "up" | "down";
export type ViewerVote = Vote | "none";

export interface VoteResult {
  up: number;
  down: number;
  viewer: ViewerVote;
}

export class GitHubRequestError extends Error {
  constructor(readonly status: number) {
    super(`GitHub request failed with status ${String(status)}`);
  }
}

export async function viewerVote(
  token: AccessToken,
  discussionId: string,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<ViewerVote> {
  const body = await githubGraphql(fetch, token, viewerVoteQuery, { id: discussionId }, signal);
  const node = body.data?.node;
  if (!node || typeof node !== "object") throw new TypeError("Invalid GitHub response");
  const groups = (node as { reactionGroups?: unknown }).reactionGroups;
  if (!Array.isArray(groups)) throw new TypeError("Invalid GitHub response");
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const candidate = group as { content?: unknown; viewerHasReacted?: unknown };
    if (candidate.viewerHasReacted === true && candidate.content === "THUMBS_UP") return "up";
    if (candidate.viewerHasReacted === true && candidate.content === "THUMBS_DOWN") return "down";
  }
  return "none";
}

export async function vote(
  token: AccessToken,
  discussionId: string,
  current: ViewerVote,
  requested: Vote,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<VoteResult> {
  const operation = finalOperation(current, requested);
  const body = await githubGraphql(
    fetch,
    token,
    voteMutation,
    {
      id: discussionId,
      removeUp: current === "up",
      removeDown: current === "down",
      addUp: requested === "up" && current !== "up",
      addDown: requested === "down" && current !== "down",
    },
    signal,
  );
  return parseResult(body, operation);
}

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: unknown;
}

async function githubGraphql(
  fetch: typeof globalThis.fetch,
  token: AccessToken,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GraphQLResponse> {
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  };
  if (signal) init.signal = signal;
  const response = await fetch("https://api.github.com/graphql", init);
  if (!response.ok) throw new GitHubRequestError(response.status);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new TypeError("Invalid GitHub response");
  return body;
}

function finalOperation(current: ViewerVote, requested: Vote): string {
  if (current !== requested) return requested === "up" ? "addUp" : "addDown";
  return requested === "up" ? "removeUp" : "removeDown";
}

function parseResult(value: unknown, finalOperation: string): VoteResult {
  if (!value || typeof value !== "object") throw new TypeError("Invalid GitHub response");
  const data = (value as { data?: unknown; errors?: unknown }).data;
  const errors = (value as { errors?: unknown }).errors;
  if (errors || !data || typeof data !== "object") throw new TypeError("Invalid GitHub response");
  const result = (data as Record<string, unknown>)[finalOperation];
  if (!result || typeof result !== "object") throw new TypeError("Invalid GitHub response");
  const subject = (result as { subject?: unknown }).subject;
  if (!subject || typeof subject !== "object") throw new TypeError("Invalid GitHub response");
  const groups = (subject as { reactionGroups?: unknown }).reactionGroups;
  if (!Array.isArray(groups)) throw new TypeError("Invalid GitHub response");
  let up = 0;
  let down = 0;
  let viewer: ViewerVote = "none";
  for (const group of groups) {
    if (!group || typeof group !== "object") throw new TypeError("Invalid GitHub response");
    const candidate = group as {
      content?: unknown;
      users?: { totalCount?: unknown };
      viewerHasReacted?: unknown;
    };
    const count = candidate.users?.totalCount;
    if (!Number.isSafeInteger(count)) throw new TypeError("Invalid GitHub response");
    if (candidate.content === "THUMBS_UP") {
      up = count as number;
      if (candidate.viewerHasReacted === true) viewer = "up";
    } else if (candidate.content === "THUMBS_DOWN") {
      down = count as number;
      if (candidate.viewerHasReacted === true) viewer = "down";
    }
  }
  return { up, down, viewer };
}
