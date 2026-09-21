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
export { createAuthenticationStatus } from "./auth/status.js";
export type { AuthenticationStatusController, AuthenticationStatusOptions } from "./auth/status.js";
export { PendingVoteStore } from "./auth/pending-vote.js";
export type { PendingVote } from "./auth/pending-vote.js";
export { lookupTerm, resourceFromDocument, validateResourceId } from "./feedback/resources.js";
export type { DocumentResourceOptions, Mapping, Resource } from "./feedback/resources.js";
export { createUpvoteControls } from "./feedback/upvotes.js";
export type { UpvoteControls, UpvoteControlsOptions, UpvoteItem } from "./feedback/upvotes.js";
export type { KeyValueStorage } from "./storage.js";
export {
  addComment,
  deleteComment,
  GitHubRequestError,
  setAnswer,
  setPollVote,
  setReaction,
  toggleUpvote,
  updateComment,
  viewerUpvotes,
} from "./protocol/github.js";
export type { Reaction, UpvoteResult } from "./protocol/github.js";
