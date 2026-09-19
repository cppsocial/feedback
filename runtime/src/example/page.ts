import { FeedbackClient, FeedbackError } from "../api/client.js";
import { trustedOrigin } from "../auth/origin.js";
import { Authentication } from "../auth/controller.js";
import { createAuthenticationStatus } from "../auth/status.js";

const parameters = new URLSearchParams(location.search);
const site = parameters.get("site") ?? "feedback-cpp-social";
const apiOrigin = parameters.get("api") === null
  ? "https://feedback-api.cpp.social"
  : trustedOrigin(parameters.get("api") as string, "example API origin");
const key = parameters.get("key") ?? "feedback/example";
const githubMode = parameters.get("github") ?? "link";
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({ site, callbackOrigin: location.origin, service: client });
const status = required("status");
let replyTo: string | undefined;
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
void render();

async function submitComment(): Promise<void> {
  const textarea = required("comment-body") as HTMLTextAreaElement;
  if (!textarea.value.trim()) return;
  try {
    let token = authentication.token();
    if (token === null) token = await authentication.authenticate();
    authenticationStatus.refresh();
    await client.addComment(key, textarea.value, token, replyTo);
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
    const state = (await client.reactions([key])).get(key);
    const payload = await client.discussionContent(key);
    const content = payload.discussion;
    const root = required("thread");
    root.replaceChildren();
    appendText(root, "h2", string(content.title) || key);
    appendText(root, "p", string(content.body));
    renderPoll(root, record(content.poll));
    const reactions = document.createElement("div");
    reactions.className = "reactions";
    for (const [name, count] of Object.entries(state?.reactions ?? {})) {
      if (count > 0) appendText(reactions, "span", `${name}: ${String(count)}`, "tag");
    }
    root.append(reactions);
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
      for (const comment of comments) if (record(comment)) root.append(renderComment(comment, 0));
    }
    status.textContent = "Ready.";
  } catch (error) {
    status.textContent = error instanceof FeedbackError ? error.code : "Unable to load discussion.";
  }
}

function renderPoll(parent: HTMLElement, poll: Record<string, unknown> | null): void {
  if (!poll) return;
  appendText(parent, "h3", string(poll.question));
  const options = poll.options;
  if (!Array.isArray(options)) return;
  for (const option of options) {
    const value = record(option);
    if (!value) continue;
    const label = document.createElement("div");
    label.className = "poll-option";
    label.textContent = `${string(value.option)}: ${String(value.totalVotes ?? 0)} votes`;
    if (value.viewerHasVoted === true) label.classList.add("selected");
    parent.append(label);
  }
}

function renderComment(comment: Record<string, unknown>, depth: number): HTMLElement {
  const article = document.createElement("article");
  article.className = depth === 0 ? "comment" : "comment reply";
  if (comment.isAnswer === true) article.classList.add("answer");
  if (comment.isAnswerByOrganizationOwner === true) article.classList.add("verified-answer");
  appendText(article, "p", comment.isMinimized === true ? "This comment was minimized." : string(comment.body));
  if (comment.isAnswer === true) appendText(article, "span", comment.isAnswerByOrganizationOwner === true ? "Verified answer" : "Answer", "tag");
  if (depth === 0 && typeof comment.id === "string") {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.textContent = "Reply";
    reply.addEventListener("click", () => {
      replyTo = comment.id as string;
      required("clear-reply").hidden = false;
      required("comment-body").focus();
    });
    article.append(reply);
  }
  const groups = comment.reactionGroups;
  if (Array.isArray(groups)) {
    const summary = groups.map((group) => {
      const value = record(group);
      return value ? `${string(value.content)}: ${String(record(value.users)?.totalCount ?? 0)}` : "";
    }).filter(Boolean).join("  ");
    if (summary) appendText(article, "span", summary, "tag");
  }
  const replies = record(comment.replies)?.nodes;
  if (Array.isArray(replies)) for (const reply of replies) if (record(reply)) article.append(renderComment(reply, depth + 1));
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

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}
