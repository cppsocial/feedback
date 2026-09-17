export { FeedbackClient, FeedbackError } from "./api/client.js";
export type {
  AccessToken,
  Authorization,
  ClientOptions,
  CounterStorage,
  EnsuredDiscussion,
  ReactionState,
} from "./api/client.js";
export { Authentication, AuthenticationError } from "./auth/controller.js";
export type { AuthenticationOptions } from "./auth/controller.js";
export { PendingVoteStore } from "./auth/pending-vote.js";
export type { PendingVote } from "./auth/pending-vote.js";
export { lookupTerm, resourceFromDocument, validateResourceId } from "./feedback/resources.js";
export type { DocumentResourceOptions, Mapping, Resource } from "./feedback/resources.js";
export type { KeyValueStorage } from "./feedback/stars.js";
export { GitHubRequestError, viewerVote, vote } from "./protocol/github.js";
export type { Vote, ViewerVote, VoteResult } from "./protocol/github.js";
