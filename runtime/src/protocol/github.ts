import type { AccessToken } from "../api/client.js";
import addCommentMutation from "./queries/add_comment.graphql";
import upvoteMutation from "./queries/upvote.graphql";
import viewerUpvotesQuery from "./queries/viewer_upvotes.graphql";
import viewerSubjectsQuery from "./queries/viewer_subjects.graphql";
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

export interface ReactionResult {
  count: number;
  viewerHasReacted: boolean;
}

export interface PollVoteResult {
  count: number;
  viewerHasVoted: boolean;
}

export interface ViewerSubjectState {
  viewerHasUpvoted?: boolean;
  viewerHasVoted?: boolean;
  reactions: ReadonlySet<Reaction>;
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly graphql = false,
    readonly details: readonly string[] = [],
  ) {
    super(graphql
      ? `GitHub rejected the GraphQL operation${details.length ? `: ${details.join("; ")}` : ""}`
      : `GitHub request failed with status ${String(status)}`);
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
    const details = result.errors.slice(0, 5).map(graphqlErrorSummary);
    console.error("GitHub GraphQL operation failed", details);
    throw new GitHubRequestError(response.status, true, details);
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

export async function viewerSubjectStates(
  token: AccessToken,
  subjectIds: readonly string[],
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ViewerSubjectState>> {
  const result = new Map<string, ViewerSubjectState>();
  for (let start = 0; start < subjectIds.length; start += 100) {
    const ids = subjectIds.slice(start, start + 100);
    const body = await githubGraphql(fetch, token, viewerSubjectsQuery, { ids }, signal);
    const nodes = body.data?.nodes;
    if (!Array.isArray(nodes)) throw new TypeError("Invalid GitHub response");
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const value = node as Record<string, unknown>;
      if (typeof value.id !== "string") throw new TypeError("Invalid GitHub response");
      const reactions = new Set<Reaction>();
      if (Array.isArray(value.reactionGroups)) {
        for (const group of value.reactionGroups) {
          if (!group || typeof group !== "object") continue;
          const candidate = group as { content?: unknown; viewerHasReacted?: unknown };
          if (candidate.viewerHasReacted === true && isReaction(candidate.content)) {
            reactions.add(candidate.content);
          }
        }
      }
      result.set(value.id, {
        ...(typeof value.viewerHasUpvoted === "boolean"
          ? { viewerHasUpvoted: value.viewerHasUpvoted } : {}),
        ...(typeof value.viewerHasVoted === "boolean"
          ? { viewerHasVoted: value.viewerHasVoted } : {}),
        reactions,
      });
    }
  }
  return result;
}

function isReaction(value: unknown): value is Reaction {
  return ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"]
    .includes(value as Reaction);
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
): Promise<ReactionResult> {
  const operation = active ? "add" : "remove";
  const response = await githubGraphql(
    fetch, token, reactionMutation,
    { id: subjectId, content: reaction, remove: !active, add: active }, signal,
  );
  const mutation = response.data?.[operation];
  const subject = mutation && typeof mutation === "object"
    ? (mutation as { subject?: unknown }).subject : undefined;
  const groups = subject && typeof subject === "object"
    ? (subject as { reactionGroups?: unknown }).reactionGroups : undefined;
  if (!Array.isArray(groups)) throw new TypeError("Invalid GitHub response");
  const selected = groups.find((group) => group && typeof group === "object" &&
    (group as { content?: unknown }).content === reaction) as Record<string, unknown> | undefined;
  const count = selected && typeof selected.reactors === "object" && selected.reactors
    ? (selected.reactors as { totalCount?: unknown }).totalCount : undefined;
  if (!Number.isSafeInteger(count) || (count as number) < 0 ||
      typeof selected?.viewerHasReacted !== "boolean") {
    throw new TypeError("Invalid GitHub response");
  }
  return { count: count as number, viewerHasReacted: selected.viewerHasReacted };
}

function graphqlErrorSummary(value: unknown): string {
  if (!value || typeof value !== "object") return "Unknown GraphQL error";
  const error = value as { type?: unknown; message?: unknown; path?: unknown };
  const type = typeof error.type === "string" ? error.type : "GraphQL error";
  const message = typeof error.message === "string" ? error.message.slice(0, 300) : "";
  const path = Array.isArray(error.path)
    ? error.path.filter((item): item is string | number => typeof item === "string" || typeof item === "number").join(".")
    : "";
  return [type, path, message].filter(Boolean).join(" — ");
}

export async function setPollVote(
  token: AccessToken,
  optionId: string,
  active: boolean,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<PollVoteResult> {
  const operation = active ? "add" : "remove";
  const response = await githubGraphql(
    fetch, token, pollVoteMutation, { id: optionId, remove: !active, add: active }, signal,
  );
  const mutation = response.data?.[operation];
  const option = mutation && typeof mutation === "object"
    ? (mutation as { pollOption?: unknown }).pollOption : undefined;
  if (!option || typeof option !== "object") throw new TypeError("Invalid GitHub response");
  const value = option as { totalVoteCount?: unknown; viewerHasVoted?: unknown };
  if (!Number.isSafeInteger(value.totalVoteCount) || (value.totalVoteCount as number) < 0 ||
      typeof value.viewerHasVoted !== "boolean") {
    throw new TypeError("Invalid GitHub response");
  }
  return { count: value.totalVoteCount as number, viewerHasVoted: value.viewerHasVoted };
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
