import { FeedbackClient, FeedbackError } from "../api/client.js";
import type { ReactionState } from "../api/client.js";
import { trustedOrigin } from "../auth/origin.js";
import { Authentication } from "../auth/controller.js";
import { createAuthenticationStatus } from "../auth/status.js";
import {
  setPollVote,
  setReaction,
  toggleUpvote as toggleSubjectUpvote,
  viewerSubjectStates,
} from "../protocol/github.js";
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
const showFirstPost = parameters.get("firstPost") !== "hidden";
const reactionTypes: readonly Reaction[] = [
  "THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES",
];
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({ site, callbackOrigin: location.origin, service: client });
const status = required("status");
let replyTo: { key: string; id: string } | undefined;
let cardViewerStates = new Map<string, ViewerSubjectState>();
const counterOverrides = new Map<string, {
  upvotes?: number;
  viewerHasUpvoted?: boolean;
  reactions: Map<Reaction, { count: number; selected: boolean }>;
}>();
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
  const submit = required("comment-submit") as HTMLButtonElement;
  if (!textarea.value.trim()) return;
  submit.disabled = true;
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
    status.textContent = "Comment posted. Refreshing the thread…";
    await render();
    status.textContent = "Comment posted.";
  } catch (error) {
    if (error instanceof FeedbackError && error.status === 401) authentication.clear();
    status.textContent = error instanceof Error ? error.message : "Unable to add comment.";
  } finally {
    submit.disabled = false;
  }
}

async function render(): Promise<void> {
  try {
    let states = await client.reactions(keys);
    const token = authentication.token();
    if (token !== null) {
      try {
        states = await client.syncViewerUpvotes(keys, token);
        const ids = [...states.values()].flatMap((state) => state.id ? [state.id] : []);
        cardViewerStates = new Map(await viewerSubjectStates(token, ids));
      } catch (error) {
        console.error("Unable to load GitHub viewer state", error);
      }
    } else {
      cardViewerStates.clear();
    }
    states = applyCounterOverrides(states);
    renderRankingCards(states);
    const existingKeys = keys.filter((key) => states.get(key)?.id);
    const root = required("thread");
    const rendered = document.createDocumentFragment();
    let contents = new Map<string, { discussion: Record<string, unknown> }>();
    let contentError: unknown;
    try {
      contents = new Map(await client.discussionContents(existingKeys));
      try {
        await addViewerState([...contents.values()].map((value) => value.discussion));
      } catch (error) {
        console.error("Unable to load GitHub comment viewer state", error);
      }
    } catch (error) {
      contentError = error;
    }
    for (const key of keys) {
      const article = document.createElement("article");
      article.className = "discussion";
      rendered.append(article);
      const state = states.get(key);
      if (!state?.id) {
        renderMissingDiscussion(article, key, state);
        continue;
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
    root.replaceChildren(rendered);
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
      `▲ ${String(state?.upvotes ?? 0)}`,
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
        `${reactionEmoji(name)} ${String(count)}`,
        () => react(key, name as Reaction, selected),
      );
      reaction.className = "reaction-control";
      reaction.title = reactionLabel(name);
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
    const result = await setReaction(token, state.id, reaction, !selected);
    const override = counterOverride(key);
    override.reactions.set(reaction, { count: result.count, selected: result.viewerHasReacted });
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
  if (showFirstPost) renderAuthor(root, content.author, content.createdAt);
  const category = record(content.category);
  if (category) appendText(root, "span", `Category: ${string(category.name)}`, "tag");
  renderLabels(root, content.labels);
  if (showFirstPost) renderMarkdown(root, string(content.bodyHTML), string(content.body));
  renderPoll(root, record(content.poll));
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  for (const name of reactionTypes) {
    reactions.append(subjectReactionButton(
      string(content.id), name, state?.reactions?.[name] ?? 0, viewerReacted(content, name),
    ));
  }
  root.append(reactions);
  const controls = document.createElement("div");
  controls.className = "controls";
  controls.append(subjectUpvoteButton(
    string(content.id), state?.upvotes ?? 0, state?.viewerHasUpvoted === true,
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
  const commentsContainer = record(content.comments);
  const comments = commentsContainer?.nodes;
  if (Array.isArray(comments)) {
    appendText(root, "h3", `${String(integer(commentsContainer?.totalCount))} comments`);
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
    const result = await client.toggleUpvote(key, token);
    const override = counterOverride(key);
    override.upvotes = result.count;
    override.viewerHasUpvoted = result.viewerHasUpvoted;
    authenticationStatus.refresh();
    status.textContent = `Updated ${key}.`;
    await render();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to upvote.";
  }
}

function counterOverride(key: string): {
  upvotes?: number;
  viewerHasUpvoted?: boolean;
  reactions: Map<Reaction, { count: number; selected: boolean }>;
} {
  const existing = counterOverrides.get(key);
  if (existing) return existing;
  const created = { reactions: new Map<Reaction, { count: number; selected: boolean }>() };
  counterOverrides.set(key, created);
  return created;
}

function applyCounterOverrides(
  source: ReadonlyMap<string, ReactionState>,
): ReadonlyMap<string, ReactionState> {
  const result = new Map(source);
  for (const [key, override] of counterOverrides) {
    const state = result.get(key);
    if (!state) continue;
    const reactions = { ...state.reactions };
    for (const [reaction, value] of override.reactions) reactions[reaction] = value.count;
    result.set(key, {
      ...state,
      ...(override.upvotes === undefined ? {} : { upvotes: override.upvotes }),
      ...(override.viewerHasUpvoted === undefined
        ? {} : { viewerHasUpvoted: override.viewerHasUpvoted, viewerKnown: true }),
      reactions,
    });
    if (state.id) {
      const viewer = cardViewerStates.get(state.id) ?? { reactions: new Set<Reaction>() };
      const selected = new Set(viewer.reactions);
      for (const [reaction, value] of override.reactions) {
        if (value.selected) selected.add(reaction);
        else selected.delete(reaction);
      }
      cardViewerStates.set(state.id, { ...viewer, reactions: selected });
    }
  }
  return result;
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
    let selected = value.viewerHasVoted === true;
    let count = integer(value.totalVoteCount);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "poll-option";
    const refresh = (): void => {
      button.textContent = `${string(value.option)}: ${String(count)} votes`;
      button.setAttribute("aria-pressed", String(selected));
    };
    button.addEventListener("click", () => {
      button.disabled = true;
      void authenticateAndRun(async (token) => {
        const result = await setPollVote(token, string(value.id), !selected);
        selected = result.viewerHasVoted;
        count = result.count;
        refresh();
      }).finally(() => { button.disabled = false; });
    });
    refresh();
    parent.append(button);
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
  renderAuthor(article, comment.author, comment.createdAt);
  if (comment.isMinimized === true) appendText(article, "p", "This comment was minimized.");
  else renderMarkdown(article, string(comment.bodyHTML), string(comment.body));
  if (comment.isAnswer === true) appendText(article, "span", "✓ Accepted answer", "tag accepted");
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
  const groupMap = new Map<Reaction, Record<string, unknown>>();
  if (Array.isArray(groups)) {
    for (const group of groups) {
      const value = record(group);
      if (value) groupMap.set(string(value.content) as Reaction, value);
    }
  }
  if (typeof comment.id === "string") {
    const controls = document.createElement("div");
    controls.className = "comment-controls";
    for (const reaction of reactionTypes) {
      const value = groupMap.get(reaction);
      controls.append(subjectReactionButton(
        comment.id,
        reaction,
        integer(record(value?.reactors)?.totalCount),
        value?.viewerHasReacted === true,
      ));
    }
    article.append(controls);
  }
  if (typeof comment.upvoteCount === "number") {
    article.append(subjectUpvoteButton(
      string(comment.id), comment.upvoteCount, comment.viewerHasUpvoted === true,
    ));
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

function subjectReactionButton(
  subjectId: string,
  reaction: Reaction,
  initialCount: number,
  initialSelected: boolean,
): HTMLButtonElement {
  let selected = initialSelected;
  let count = initialCount;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "reaction-control";
  const refresh = (): void => {
    button.textContent = `${reactionEmoji(reaction)} ${String(count)}`;
    button.title = reactionLabel(reaction);
    button.setAttribute("aria-pressed", String(selected));
  };
  button.addEventListener("click", () => {
    button.disabled = true;
    void authenticateAndRun(async (token) => {
      const result = await setReaction(token, subjectId, reaction, !selected);
      selected = result.viewerHasReacted;
      count = result.count;
      refresh();
    }).finally(() => { button.disabled = false; });
  });
  refresh();
  return button;
}

function subjectUpvoteButton(
  subjectId: string,
  initialCount: number,
  initialSelected: boolean,
): HTMLButtonElement {
  let selected = initialSelected;
  let count = initialCount;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "upvote-control";
  const refresh = (): void => {
    button.textContent = `▲ ${String(count)}`;
    button.title = selected ? "Remove upvote" : "Upvote";
    button.setAttribute("aria-pressed", String(selected));
  };
  button.addEventListener("click", () => {
    button.disabled = true;
    void authenticateAndRun(async (token) => {
      const result = await toggleSubjectUpvote(token, subjectId, selected);
      selected = result.viewerHasUpvoted;
      count = result.count;
      refresh();
    }).finally(() => { button.disabled = false; });
  });
  refresh();
  return button;
}

async function authenticateAndRun(
  action: (token: NonNullable<ReturnType<Authentication["token"]>>) => Promise<void>,
): Promise<void> {
  try {
    const token = authentication.token() ?? await authentication.authenticate();
    authenticationStatus.refresh();
    updateAuthenticationUi();
    await action(token);
    status.textContent = "Updated on GitHub.";
  } catch (error) {
    console.error("GitHub interaction failed", error);
    status.textContent = error instanceof Error ? error.message : "GitHub interaction failed.";
  }
}

function renderMissingDiscussion(
  root: HTMLElement,
  key: string,
  state: ReactionState | undefined,
): void {
  appendText(root, "h2", key);
  appendText(root, "p", "No GitHub discussion exists yet. Anonymous counters still resolve to zero.");
  appendText(root, "span", `▲ ${String(state?.upvotes ?? 0)}`, "tag");
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  for (const [name, count] of Object.entries(state?.reactions ?? {})) {
    const tag = appendText(reactions, "span", `${reactionEmoji(name)} ${String(count)}`, "tag");
    tag.title = reactionLabel(name);
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

function renderAuthor(parent: Element, authorValue: unknown, createdAt: unknown): void {
  const author = record(authorValue);
  if (!author) return;
  const header = document.createElement("header");
  header.className = "comment-author";
  const avatarUrl = string(author.avatarUrl);
  if (avatarUrl) {
    const avatar = document.createElement("img");
    avatar.src = avatarUrl;
    avatar.alt = "";
    avatar.width = 32;
    avatar.height = 32;
    avatar.loading = "lazy";
    header.append(avatar);
  }
  appendText(header, "strong", string(author.login) || "ghost");
  const timestamp = string(createdAt);
  if (timestamp) appendText(header, "time", new Date(timestamp).toLocaleString());
  parent.append(header);
}

function renderMarkdown(parent: Element, html: string, fallback: string): void {
  const body = document.createElement("div");
  body.className = "markdown-body";
  if (!html) {
    body.textContent = fallback;
    parent.append(body);
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeGithubHtml(template.content);
  body.append(template.content);
  parent.append(body);
}

function sanitizeGithubHtml(root: DocumentFragment): void {
  const allowed = new Set([
    "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "DETAILS", "DIV", "EM", "H1", "H2", "H3",
    "H4", "H5", "H6", "HR", "IMG", "KBD", "LI", "OL", "P", "PRE", "S", "SPAN",
    "STRONG", "SUMMARY", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
  ]);
  for (const element of [...root.querySelectorAll("*")]) {
    if (!allowed.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent));
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (!["alt", "class", "href", "src", "title"].includes(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      if (!safeUrl(element.href, true)) element.removeAttribute("href");
      element.rel = "noopener noreferrer";
      element.target = "_blank";
    }
    if (element instanceof HTMLImageElement) {
      if (!safeUrl(element.src, false)) element.remove();
      else element.loading = "lazy";
    }
  }
}

function safeUrl(value: string, allowFragment: boolean): boolean {
  if (allowFragment && value.startsWith("#")) return true;
  try {
    return new URL(value, location.href).protocol === "https:";
  } catch {
    return false;
  }
}

function reactionEmoji(reaction: string): string {
  return ({
    THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉",
    CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀",
  } as Record<string, string>)[reaction] ?? "•";
}

function reactionLabel(reaction: string): string {
  return ({
    THUMBS_UP: "+1", THUMBS_DOWN: "-1", LAUGH: "Laugh", HOORAY: "Hooray",
    CONFUSED: "Confused", HEART: "Heart", ROCKET: "Rocket", EYES: "Eyes",
  } as Record<string, string>)[reaction] ?? reaction;
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
