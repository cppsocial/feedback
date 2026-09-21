import { FeedbackClient, FeedbackError } from "../api/client.js";
import type { ReactionState } from "../api/client.js";
import { trustedOrigin } from "../auth/origin.js";
import { Authentication } from "../auth/controller.js";
import { createAuthenticationStatus } from "../auth/status.js";
import { setReaction, viewerSubjectStates } from "../protocol/github.js";
import type { Reaction, ViewerSubjectState } from "../protocol/github.js";

const parameters = new URLSearchParams(location.search);
const site = parameters.get("site") ?? "feedback-cpp-social";
const apiParameter = parameters.get("api");
const apiOrigin = apiParameter === null
  ? "https://feedback-api.cpp.social"
  : trustedOrigin(apiParameter, "example API origin");
const keys = [...new Set(
  (parameters.get("keys") ?? parameters.get("key") ?? "feedback/example,feedback/documentation,poll/test,q-and-a/foo,q-and-a/test,feedback/not-created")
    .split(",").map((value) => value.trim()).filter(Boolean),
)];
const githubMode = parameters.get("github") ?? "link";
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({ site, callbackOrigin: location.origin, service: client });
const status = required("status");
let replyTo: { key: string; id: string } | undefined;
let cardViewerStates = new Map<string, ViewerSubjectState>();
required("api-origin").textContent = apiOrigin;
const authenticationStatus = createAuthenticationStatus({
  mount: required("authentication-status"),
  authentication,
  explanation: "Sign in is required to add comments or replies.",
  onError: (error) => { status.textContent = error instanceof Error ? error.message : "Authentication failed."; },
  onChange: () => { updateAuthenticationUi(); void render(); },
});
required("comment-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitComment();
});
required("clear-reply").addEventListener("click", () => {
  replyTo = undefined;
  required("clear-reply").hidden = true;
});
const commentKey = required("comment-key") as HTMLSelectElement;
for (const key of keys) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = key;
  commentKey.append(option);
}
updateAuthenticationUi();
void render();

async function submitComment(): Promise<void> {
  const textarea = required("comment-body") as HTMLTextAreaElement;
  if (!textarea.value.trim()) return;
  try {
    let token = authentication.token();
    token ??= await authentication.authenticate();
    authenticationStatus.refresh();
    updateAuthenticationUi();
    const key = replyTo?.key ?? commentKey.value;
    await client.addComment(key, textarea.value, token, replyTo?.id);
    textarea.value = "";
    replyTo = undefined;
    required("clear-reply").hidden = true;
    status.textContent = "Comment added. Refreshing…";
    await render();
  } catch (error) {
    if (error instanceof FeedbackError && error.status === 401) authentication.clear();
    status.textContent = error instanceof Error ? error.message : "Unable to add comment.";
  }
}

async function render(): Promise<void> {
  try {
    let states = await client.reactions(keys);
    const token = authentication.token();
    if (token !== null) {
      states = await client.syncViewerUpvotes(keys, token);
      const ids = [...states.values()].flatMap((state) => state.id ? [state.id] : []);
      cardViewerStates = new Map(await viewerSubjectStates(token, ids));
    } else {
      cardViewerStates.clear();
    }
    renderRankingCards(states);
    const existingKeys = keys.filter((key) => states.get(key)?.id);
    const root = required("thread");
    root.replaceChildren();
    let contents = new Map<string, { discussion: Record<string, unknown> }>();
    let contentError: unknown;
    try {
      contents = new Map(await client.discussionContents(existingKeys));
      await addViewerState([...contents.values()].map((value) => value.discussion));
    } catch (error) {
      contentError = error;
    }
    for (const key of keys) {
      const article = document.createElement("article");
      article.className = "discussion";
      root.append(article);
      const state = states.get(key);
      if (!state?.id) {
        renderMissingDiscussion(article, key, state);
        return;
      }
      try {
        const payload = contents.get(key);
        if (!payload) {
          throw contentError instanceof Error
            ? contentError
            : new Error("Missing discussion content");
        }
        renderDiscussion(article, key, payload.discussion, state);
      } catch (error) {
        appendText(article, "h2", key);
        appendText(article, "p", error instanceof FeedbackError ? error.code : "Unable to load thread.");
      }
    }
    status.textContent = contentError === undefined ? "Ready." : "Counters loaded; discussions unavailable.";
  } catch (error) {
    status.textContent = error instanceof FeedbackError ? error.code : "Unable to load discussions.";
  }
}

function renderRankingCards(states: ReadonlyMap<string, ReactionState>): void {
  const root = required("cards");
  root.replaceChildren();
  for (const key of keys) {
    const state = states.get(key);
    const card = document.createElement("article");
    card.className = "ranking-card";
    appendText(card, "h3", key);
    const button = actionButton(
      `${state?.viewerHasUpvoted === true ? "Remove upvote" : "Upvote"} · ${String(state?.upvotes ?? 0)}`,
      () => upvote(key),
    );
    button.setAttribute("aria-pressed", String(state?.viewerHasUpvoted === true));
    card.append(button);
    const reactions = document.createElement("div");
    reactions.className = "reactions";
    for (const [name, count] of Object.entries(state?.reactions ?? {})) {
      const selected = state?.id
        ? cardViewerStates.get(state.id)?.reactions.has(name as Reaction) === true
        : false;
      const reaction = actionButton(
        `${name}: ${String(count)}`,
        () => react(key, name as Reaction, selected),
      );
      reaction.className = "reaction-control";
      reaction.setAttribute("aria-pressed", String(selected));
      reactions.append(reaction);
    }
    card.append(reactions);
    if (!state?.id) appendText(card, "small", "No discussion yet; all counters are zero.");
    root.append(card);
  }
}

async function react(key: string, reaction: Reaction, selected: boolean): Promise<void> {
  try {
    const token = authentication.token() ?? await authentication.authenticate();
    authenticationStatus.refresh();
    updateAuthenticationUi();
    const state = (await client.reactions([key])).get(key);
    if (!state?.id) throw new Error("Create the discussion with an upvote before reacting.");
    await setReaction(token, state.id, reaction, !selected);
    status.textContent = `Updated ${reaction} on ${key}.`;
    await render();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to react.";
  }
}

function updateAuthenticationUi(): void {
  const authenticated = authentication.token() !== null;
  required("comment-submit").textContent = authenticated ? "Comment" : "Sign in and comment";
}

function renderDiscussion(
  root: HTMLElement,
  key: string,
  content: Record<string, unknown>,
  state: ReactionState | undefined,
): void {
  appendText(root, "h2", string(content.title) || key);
  if (isViewer(content.author)) root.classList.add("own-post");
    const category = record(content.category);
    if (category) appendText(root, "span", `Category: ${string(category.name)}`, "tag");
    renderLabels(root, content.labels);
    appendText(root, "p", string(content.body));
    if (state) {
      appendText(
        root,
        "span",
        `Upvotes: ${String(state.upvotes)}`,
        "tag",
      );
    }
    renderPoll(root, record(content.poll));
    const reactions = document.createElement("div");
    reactions.className = "reactions";
    for (const [name, count] of Object.entries(state?.reactions ?? {})) {
      const tag = appendText(reactions, "span", `${name}: ${String(count)}`, "tag");
      if (viewerReacted(content, name)) tag.classList.add("selected");
    }
    root.append(reactions);
    const controls = document.createElement("div");
    controls.className = "controls";
    controls.append(actionButton(
      state?.viewerHasUpvoted === true ? "Remove upvote" : "Upvote",
      () => upvote(key),
    ));
    root.append(controls);
    const url = string(content.url);
    if (url && githubMode !== "hidden") {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "View discussion on GitHub";
      root.append(link);
    }
    const comments = record(content.comments)?.nodes;
    if (Array.isArray(comments)) {
      appendText(root, "h3", `${String(comments.length)} comments`);
      for (const comment of comments) {
        const value = record(comment);
        if (value) root.append(renderComment(key, value, 0));
      }
    }
}

async function upvote(key: string): Promise<void> {
  try {
    const token = authentication.token() ?? await authentication.authenticate();
    const state = (await client.reactions([key])).get(key);
    if (!state?.id) {
      const resourceUrl = new URL(location.href);
      resourceUrl.search = "";
      resourceUrl.hash = "";
      await client.ensure({ key, title: key, url: resourceUrl.href }, token.creationGrant);
    }
    await client.toggleUpvote(key, token);
    authenticationStatus.refresh();
    status.textContent = `Updated ${key}.`;
    await render();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to upvote.";
  }
}

function actionButton(label: string, action: () => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => { void action(); });
  return button;
}

function renderLabels(parent: HTMLElement, value: unknown): void {
  const nodes = record(value)?.nodes;
  if (!Array.isArray(nodes)) return;
  for (const label of nodes) {
    const item = record(label);
    if (item) appendText(parent, "span", `Label: ${string(item.name)}`, "tag");
  }
}

function renderPoll(parent: HTMLElement, poll: Record<string, unknown> | null): void {
  if (!poll) return;
  appendText(parent, "h3", string(poll.question));
  const options = record(poll.options)?.nodes;
  if (!Array.isArray(options)) return;
  for (const option of options) {
    const value = record(option);
    if (!value) continue;
    const label = document.createElement("div");
    label.className = "poll-option";
    label.textContent = `${string(value.option)}: ${String(integer(value.totalVoteCount))} votes`;
    if (value.viewerHasVoted === true) label.classList.add("selected");
    parent.append(label);
  }
}

function renderComment(key: string, comment: Record<string, unknown>, depth: number): HTMLElement {
  const article = document.createElement("article");
  article.className = depth === 0 ? "comment" : "comment reply";
  if (typeof comment.deletedAt === "string") {
    appendText(article, "p", "This comment was deleted.");
    return article;
  }
  if (comment.isAnswer === true) article.classList.add("answer");
  if (isViewer(comment.author)) article.classList.add("own-post");
  appendText(article, "p", comment.isMinimized === true ? "This comment was minimized." : string(comment.body));
  if (comment.isAnswer === true) appendText(article, "span", "Accepted answer", "tag");
  const association = string(comment.authorAssociation);
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(association)) {
    appendText(article, "span", association.toLowerCase(), "tag");
  }
  if (depth === 0 && typeof comment.id === "string") {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.textContent = "Reply";
    reply.addEventListener("click", () => {
      replyTo = { key, id: comment.id as string };
      commentKey.value = key;
      required("clear-reply").hidden = false;
      required("comment-body").focus();
    });
    article.append(reply);
  }
  const groups = comment.reactionGroups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      const value = record(group);
      if (!value) continue;
      const tag = appendText(
        article,
        "span",
        `${string(value.content)}: ${String(integer(record(value.reactors)?.totalCount))}`,
        "tag",
      );
      if (value.viewerHasReacted === true) tag.classList.add("selected");
    }
  }
  if (typeof comment.upvoteCount === "number") {
    const upvotes = appendText(article, "span", `Upvotes: ${String(comment.upvoteCount)}`, "tag");
    if (comment.viewerHasUpvoted === true) upvotes.classList.add("selected");
  }
  const replies = record(comment.replies)?.nodes;
  if (Array.isArray(replies)) {
    for (const reply of replies) {
      const value = record(reply);
      if (value) article.append(renderComment(key, value, depth + 1));
    }
  }
  return article;
}

function renderMissingDiscussion(
  root: HTMLElement,
  key: string,
  state: ReactionState | undefined,
): void {
  appendText(root, "h2", key);
  appendText(root, "p", "No GitHub discussion exists yet. Anonymous counters still resolve to zero.");
  appendText(root, "span", `Upvotes: ${String(state?.upvotes ?? 0)}`, "tag");
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  for (const [name, count] of Object.entries(state?.reactions ?? {})) {
    appendText(reactions, "span", `${name}: ${String(count)}`, "tag");
  }
  root.append(reactions);
  const button = actionButton("Sign in and create with first upvote", () => upvote(key));
  button.setAttribute("aria-pressed", "false");
  root.append(button);
}

function isViewer(author: unknown): boolean {
  const viewerId = authentication.token()?.viewerId;
  return viewerId !== undefined && string(record(author)?.id) === viewerId;
}

async function addViewerState(contents: readonly Record<string, unknown>[]): Promise<void> {
  const token = authentication.token();
  if (token === null) return;
  const subjects = new Map<string, Record<string, unknown>>();
  for (const content of contents) collectSubjects(content, subjects);
  const states = await viewerSubjectStates(token, [...subjects.keys()]);
  for (const [id, state] of states) overlayViewerState(subjects.get(id), state);
}

function collectSubjects(value: unknown, result: Map<string, Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectSubjects(child, result);
    return;
  }
  const object = record(value);
  if (!object) return;
  if (typeof object.id === "string") result.set(object.id, object);
  for (const child of Object.values(object)) collectSubjects(child, result);
}

function overlayViewerState(
  subject: Record<string, unknown> | undefined,
  state: ViewerSubjectState,
): void {
  if (!subject) return;
  if (state.viewerHasUpvoted !== undefined) subject.viewerHasUpvoted = state.viewerHasUpvoted;
  if (state.viewerHasVoted !== undefined) subject.viewerHasVoted = state.viewerHasVoted;
  const groups = subject.reactionGroups;
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    const value = record(group);
    if (value) value.viewerHasReacted = state.reactions.has(string(value.content) as never);
  }
}

function viewerReacted(subject: Record<string, unknown>, reaction: string): boolean {
  const groups = subject.reactionGroups;
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => {
    const value = record(group);
    return string(value?.content) === reaction && value?.viewerHasReacted === true;
  });
}

function appendText(parent: Element, tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) ? value as number : 0;
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}
