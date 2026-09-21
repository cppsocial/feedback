import { FeedbackClient, FeedbackError } from "../api/client.js";
import type { ReactionState } from "../api/client.js";
import { trustedOrigin } from "../auth/origin.js";
import { Authentication } from "../auth/controller.js";
import { createAuthenticationStatus } from "../auth/status.js";

const parameters = new URLSearchParams(location.search);
const site = parameters.get("site") ?? "feedback-cpp-social";
const apiParameter = parameters.get("api");
const apiOrigin = apiParameter === null
  ? "https://feedback-api.cpp.social"
  : trustedOrigin(apiParameter, "example API origin");
const keys = [...new Set(
  (parameters.get("keys") ?? parameters.get("key") ?? "feedback/example,feedback/example-two")
    .split(",").map((value) => value.trim()).filter(Boolean),
)];
const githubMode = parameters.get("github") ?? "link";
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({ site, callbackOrigin: location.origin, service: client });
const status = required("status");
let replyTo: { key: string; id: string } | undefined;
required("api-origin").textContent = apiOrigin;
const authenticationStatus = createAuthenticationStatus({
  mount: required("authentication-status"),
  authentication,
  explanation: "Sign in is required to add comments or replies.",
  onError: (error) => { status.textContent = error instanceof Error ? error.message : "Authentication failed."; },
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
void render();

async function submitComment(): Promise<void> {
  const textarea = required("comment-body") as HTMLTextAreaElement;
  if (!textarea.value.trim()) return;
  try {
    let token = authentication.token();
    token ??= await authentication.authenticate();
    authenticationStatus.refresh();
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
    const states = await client.reactions(keys);
    const root = required("thread");
    root.replaceChildren();
    await Promise.all(keys.map(async (key) => {
      const article = document.createElement("article");
      article.className = "discussion";
      root.append(article);
      try {
        const payload = await client.discussionContent(key);
        renderDiscussion(article, key, payload.discussion, states.get(key));
      } catch (error) {
        appendText(article, "h2", key);
        appendText(article, "p", error instanceof FeedbackError ? error.code : "Unable to load thread.");
      }
    }));
    status.textContent = "Ready.";
  } catch (error) {
    status.textContent = error instanceof FeedbackError ? error.code : "Unable to load discussions.";
  }
}

function renderDiscussion(
  root: HTMLElement,
  key: string,
  content: Record<string, unknown>,
  state: ReactionState | undefined,
): void {
    appendText(root, "h2", string(content.title) || key);
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
      if (count > 0) appendText(reactions, "span", `${name}: ${String(count)}`, "tag");
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
    await client.toggleUpvote(key, token);
    authenticationStatus.refresh();
    status.textContent = `Updated ${key}.`;
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
    const summary = groups.map((group) => {
      const value = record(group);
      return value ? `${string(value.content)}: ${String(integer(record(value.users)?.totalCount))}` : "";
    }).filter(Boolean).join("  ");
    if (summary) appendText(article, "span", summary, "tag");
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

function appendText(parent: Element, tag: string, text: string, className?: string): void {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
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
