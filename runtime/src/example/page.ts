import { FeedbackClient } from "../api/client.js";
import { Authentication } from "../auth/controller.js";
import { PendingVoteStore } from "../auth/pending-vote.js";
import { trustedOrigin } from "../auth/origin.js";
import { Stars } from "../feedback/stars.js";
import { GitHubRequestError, viewerVote, vote, type Vote } from "../protocol/github.js";

const parameters = new URLSearchParams(location.search);
const site = parameters.get("site") ?? "feedback-cpp-social";
const apiOrigin = exampleApiOrigin(parameters.get("api"));
const resource = {
  key: "feedback/example",
  title: "Feedback integration example",
  url: `${location.origin}/example/`,
};
const client = new FeedbackClient({ apiOrigin, site });
const authentication = new Authentication({
  site,
  callbackOrigin: location.origin,
  service: client,
});
const stars = new Stars(site);
const pendingVotes = new PendingVoteStore(site);
const status = requiredElement("status");
requiredElement("api-origin").textContent = apiOrigin;
const up = requiredButton("up");
const down = requiredButton("down");
const star = requiredButton("star");
let discussionId: string | null = null;

void refresh();
up.addEventListener("click", () => { void castVote("up"); });
down.addEventListener("click", () => { void castVote("down"); });
star.addEventListener("click", () => {
  const active = stars.toggle(resource.key);
  star.setAttribute("aria-pressed", String(active));
  status.textContent = active ? "Starred locally." : "Local star removed.";
});
star.setAttribute("aria-pressed", String(stars.has(resource.key)));

async function refresh(): Promise<void> {
  try {
    const state = (await client.reactions([resource.key])).get(resource.key);
    if (!state) throw new Error("Missing reaction state");
    discussionId = state.id;
    render(state.up, state.down);
    status.textContent = state.stale ? "Showing cached counts." : "Ready.";
  } catch (error) {
    showError(error);
  }
}

async function castVote(requested: Vote): Promise<void> {
  pendingVotes.set(resource.key, requested);
  disable(true);
  status.textContent = "Authenticating…";
  try {
    let token = authentication.token();
    token ??= await authentication.authenticate();
    const pending = pendingVotes.take();
    if (pending?.resourceKey !== resource.key) {
      throw new Error("The pending vote was lost.");
    }
    if (discussionId === null) {
      const discussion = await client.ensure(resource, token.creationGrant);
      discussionId = discussion.id;
    }
    const current = await viewerVote(token, discussionId);
    const result = await vote(token, discussionId, current, pending.vote);
    render(result.up, result.down);
    status.textContent = result.viewer === "none" ? "Vote removed." : `${result.viewer} vote saved.`;
  } catch (error) {
    pendingVotes.clear();
    if (error instanceof GitHubRequestError && error.status === 401) authentication.clear();
    showError(error);
  } finally {
    disable(false);
  }
}

function render(upCount: number, downCount: number): void {
  up.textContent = `▲ ${String(upCount)}`;
  down.textContent = `▼ ${String(downCount)}`;
}

function disable(value: boolean): void {
  up.disabled = value;
  down.disabled = value;
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

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} is not a button`);
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
