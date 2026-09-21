import type { AccessToken } from "../api/client.js";
import addCommentMutation from "./queries/add_comment.graphql";
import upvoteMutation from "./queries/upvote.graphql";
import viewerUpvotesQuery from "./queries/viewer_upvotes.graphql";
import reactionMutation from "./queries/reaction.graphql";
import pollVoteMutation from "./queries/poll_vote.graphql";
import answerMutation from "./queries/answer.graphql";
import updateCommentMutation from "./queries/update_comment.graphql";
import deleteCommentMutation from "./queries/delete_comment.graphql";

export type Reaction = "THUMBS_UP" | "THUMBS_DOWN" | "LAUGH" | "HOORAY" | "CONFUSED" | "HEART" | "ROCKET" | "EYES";

export interface UpvoteResult {
  count: number;
  viewerHasUpvoted: boolean;
}

export class GitHubRequestError extends Error {
  constructor(readonly status: number, readonly graphql = false) {
    super(graphql ? "GitHub rejected the GraphQL operation" : `GitHub request failed with status ${String(status)}`);
  }
}

export async function toggleUpvote(
  token: AccessToken,
  discussionId: string,
  current: boolean,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<UpvoteResult> {
  const operation = current ? "remove" : "add";
  const body = await githubGraphql(
    fetch, token, upvoteMutation, { id: discussionId, remove: current, add: !current }, signal,
  );
  const mutation = body.data?.[operation];
  const subject = mutation && typeof mutation === "object"
    ? (mutation as { subject?: unknown }).subject
    : undefined;
  if (!subject || typeof subject !== "object") throw new TypeError("Invalid GitHub response");
  const value = subject as { upvoteCount?: unknown; viewerHasUpvoted?: unknown };
  if (!Number.isSafeInteger(value.upvoteCount) || (value.upvoteCount as number) < 0 ||
      typeof value.viewerHasUpvoted !== "boolean") {
    throw new TypeError("Invalid GitHub response");
  }
  return { count: value.upvoteCount as number, viewerHasUpvoted: value.viewerHasUpvoted };
}

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: unknown;
}

export async function githubGraphql(
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
  const result = body as GraphQLResponse;
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new GitHubRequestError(response.status, true);
  }
  return result;
}

export async function viewerUpvotes(
  token: AccessToken,
  discussionIds: readonly string[],
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, boolean>> {
  const body = await githubGraphql(fetch, token, viewerUpvotesQuery, { ids: discussionIds }, signal);
  const nodes = body.data?.nodes;
  if (!Array.isArray(nodes)) throw new TypeError("Invalid GitHub response");
  const result = new Map<string, boolean>();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const candidate = node as { id?: unknown; viewerHasUpvoted?: unknown };
    if (typeof candidate.id !== "string" || typeof candidate.viewerHasUpvoted !== "boolean") {
      throw new TypeError("Invalid GitHub response");
    }
    result.set(candidate.id, candidate.viewerHasUpvoted);
  }
  return result;
}

export async function addComment(
  token: AccessToken,
  discussionId: string,
  text: string,
  replyTo: string | undefined,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<{ id: string; body?: string; url?: string }> {
  const response = await githubGraphql(
    fetch, token, addCommentMutation,
    { discussionId, body: text, replyToId: replyTo ?? null }, signal,
  );
  const mutation = response.data?.addDiscussionComment;
  const comment = mutation && typeof mutation === "object"
    ? (mutation as { comment?: unknown }).comment
    : undefined;
  if (!comment || typeof comment !== "object" || typeof (comment as { id?: unknown }).id !== "string") {
    throw new TypeError("Invalid GitHub response");
  }
  return comment as { id: string; body?: string; url?: string };
}

export async function setReaction(
  token: AccessToken,
  subjectId: string,
  reaction: Reaction,
  active: boolean,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<void> {
  await githubGraphql(
    fetch, token, reactionMutation,
    { id: subjectId, content: reaction, remove: !active, add: active }, signal,
  );
}

export async function setPollVote(
  token: AccessToken,
  optionId: string,
  active: boolean,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<void> {
  await githubGraphql(
    fetch, token, pollVoteMutation, { id: optionId, remove: !active, add: active }, signal,
  );
}

export async function setAnswer(
  token: AccessToken,
  commentId: string,
  active: boolean,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<void> {
  await githubGraphql(
    fetch, token, answerMutation, { id: commentId, unmark: !active, mark: active }, signal,
  );
}

export async function updateComment(
  token: AccessToken,
  commentId: string,
  text: string,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<void> {
  await githubGraphql(fetch, token, updateCommentMutation, { id: commentId, body: text }, signal);
}

export async function deleteComment(
  token: AccessToken,
  commentId: string,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<void> {
  await githubGraphql(fetch, token, deleteCommentMutation, { id: commentId }, signal);
}
