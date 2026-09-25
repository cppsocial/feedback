import type { FeedbackClient, ReactionState } from "../api/client.js";
import type { Authentication } from "../auth/controller.js";
import type { Resource } from "./resources.js";
import { viewerSubjectStates } from "../protocol/github.js";

export interface VoteItem {
  mount: HTMLElement;
  resource: Resource;
  direction: "up" | "down";
}

export interface VoteControlsOptions {
  client: FeedbackClient;
  authentication: Authentication;
  items: readonly VoteItem[];
  format?: (count: number, selected: boolean, direction: "up" | "down") => string;
  onError?: (error: unknown) => void;
}

export interface VoteControls {
  refresh(signal?: AbortSignal): Promise<void>;
  destroy(): void;
}

/** Create thumbs-up/down reaction vote buttons and batch their initial counter reads. */
export function createVoteControls(options: VoteControlsOptions): VoteControls {
  const format = options.format ?? ((count, selected, direction) =>
    `${direction === "up" ? "👍" : "👎"} ${String(count)}${selected ? " ✓" : ""}`);
  const buttons = new Map<VoteItem, HTMLButtonElement>();
  const listeners = new Map<HTMLButtonElement, () => void>();
  let states = new Map(options.client.cachedReactions(options.items.map((item) => item.resource.key)));
  let selections = new Map<string, ReadonlySet<string>>();

  for (const item of options.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.feedbackVote = `${item.resource.key}:${item.direction}`;
    const activate = (): void => { void toggle(item, button); };
    button.addEventListener("click", activate);
    listeners.set(button, activate);
    buttons.set(item, button);
    item.mount.replaceChildren(button);
    render(button, item, states.get(item.resource.key));
  }

  async function refresh(signal?: AbortSignal): Promise<void> {
    const keys = options.items.map((item) => item.resource.key);
    states = new Map(await options.client.reactions(keys, signal));
    const token = options.authentication.token();
    selections.clear();
    if (token !== null) {
      try {
        const ids = [...states.values()].flatMap((state) => state.id ? [state.id] : []);
        const viewer = await viewerSubjectStates(token, ids);
        selections = new Map([...states].map(([key, state]) => [key,
          state.id ? viewer.get(state.id)?.reactions ?? new Set<string>() : new Set<string>(),
        ]));
      } catch (error) {
        options.onError?.(error);
      }
    }
    for (const [item, button] of buttons) render(button, item, states.get(item.resource.key));
  }

  async function toggle(item: VoteItem, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const token = options.authentication.token() ?? await options.authentication.authenticate();
      const resource = item.resource;
      let state = states.get(resource.key);
      if (!state?.id) {
        await options.client.ensure(resource, token.creationGrant);
        state = (await options.client.reactions([resource.key])).get(resource.key);
      }
      if (!state?.id) throw new Error("Discussion could not be resolved");
      const known = selections.get(resource.key);
      const current = known === undefined ? undefined : known.has("THUMBS_UP") ? "up"
        : known.has("THUMBS_DOWN") ? "down" : null;
      const result = await options.client.vote(resource.key, token, item.direction, current);
      state = { ...state, up: result.up, down: result.down };
      states.set(resource.key, state);
      selections.set(resource.key, new Set(result.selected === "up" ? ["THUMBS_UP"]
        : result.selected === "down" ? ["THUMBS_DOWN"] : []));
      for (const [currentItem, currentButton] of buttons) {
        if (currentItem.resource.key === resource.key) render(currentButton, currentItem, state);
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      button.disabled = false;
    }
  }

  function render(button: HTMLButtonElement, item: VoteItem, state: ReactionState | undefined): void {
    const selected = selections.get(item.resource.key)?.has(item.direction === "up" ? "THUMBS_UP" : "THUMBS_DOWN") ?? false;
    button.textContent = format(item.direction === "up" ? state?.up ?? 0 : state?.down ?? 0, selected, item.direction);
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
