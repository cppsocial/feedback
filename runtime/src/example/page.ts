import { FeedbackClient, FeedbackError } from "../api/client.js";
import { Authentication } from "../auth/controller.js";
import { PendingVoteStore } from "../auth/pending-vote.js";
import { trustedOrigin } from "../auth/origin.js";
import type { Resource } from "../feedback/resources.js";
import type { Vote, ViewerVote } from "../protocol/github.js";

interface Card {
  resource: Resource;
  discussionId: string | null;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  star: HTMLButtonElement;
  starred: boolean;
}

const parameters = new URLSearchParams(location.search);
const site = parameters.get("site") ?? "feedback-cpp-social";
const apiOrigin = exampleApiOrigin(parameters.get("api"));
const resources: Resource[] = [
  exampleResource("feedback/example", "General feedback", "general"),
  exampleResource("feedback/documentation", "Documentation", "documentation"),
  exampleResource("feedback/navigation", "Navigation", "navigation"),
  exampleResource("feedback/design", "Visual design", "design"),
];
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({ site, callbackOrigin: location.origin, service: client });
const pendingVotes = new PendingVoteStore(site);
const status = requiredElement("status");
const cards = new Map(resources.map((resource) => [resource.key, createCard(resource)]));
requiredElement("api-origin").textContent = apiOrigin;

renderCached();
void refresh();
const existingToken = authentication.token();
if (existingToken !== null) void refreshViewer(existingToken);

function renderCached(): void {
  const cached = client.cachedReactions(resources.map(({ key }) => key));
  if (cached.size === 0) return;
  for (const [key, state] of cached) {
    const card = cards.get(key);
    if (!card) continue;
    card.discussionId = state.id;
    render(card, state.up, state.down, state.viewer, state.starred);
  }
  status.textContent = "Showing saved counts while updating…";
}

async function refresh(): Promise<void> {
  try {
    const states = await client.reactions(resources.map(({ key }) => key));
    let stale = false;
    for (const [key, card] of cards) {
      const state = states.get(key);
      if (!state) throw new Error(`Missing reaction state for ${key}`);
      card.discussionId = state.id;
      render(card, state.up, state.down, state.viewer, state.starred);
      stale ||= state.stale;
    }
    status.textContent = stale ? "Some cached counts could not be refreshed." : "Ready.";
  } catch (error) {
    showError(error);
  }
}

async function castVote(card: Card, requested: Vote): Promise<void> {
  pendingVotes.set(card.resource.key, requested);
  disable(true);
  status.textContent = "Authenticating…";
  try {
    let token = authentication.token();
    if (token === null) {
      token = await authentication.authenticate();
      await refreshViewer(token);
    }
    const pending = pendingVotes.take();
    if (pending?.resourceKey !== card.resource.key) throw new Error("The pending vote was lost.");
    if (card.discussionId === null) {
      const discussion = await client.ensure(card.resource, token.creationGrant);
      card.discussionId = discussion.id;
    }
    const result = await client.vote(card.resource.key, pending.vote, token);
    render(card, result.up, result.down, result.viewer, card.starred);
    status.textContent = result.viewer === "none"
      ? "Vote removed."
      : result.viewer === "both" ? "Conflicting votes detected." : `${result.viewer} vote saved.`;
  } catch (error) {
    pendingVotes.clear();
    if (error instanceof FeedbackError && error.status === 401) authentication.clear();
    showError(error);
  } finally {
    disable(false);
  }
}

async function toggleStar(card: Card): Promise<void> {
  disable(true);
  status.textContent = "Authenticating…";
  try {
    let token = authentication.token();
    if (token === null) {
      token = await authentication.authenticate();
      await refreshViewer(token);
    }
    if (card.discussionId === null) {
      const discussion = await client.ensure(card.resource, token.creationGrant);
      card.discussionId = discussion.id;
    }
    const starred = await client.toggleStar(card.resource.key, token);
    card.starred = starred;
    card.star.setAttribute("aria-pressed", String(starred));
    status.textContent = starred ? "Star saved." : "Star removed.";
  } catch (error) {
    if (error instanceof FeedbackError && error.status === 401) authentication.clear();
    showError(error);
  } finally {
    disable(false);
  }
}

async function refreshViewer(token: NonNullable<ReturnType<Authentication["token"]>>): Promise<void> {
  try {
    const states = await client.syncViewerReactions(resources.map(({ key }) => key), token);
    for (const [key, state] of states) {
      const card = cards.get(key);
      if (card) render(card, state.up, state.down, state.viewer, state.starred);
    }
  } catch (error) {
    if (error instanceof FeedbackError && error.status === 401) authentication.clear();
    else showError(error);
  }
}

function createCard(resource: Resource): Card {
  const article = document.createElement("article");
  article.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = resource.title ?? resource.key;
  const controls = document.createElement("div");
  controls.className = "controls";
  controls.setAttribute("aria-label", `Feedback controls for ${heading.textContent}`);
  const up = button("▲ 0");
  const down = button("▼ 0");
  const star = button("★ Star");
  const card: Card = { resource, discussionId: null, up, down, star, starred: false };
  up.addEventListener("click", () => { void castVote(card, "up"); });
  down.addEventListener("click", () => { void castVote(card, "down"); });
  star.setAttribute("aria-pressed", "false");
  star.addEventListener("click", () => { void toggleStar(card); });
  controls.append(up, down, star);
  article.append(heading, controls);
  requiredElement("cards").append(article);
  return card;
}

function render(
  card: Card,
  up: number,
  down: number,
  viewer: ViewerVote = "none",
  starred = false,
): void {
  card.up.textContent = `▲ ${String(up)}`;
  card.down.textContent = `▼ ${String(down)}`;
  card.up.setAttribute("aria-pressed", String(viewer === "up" || viewer === "both"));
  card.down.setAttribute("aria-pressed", String(viewer === "down" || viewer === "both"));
  card.star.setAttribute("aria-pressed", String(starred));
  card.starred = starred;
}

function disable(value: boolean): void {
  for (const card of cards.values()) {
    card.up.disabled = value;
    card.down.disabled = value;
    card.star.disabled = value;
  }
}

function button(text: string): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.textContent = text;
  return result;
}

function exampleResource(key: string, title: string, card: string): Resource {
  return { key, title, url: `${location.origin}/example/?card=${encodeURIComponent(card)}` };
}

function showError(error: unknown): void {
  status.textContent = error instanceof TypeError && error.message === "Failed to fetch"
    ? `Cannot reach the feedback API at ${apiOrigin}.`
    : error instanceof Error ? error.message : "Unexpected error.";
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element;
}

function exampleApiOrigin(value: string | null): string {
  if (value === null && isLoopback(location.hostname)) {
    const local = new URL(location.origin);
    local.port = "8090";
    return local.origin;
  }
  if (value === null) return "https://feedback-api.cpp.social";
  return trustedOrigin(value, "example API origin");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
