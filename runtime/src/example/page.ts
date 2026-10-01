import { FeedbackClient, FeedbackError } from "../api/client.js";
import type { ReactionState } from "../api/client.js";
import { trustedOrigin } from "../auth/origin.js";
import { Authentication } from "../auth/controller.js";
import { createAuthenticationStatus } from "../auth/status.js";
import {
  setPollVote,
  setReaction,
  viewerSubjectStates,
} from "../protocol/github.js";
import type { Reaction, ViewerSubjectState } from "../protocol/github.js";
import { marked } from "marked";

const parameters = new URLSearchParams(location.search);
if (parameters.get("embed") === "1") document.body.classList.add("embedded");
const site = parameters.get("site") ?? "feedback-cpp-social";
const apiParameter = parameters.get("api");
const apiOrigin = apiParameter === null
  ? "https://feedback-api.cpp.social"
  : trustedOrigin(apiParameter, "example API origin");
let keys = parseKeys(parameters.get("cards") ?? parameters.get("keys") ?? "feedback/example,feedback/documentation,feedback/navigation,feedback/design");
let selectedKey = parameters.get("discussion") ?? parameters.get("key") ?? keys[0] ?? "feedback/example";
let githubMode = parameters.get("github") ?? "link";
let showCardReactions = parameters.get("cardReactions") !== "hidden";
const visibility = {
  title: parameters.get("title") !== "hidden",
  root: parameters.get("firstPost") !== "hidden",
  metadata: parameters.get("metadata") !== "hidden",
  poll: parameters.get("poll") !== "hidden",
  discussionActions: parameters.get("actions") !== "hidden",
};
const reactionTypes: readonly Reaction[] = [
  "THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES",
];
let separateVotes = parameters.get("votes") !== "reactions";
const otherReactions = reactionTypes.filter((reaction) =>
  reaction !== "THUMBS_UP" && reaction !== "THUMBS_DOWN");
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({ site, callbackOrigin: location.origin, service: client });
const status = required("status");
let replyTo: { key: string; id: string } | undefined;
let replyOrder: "oldest" | "newest" = parameters.get("replyOrder") === "newest" ? "newest" : "oldest";
let authDialogEnabled = parameters.get("authDialog") !== "off";
let cardViewerStates = new Map<string, ViewerSubjectState>();
let counterSnapshot: ReadonlyMap<string, ReactionState> | undefined;
let counterSnapshotAt = 0;
const threadSnapshots = new Map<string, { at: number; discussion: Record<string, unknown> }>();
let renderSequence = 0;
const pendingVotes = new Set<string>();
const pendingReactions = new Set<string>();
const counterOverrides = new Map<string, {
  up?: number;
  down?: number;
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
const commentForm = required("comment-form") as HTMLFormElement;
const commentHome = commentForm.parentElement;
if (!commentHome) throw new Error("Comment form has no parent");
const statusAnchor = required("status");
const returnEditor = (): void => {
  replyTo = undefined;
  required("clear-reply").hidden = true;
  commentHome.insertBefore(commentForm, statusAnchor);
};
const orderControl = required("reply-order") as HTMLSelectElement;
orderControl.value = replyOrder;
orderControl.addEventListener("change", () => {
  replyOrder = orderControl.value === "newest" ? "newest" : "oldest";
  updateConfigOutput();
  void render();
});
const composeOnTop = required("compose-on-top") as HTMLInputElement;
composeOnTop.checked = parameters.get("composer") === "top";
composeOnTop.addEventListener("change", () => {
  returnEditor();
  updateConfigOutput();
  void render();
});
required("comment-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitComment();
});
const editorTools = required("editor-tools");
const editorBody = required("comment-body") as HTMLTextAreaElement;
const editorPreview = required("comment-preview");
const showPreview = (preview: boolean): void => {
  editorBody.hidden = preview;
  editorTools.hidden = preview;
  editorPreview.hidden = !preview;
  required("editor-write").setAttribute("aria-pressed", String(!preview));
  required("editor-preview").setAttribute("aria-pressed", String(preview));
  if (preview) {
    const template = document.createElement("template");
    template.innerHTML = marked.parse(editorBody.value, { async: false });
    sanitizeGithubHtml(template.content);
    editorPreview.replaceChildren(template.content);
    if (!editorBody.value.trim()) editorPreview.textContent = "Nothing to preview yet.";
  }
};
required("editor-write").addEventListener("click", () => { showPreview(false); });
required("editor-preview").addEventListener("click", () => { showPreview(true); });
editorTools.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-markdown]");
  if (!button) return;
  const textarea = required("comment-body") as HTMLTextAreaElement;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  const action = button.dataset.markdown;
  const replacement = action === "bold" ? `**${selected || "bold text"}**`
    : action === "italic" ? `*${selected || "italic text"}*`
    : action === "code" ? `\`${selected || "code"}\``
    : action === "link" ? `[${selected || "link text"}](https://)`
    : action === "quote" ? `> ${selected || "quoted text"}`
    : `- ${selected || "list item"}`;
  textarea.setRangeText(replacement, start, end, "select");
  textarea.focus();
});
required("clear-reply").addEventListener("click", () => {
  returnEditor();
});
const cardKeysInput = required("config-card-keys") as HTMLTextAreaElement;
cardKeysInput.value = keys.join(", ");
cardKeysInput.addEventListener("change", () => {
  keys = parseKeys(cardKeysInput.value);
  cardKeysInput.value = keys.join(", ");
  counterSnapshot = undefined;
  updateConfigOutput();
  void render();
});
const discussionKeyInput = required("config-discussion-key") as HTMLInputElement;
discussionKeyInput.value = selectedKey;
discussionKeyInput.addEventListener("change", () => {
  selectedKey = discussionKeyInput.value.trim();
  discussionKeyInput.value = selectedKey;
  returnEditor();
  updateConfigOutput();
  void render();
});
const accessInput = required("config-discussion-access") as HTMLSelectElement;
accessInput.value = ["link", "dialog", "hidden"].includes(githubMode) ? githubMode : "link";
accessInput.addEventListener("change", () => { githubMode = accessInput.value; updateConfigOutput(); void render(); });
const votesInput = required("config-votes") as HTMLSelectElement;
votesInput.value = separateVotes ? "separate" : "reactions";
votesInput.addEventListener("change", () => { separateVotes = votesInput.value === "separate"; updateConfigOutput(); void render(); });
const bindSwitch = (id: string, value: boolean, change: (checked: boolean) => void): void => {
  const input = required(id) as HTMLInputElement;
  input.checked = value;
  input.addEventListener("change", () => { change(input.checked); updateConfigOutput(); void render(); });
};
bindSwitch("config-card-reactions", showCardReactions, (value) => { showCardReactions = value; });
bindSwitch("config-title", visibility.title, (value) => { visibility.title = value; });
bindSwitch("config-root", visibility.root, (value) => { visibility.root = value; });
bindSwitch("config-metadata", visibility.metadata, (value) => { visibility.metadata = value; });
bindSwitch("config-poll", visibility.poll, (value) => { visibility.poll = value; });
bindSwitch("config-actions", visibility.discussionActions, (value) => { visibility.discussionActions = value; });
bindSwitch("config-auth-dialog", authDialogEnabled, (value) => { authDialogEnabled = value; });
required("copy-config").addEventListener("click", () => {
  void navigator.clipboard.writeText(required("config-output").textContent)
    .then(() => { required("copy-config").textContent = "Copied"; })
    .catch(() => { required("copy-config").textContent = "Select code to copy"; });
});
updateConfigOutput();
updateAuthenticationUi();
renderRankingCards(client.cachedReactions(keys));
void render();

async function submitComment(): Promise<void> {
  const textarea = required("comment-body") as HTMLTextAreaElement;
  const submit = required("comment-submit") as HTMLButtonElement;
  if (!textarea.value.trim()) return;
  submit.disabled = true;
  try {
    const token = await requireAuthentication("Sign in to post your comment or reply.");
    const key = replyTo?.key ?? selectedKey;
    await client.addComment(key, textarea.value, token, replyTo?.id);
    textarea.value = "";
    returnEditor();
    showPreview(false);
    status.textContent = "Comment posted. Refreshing the thread…";
    threadSnapshots.delete(key);
    await render(true);
    status.textContent = "Comment posted.";
  } catch (error) {
    if (error instanceof FeedbackError && error.status === 401) authentication.clear();
    status.textContent = error instanceof Error ? error.message : "Unable to add comment.";
  } finally {
    submit.disabled = false;
  }
}

async function render(force = false): Promise<void> {
  const sequence = ++renderSequence;
  const key = selectedKey;
  try {
    if (force || counterSnapshot === undefined || Date.now() - counterSnapshotAt >= 30_000) {
      counterSnapshot = await client.reactions(keys);
      counterSnapshotAt = Date.now();
    }
    let states = counterSnapshot;
    const token = authentication.token();
    if (token !== null) {
      try {
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
    const discussionState = (await client.reactions([key])).get(key);
    const hasDiscussion = Boolean(discussionState?.id);
    const root = required("thread");
    const rendered = document.createDocumentFragment();
    const contents = new Map<string, { discussion: Record<string, unknown> }>();
    let contentError: unknown;
    try {
      if (hasDiscussion) {
        const snapshot = threadSnapshots.get(key);
        if (!force && snapshot && Date.now() - snapshot.at < 10_000) {
          contents.set(key, { discussion: structuredClone(snapshot.discussion) });
        } else {
          contents.set(key, await client.discussionContent(key));
          const discussion = contents.get(key)?.discussion;
          if (discussion) threadSnapshots.set(key, { at: Date.now(), discussion: structuredClone(discussion) });
        }
      }
      try {
        await addViewerState([...contents.values()].map((value) => value.discussion));
      } catch (error) {
        console.error("Unable to load GitHub comment viewer state", error);
      }
    } catch (error) {
      contentError = error;
    }
    if (sequence !== renderSequence) return;
    for (const key of [selectedKey]) {
      const article = document.createElement("article");
      article.className = "discussion";
      rendered.append(article);
      const state = discussionState;
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
    if (commentForm.parentElement !== commentHome) returnEditor();
    root.replaceChildren(rendered);
    if (composeOnTop.checked) {
      const heading = root.querySelector(".comments-heading");
      if (heading) heading.after(commentForm);
    }
    status.textContent = contentError === undefined ? "Ready." : "Counters loaded; discussions unavailable.";
  } catch (error) {
    status.textContent = error instanceof FeedbackError ? error.code : "Unable to load discussions.";
  }
}

function renderRankingCards(states: ReadonlyMap<string, ReactionState>): void {
  const root = required("cards");
  root.replaceChildren();
  for (const key of [...keys].sort((a, b) =>
    Number(states.get(b)?.pinnedToCategory === true) - Number(states.get(a)?.pinnedToCategory === true))) {
    const state = states.get(key);
    const card = document.createElement("article");
    card.className = "ranking-card";
    appendText(card, "h3", key);
    if (state?.pinnedToCategory) appendText(card, "small", "Pinned to category");
    const votes = document.createElement("div");
    votes.className = "card-votes";
    for (const direction of ["up", "down"] as const) {
      const reaction = direction === "up" ? "THUMBS_UP" : "THUMBS_DOWN";
      const button = actionButton(
        `${reactionEmoji(reaction)} ${String(direction === "up" ? state?.up ?? 0 : state?.down ?? 0)}`,
        () => vote(key, direction),
      );
      button.className = "vote-control";
      button.dataset.voteKey = key;
      button.disabled = pendingVotes.has(key);
      button.setAttribute("aria-pressed", String(state?.id
        ? cardViewerStates.get(state.id)?.reactions.has(reaction) === true : false));
      votes.append(button);
    }
    card.append(votes);
    const reactions = document.createElement("div");
    reactions.className = "reactions";
    for (const [name, count] of Object.entries(showCardReactions ? state?.reactions ?? {} : {})) {
      if (name === "THUMBS_UP" || name === "THUMBS_DOWN") continue;
      if (count === 0) continue;
      const selected = state?.id
        ? cardViewerStates.get(state.id)?.reactions.has(name as Reaction) === true
        : false;
      const reaction = actionButton(
        `${reactionEmoji(name)} ${String(count)}`,
        () => react(key, name as Reaction, selected),
      );
      reaction.className = "reaction-control";
      reaction.disabled = pendingReactions.has(key);
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
  if (pendingReactions.has(key)) return;
  pendingReactions.add(key);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".ranking-card .reaction-control")) {
    button.disabled = true;
  }
  try {
    const token = await requireAuthentication("Sign in to react to this discussion.");
    authenticationStatus.refresh();
    updateAuthenticationUi();
    const state = (await client.reactions([key])).get(key);
    if (!state?.id) throw new Error("Create the discussion with a vote before reacting.");
    const currentSelected = cardViewerStates.get(state.id)?.reactions.has(reaction) ?? selected;
    const result = await setReaction(token, state.id, reaction, !currentSelected);
    const override = counterOverride(key);
    override.reactions.set(reaction, { count: result.count, selected: result.viewerHasReacted });
    if (counterSnapshot) renderRankingCards(applyCounterOverrides(counterSnapshot));
    status.textContent = `Updated ${reaction} on ${key}.`;
    await render();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to react.";
  } finally {
    pendingReactions.delete(key);
    if (counterSnapshot) renderRankingCards(applyCounterOverrides(counterSnapshot));
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
  const header = document.createElement("header");
  header.className = "discussion-header";
  if (visibility.title) appendText(header, "h2", string(content.title) || key);
  if (isViewer(content.author)) root.classList.add("own-post");
  if (visibility.metadata) {
    const metadata = document.createElement("div");
    metadata.className = "discussion-metadata";
    const category = record(content.category);
    if (category) appendText(metadata, "span", string(category.name), "tag category-tag");
    renderLabels(metadata, content.labels);
    header.append(metadata);
  }
  if (header.childElementCount > 0) root.append(header);
  if (visibility.root) {
    renderAuthor(root, content.author, content.createdAt, isAdmin(content));
    renderMarkdown(root, string(content.bodyHTML), string(content.body));
  }
  if (visibility.poll) renderPoll(root, record(content.poll));
  if (visibility.discussionActions) {
    const controls = document.createElement("div");
    controls.className = "post-actions";
    controls.append(subjectReactionControls(string(content.id), (separateVotes ? otherReactions : reactionTypes).map((name) => ({
      reaction: name,
      count: name === "THUMBS_UP" ? state?.up ?? 0
        : name === "THUMBS_DOWN" ? state?.down ?? 0 : state?.reactions?.[name] ?? 0,
      selected: viewerReacted(content, name),
    }))));
    if (separateVotes) controls.append(subjectVoteControls(
      string(content.id), state?.up ?? 0, state?.down ?? 0,
      viewerReacted(content, "THUMBS_UP"), viewerReacted(content, "THUMBS_DOWN"),
    ));
    root.append(controls);
  }
  const url = string(content.url);
  if (url && safeUrl(url, false) && githubMode !== "hidden") {
    const access = document.createElement(githubMode === "dialog" ? "button" : "a");
    access.className = "discussion-access";
    const icon = discussionIcon(githubMode === "dialog" ? "preview" : "external");
    access.append(icon, document.createTextNode(githubMode === "dialog" ? "Quick view" : "Open on GitHub"));
    if (access instanceof HTMLAnchorElement) {
      access.href = url;
      access.target = "_blank";
      access.rel = "noopener noreferrer";
    } else {
      access.type = "button";
      access.addEventListener("click", () => { showDiscussionDialog(content, url); });
    }
    root.append(access);
  }
  const commentsContainer = record(content.comments);
  const comments = commentsContainer?.nodes;
  if (Array.isArray(comments)) {
    appendText(root, "h3", `${String(integer(commentsContainer?.totalCount))} comments`, "comments-heading");
    for (const comment of sortedComments(comments)) {
      const value = record(comment);
      if (value) root.append(renderComment(key, value, 0));
    }
  }
}

async function vote(key: string, direction: "up" | "down"): Promise<void> {
  if (pendingVotes.has(key)) return;
  pendingVotes.add(key);
  setCardPending(key, true);
  try {
    const token = await requireAuthentication("Sign in to vote on this discussion.");
    const state = (await client.reactions([key])).get(key);
    if (!state?.id) {
      const resourceUrl = new URL(location.href);
      resourceUrl.search = "";
      resourceUrl.hash = "";
      await client.ensure({ key, title: key, url: resourceUrl.href }, token.creationGrant);
      counterSnapshotAt = 0;
    }
    const viewer = state?.id ? cardViewerStates.get(state.id) : undefined;
    const current = viewer === undefined ? undefined
      : viewer.reactions.has("THUMBS_UP") ? "up"
      : viewer.reactions.has("THUMBS_DOWN") ? "down" : null;
    const result = await client.vote(key, token, direction, current);
    const override = counterOverride(key);
    override.up = result.up;
    override.down = result.down;
    override.reactions.set("THUMBS_UP", { count: result.up, selected: result.selected === "up" });
    override.reactions.set("THUMBS_DOWN", { count: result.down, selected: result.selected === "down" });
    if (counterSnapshot) renderRankingCards(applyCounterOverrides(counterSnapshot));
    authenticationStatus.refresh();
    status.textContent = `Updated ${key}.`;
    await render();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to vote.";
  } finally {
    pendingVotes.delete(key);
    setCardPending(key, false);
  }
}

function setCardPending(key: string, pending: boolean): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".card-votes button")) {
    if (button.dataset.voteKey === key) button.disabled = pending;
  }
}

function counterOverride(key: string): {
  up?: number;
  down?: number;
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
      ...(override.up === undefined ? {} : { up: override.up }),
      ...(override.down === undefined ? {} : { down: override.down }),
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
    if (item) appendText(parent, "span", string(item.name), "tag label-tag");
  }
}

function renderPoll(parent: HTMLElement, poll: Record<string, unknown> | null): void {
  if (!poll) return;
  appendText(parent, "h3", string(poll.question));
  const options = record(poll.options)?.nodes;
  if (!Array.isArray(options)) return;
  const buttons = new Map<string, HTMLButtonElement>();
  let pending = false;
  const refresh = (): void => {
    for (const option of options) {
      const value = record(option);
      if (!value) continue;
      const button = buttons.get(string(value.id));
      if (!button) continue;
      const selected = value.viewerHasVoted === true;
      button.textContent = `${string(value.option)}: ${String(integer(value.totalVoteCount))} votes`;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = pending || selected;
    }
  };
  for (const option of options) {
    const value = record(option);
    if (!value) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "poll-option";
    buttons.set(string(value.id), button);
    button.addEventListener("click", () => {
      if (pending || value.viewerHasVoted === true) return;
      pending = true;
      refresh();
      void authenticateAndRun(async (token) => {
        const result = await setPollVote(token, string(value.id), true);
        for (const entry of options) {
          const current = record(entry);
          if (!current) continue;
          const state = result.options.get(string(current.id));
          if (!state) continue;
          current.totalVoteCount = state.count;
          current.viewerHasVoted = state.viewerHasVoted;
        }
        refresh();
      }).finally(() => {
        pending = false;
        refresh();
      });
    });
    parent.append(button);
  }
  refresh();
}

function renderComment(key: string, comment: Record<string, unknown>, depth: number): HTMLElement {
  const article = document.createElement("article");
  article.className = depth === 0 ? "comment" : "comment reply";
  if (typeof comment.id === "string") article.dataset.commentId = comment.id;
  if (typeof comment.deletedAt === "string") {
    appendText(article, "p", "This comment was deleted.");
    return article;
  }
  if (comment.isAnswer === true) {
    article.classList.add("answer");
    appendText(article, "div", "✓ Selected answer", "answer-banner");
  }
  if (isViewer(comment.author)) article.classList.add("own-post");
  const admin = isAdmin(comment);
  if (admin) article.classList.add("admin-post");
  renderAuthor(article, comment.author, comment.createdAt, admin);
  if (comment.isMinimized === true) appendText(article, "p", "This comment was minimized.");
  else renderMarkdown(article, string(comment.bodyHTML), string(comment.body));
  const footer = document.createElement("footer");
  footer.className = "comment-footer";
  const footerActions = document.createElement("div");
  footerActions.className = "comment-footer-actions";
  if (typeof comment.id === "string") {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.textContent = "Reply";
    reply.addEventListener("click", () => {
      replyTo = { key, id: comment.id as string };
      required("clear-reply").hidden = false;
      footer.after(commentForm);
      showPreview(false);
      required("comment-body").focus();
    });
    footerActions.append(reply);
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
    footerActions.prepend(subjectReactionControls(comment.id, (separateVotes ? otherReactions : reactionTypes).map((reaction) => {
      const value = groupMap.get(reaction);
      return {
        reaction,
        count: integer(record(value?.reactors)?.totalCount),
        selected: value?.viewerHasReacted === true,
      };
    })));
    if (separateVotes) footer.append(subjectVoteControls(
      comment.id,
      integer(record(groupMap.get("THUMBS_UP")?.reactors)?.totalCount),
      integer(record(groupMap.get("THUMBS_DOWN")?.reactors)?.totalCount),
      groupMap.get("THUMBS_UP")?.viewerHasReacted === true,
      groupMap.get("THUMBS_DOWN")?.viewerHasReacted === true,
    ));
  }
  footer.append(footerActions);
  article.append(footer);
  const replies = record(comment.replies)?.nodes;
  if (Array.isArray(replies)) {
    for (const reply of sortedComments(replies)) {
      const value = record(reply);
      if (value) article.append(renderComment(key, value, depth + 1));
    }
  }
  return article;
}

function subjectReactionControls(
  subjectId: string,
  initial: readonly { reaction: Reaction; count: number; selected: boolean }[],
): HTMLElement {
  const states = new Map(initial.map((value) => [value.reaction, { ...value }]));
  const available = initial.map((value) => value.reaction);
  const root = document.createElement("div");
  root.className = "reaction-controls";
  let pending = false;
  const renderControls = (): void => {
    root.replaceChildren();
    for (const reaction of available) {
      const state = states.get(reaction) ?? { reaction, count: 0, selected: false };
      if (state.count > 0) root.append(reactionButton(state, false));
    }
    const picker = document.createElement("details");
    picker.className = "reaction-picker";
    const summary = document.createElement("summary");
    summary.textContent = "😀 +";
    summary.title = "Add reaction";
    picker.append(summary);
    const choices = document.createElement("div");
    choices.className = "reaction-picker-menu";
    for (const reaction of available) {
      const state = states.get(reaction) ?? { reaction, count: 0, selected: false };
      choices.append(reactionButton(state, true));
    }
    picker.append(choices);
    root.append(picker);
  };
  const reactionButton = (
    state: { reaction: Reaction; count: number; selected: boolean },
    picker: boolean,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = picker ? "reaction-choice" : "reaction-control";
    button.textContent = picker
      ? reactionEmoji(state.reaction)
      : `${reactionEmoji(state.reaction)} ${String(state.count)}`;
    button.title = reactionLabel(state.reaction);
    button.setAttribute("aria-pressed", String(state.selected));
    button.disabled = pending;
    button.addEventListener("click", () => {
      if (pending) return;
      pending = true;
      renderControls();
      void authenticateAndRun(async (token) => {
        const current = (await viewerSubjectStates(token, [subjectId])).get(subjectId);
        const selected = current?.reactions.has(state.reaction) ?? state.selected;
        const result = await setReaction(token, subjectId, state.reaction, !selected);
        states.set(state.reaction, {
          reaction: state.reaction,
          count: result.count,
          selected: result.viewerHasReacted,
        });
        renderControls();
      }).finally(() => {
        pending = false;
        renderControls();
      });
    });
    return button;
  };
  renderControls();
  return root;
}

function subjectVoteControls(
  subjectId: string,
  up: number,
  down: number,
  upSelected: boolean,
  downSelected: boolean,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "vote-controls";
  const buttons = new Map<"up" | "down", HTMLButtonElement>();
  let pending = false;
  const refresh = (): void => {
    for (const direction of ["up", "down"] as const) {
      const button = buttons.get(direction);
      if (!button) continue;
      button.textContent = `${direction === "up" ? "👍" : "👎"} ${String(direction === "up" ? up : down)}`;
      button.setAttribute("aria-pressed", String(direction === "up" ? upSelected : downSelected));
      button.disabled = pending;
    }
  };
  for (const direction of ["up", "down"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vote-control";
    buttons.set(direction, button);
    button.addEventListener("click", () => {
      if (pending) return;
      pending = true;
      refresh();
      void authenticateAndRun(async (token) => {
        const current = (await viewerSubjectStates(token, [subjectId])).get(subjectId);
        upSelected = current?.reactions.has("THUMBS_UP") ?? upSelected;
        downSelected = current?.reactions.has("THUMBS_DOWN") ?? downSelected;
        const reaction = direction === "up" ? "THUMBS_UP" : "THUMBS_DOWN";
        const other = direction === "up" ? "THUMBS_DOWN" : "THUMBS_UP";
        const otherSelected = direction === "up" ? downSelected : upSelected;
        if (otherSelected) {
          const removed = await setReaction(token, subjectId, other, false);
          if (direction === "up") { down = removed.count; downSelected = false; }
          else { up = removed.count; upSelected = false; }
        }
        const selected = direction === "up" ? upSelected : downSelected;
        const result = await setReaction(token, subjectId, reaction, !selected);
        if (direction === "up") { up = result.count; upSelected = result.viewerHasReacted; }
        else { down = result.count; downSelected = result.viewerHasReacted; }
        refresh();
      }).finally(() => { pending = false; refresh(); });
    });
    container.append(button);
  }
  refresh();
  return container;
}

async function authenticateAndRun(
  action: (token: NonNullable<ReturnType<Authentication["token"]>>) => Promise<void>,
): Promise<void> {
  try {
    const token = await requireAuthentication("Sign in to vote or react on GitHub.");
    await action(token);
    await render(true);
    status.textContent = "Updated on GitHub.";
  } catch (error) {
    console.error("GitHub interaction failed", error);
    status.textContent = error instanceof Error ? error.message : "GitHub interaction failed.";
  }
}

function sortedComments(values: unknown[]): unknown[] {
  return [...values].sort((left, right) => {
    const a = Date.parse(string(record(left)?.createdAt)) || 0;
    const b = Date.parse(string(record(right)?.createdAt)) || 0;
    return replyOrder === "newest" ? b - a : a - b;
  });
}

async function requireAuthentication(message: string): Promise<NonNullable<ReturnType<Authentication["token"]>>> {
  const existing = authentication.token();
  if (existing) return existing;
  if (authDialogEnabled) {
    const dialog = required("authentication-dialog") as HTMLDialogElement;
    required("authentication-message").textContent = message;
    await new Promise<void>((resolve, reject) => {
      const button = required("authentication-continue") as HTMLButtonElement;
      let started = false;
      const close = (): void => {
        dialog.removeEventListener("close", close);
        button.onclick = null;
        if (!started) reject(new Error("Sign in was cancelled."));
      };
      button.onclick = () => {
        started = true;
        dialog.close();
        resolve();
      };
      dialog.addEventListener("close", close);
      dialog.showModal();
    });
  }
  const token = await authentication.authenticate();
  authenticationStatus.refresh();
  updateAuthenticationUi();
  const activeReply = replyTo;
  await render(true);
  if (activeReply) {
    replyTo = activeReply;
    required("clear-reply").hidden = false;
    const replyArticle = [...document.querySelectorAll<HTMLElement>(".comment[data-comment-id]")]
      .find((article) => article.dataset.commentId === activeReply.id);
    replyArticle?.querySelector(".comment-footer")?.after(commentForm);
  }
  return token;
}

function renderMissingDiscussion(
  root: HTMLElement,
  key: string,
  state: ReactionState | undefined,
): void {
  appendText(root, "h2", key);
  appendText(root, "p", "No GitHub discussion exists yet. Anonymous counters still resolve to zero.");
  appendText(root, "span", `👍 ${String(state?.up ?? 0)} · 👎 ${String(state?.down ?? 0)}`, "tag");
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  for (const [name, count] of Object.entries(state?.reactions ?? {})) {
    const tag = appendText(reactions, "span", `${reactionEmoji(name)} ${String(count)}`, "tag");
    tag.title = reactionLabel(name);
  }
  root.append(reactions);
  const button = actionButton("Sign in and create with first vote", () => vote(key, "up"));
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

function renderAuthor(
  parent: Element,
  authorValue: unknown,
  createdAt: unknown,
  admin = false,
): void {
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
  if (admin) appendText(header, "span", "Admin", "admin-flair");
  const timestamp = string(createdAt);
  if (timestamp) appendText(header, "time", new Date(timestamp).toLocaleString());
  parent.append(header);
}

function isAdmin(value: Record<string, unknown>): boolean {
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(string(value.authorAssociation));
}

function parseKeys(input: string): string[] {
  return [...new Set(input.split(",").map((value) => value.trim()).filter(Boolean))];
}

function updateConfigOutput(): void {
  const config = {
    site,
    cards: keys,
    discussion: selectedKey,
    api: apiOrigin,
    github: githubMode,
    votes: separateVotes ? "separate" : "reactions",
    replyOrder,
    cardReactions: showCardReactions,
    title: visibility.title,
    firstPost: visibility.root,
    metadata: visibility.metadata,
    poll: visibility.poll,
    actions: visibility.discussionActions,
    composer: composeOnTop.checked ? "top" : "bottom",
    authDialog: authDialogEnabled,
  };
  const code = `const feedbackConfig = ${JSON.stringify(config, null, 2)};\n` +
    `const feedbackUrl = new URL(${JSON.stringify(new URL("/example/", location.origin).href)});\n` +
    `feedbackUrl.search = new URLSearchParams({\n` +
    `  site: feedbackConfig.site, cards: feedbackConfig.cards.join(","),\n` +
    `  discussion: feedbackConfig.discussion, api: feedbackConfig.api,\n` +
    `  github: feedbackConfig.github, votes: feedbackConfig.votes,\n` +
    `  replyOrder: feedbackConfig.replyOrder, cardReactions: feedbackConfig.cardReactions ? "visible" : "hidden",\n` +
    `  title: feedbackConfig.title ? "visible" : "hidden", firstPost: feedbackConfig.firstPost ? "visible" : "hidden",\n` +
    `  metadata: feedbackConfig.metadata ? "visible" : "hidden", poll: feedbackConfig.poll ? "visible" : "hidden",\n` +
    `  actions: feedbackConfig.actions ? "visible" : "hidden", composer: feedbackConfig.composer,\n` +
    `  authDialog: feedbackConfig.authDialog ? "on" : "off", embed: "1"\n` +
    `}).toString();\n` +
    `const feedbackFrame = document.createElement("iframe");\n` +
    `feedbackFrame.src = feedbackUrl.href;\n` +
    `feedbackFrame.title = "Feedback discussion";\n` +
    `feedbackFrame.style.cssText = "width:100%;min-height:900px;border:0";\n` +
    `document.currentScript.after(feedbackFrame);`;
  required("config-output").textContent = code;
}

function showDiscussionDialog(content: Record<string, unknown>, url: string): void {
  const dialog = required("discussion-dialog") as HTMLDialogElement;
  required("discussion-dialog-title").textContent = string(content.title) || "Discussion";
  const body = required("discussion-dialog-content");
  body.replaceChildren();
  renderMarkdown(body, string(content.bodyHTML), string(content.body));
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "discussion-access";
  link.textContent = "Open full discussion on GitHub ↗";
  body.append(link);
  dialog.showModal();
}

function discussionIcon(kind: "preview" | "external"): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("discussion-access-icon");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", kind === "preview"
    ? "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
    : "M13 4h7v7m0-7-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5");
  svg.append(path);
  return svg;
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
