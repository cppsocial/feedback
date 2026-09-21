import type { FeedbackClient, ReactionState } from "../api/client.js";
import type { Authentication } from "../auth/controller.js";
import type { Resource } from "./resources.js";

export interface UpvoteItem {
  mount: HTMLElement;
  resource: Resource;
}

export interface UpvoteControlsOptions {
  client: FeedbackClient;
  authentication: Authentication;
  items: readonly UpvoteItem[];
  format?: (count: number, selected: boolean) => string;
  onError?: (error: unknown) => void;
}

export interface UpvoteControls {
  refresh(signal?: AbortSignal): Promise<void>;
  destroy(): void;
}

/** Create accessible native-discussion upvote buttons and batch their reads. */
export function createUpvoteControls(options: UpvoteControlsOptions): UpvoteControls {
  const format = options.format ?? ((count, selected) => `${selected ? "Remove upvote" : "Upvote"} (${String(count)})`);
  const buttons = new Map<string, HTMLButtonElement>();
  const listeners = new Map<HTMLButtonElement, () => void>();
  let states = new Map<string, ReactionState>();

  for (const item of options.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.feedbackUpvote = item.resource.key;
    const activate = (): void => { void toggle(item.resource, button); };
    button.addEventListener("click", activate);
    listeners.set(button, activate);
    buttons.set(item.resource.key, button);
    item.mount.replaceChildren(button);
    render(button, undefined);
  }

  async function refresh(signal?: AbortSignal): Promise<void> {
    const keys = options.items.map((item) => item.resource.key);
    states = new Map(await options.client.reactions(keys, signal));
    const token = options.authentication.token();
    if (token !== null) states = new Map(await options.client.syncViewerUpvotes(keys, token, signal));
    for (const [key, button] of buttons) render(button, states.get(key));
  }

  async function toggle(resource: Resource, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const token = options.authentication.token() ?? await options.authentication.authenticate();
      let state = states.get(resource.key);
      if (!state?.id) {
        await options.client.ensure(resource, token.creationGrant);
        state = (await options.client.reactions([resource.key])).get(resource.key);
      }
      if (!state?.id) throw new Error("Discussion could not be resolved");
      const result = await options.client.toggleUpvote(resource.key, token);
      state = { ...state, upvotes: result.count, viewerHasUpvoted: result.viewerHasUpvoted, viewerKnown: true };
      states.set(resource.key, state);
      render(button, state);
    } catch (error) {
      options.onError?.(error);
    } finally {
      button.disabled = false;
    }
  }

  function render(button: HTMLButtonElement, state: ReactionState | undefined): void {
    const selected = state?.viewerHasUpvoted ?? false;
    button.textContent = format(state?.upvotes ?? 0, selected);
    button.setAttribute("aria-pressed", String(selected));
  }

  return {
    refresh,
    destroy(): void {
      for (const [button, listener] of listeners) button.removeEventListener("click", listener);
      buttons.clear();
      listeners.clear();
    },
  };
}
