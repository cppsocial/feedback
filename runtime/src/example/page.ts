import { FeedbackClient, FeedbackError } from "../api/client.js";
import { Authentication } from "../auth/controller.js";
import { PendingVoteStore } from "../auth/pending-vote.js";
import { trustedOrigin } from "../auth/origin.js";
import type { Resource } from "../feedback/resources.js";
import { Stars } from "../feedback/stars.js";
import type { Vote, ViewerVote } from "../protocol/github.js";

interface Card {
  resource: Resource;
  discussionId: string | null;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  star: HTMLButtonElement;
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
const stars = new Stars(site);
const pendingVotes = new PendingVoteStore(site);
const status = requiredElement("status");
const cards = new Map(resources.map((resource) => [resource.key, createCard(resource)]));
requiredElement("api-origin").textContent = apiOrigin;

renderCached();
void refresh();

function renderCached(): void {
  const cached = client.cachedReactions(resources.map(({ key }) => key));
  if (cached.size === 0) return;
  for (const [key, state] of cached) {
    const card = cards.get(key);
    if (!card) continue;
    card.discussionId = state.id;
    render(card, state.up, state.down);
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
      render(card, state.up, state.down);
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
    token ??= await authentication.authenticate();
    const pending = pendingVotes.take();
    if (pending?.resourceKey !== card.resource.key) throw new Error("The pending vote was lost.");
    if (card.discussionId === null) {
      const discussion = await client.ensure(card.resource, token.creationGrant);
      card.discussionId = discussion.id;
    }
    const result = await client.vote(card.resource.key, pending.vote, token);
    render(card, result.up, result.down, result.viewer);
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
  const card: Card = { resource, discussionId: null, up, down, star };
  up.addEventListener("click", () => { void castVote(card, "up"); });
  down.addEventListener("click", () => { void castVote(card, "down"); });
  star.setAttribute("aria-pressed", String(stars.has(resource.key)));
  star.addEventListener("click", () => {
    const active = stars.toggle(resource.key);
    star.setAttribute("aria-pressed", String(active));
    status.textContent = active ? "Starred locally." : "Local star removed.";
  });
  controls.append(up, down, star);
  article.append(heading, controls);
  requiredElement("cards").append(article);
  return card;
}

function render(card: Card, up: number, down: number, viewer: ViewerVote = "none"): void {
  card.up.textContent = `▲ ${String(up)}`;
  card.down.textContent = `▼ ${String(down)}`;
  card.up.setAttribute("aria-pressed", String(viewer === "up" || viewer === "both"));
  card.down.setAttribute("aria-pressed", String(viewer === "down" || viewer === "both"));
}

function disable(value: boolean): void {
  for (const card of cards.values()) {
    card.up.disabled = value;
    card.down.disabled = value;
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
