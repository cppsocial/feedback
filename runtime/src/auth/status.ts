import type { Authentication } from "./controller.js";

export interface AuthenticationStatusOptions {
  mount: HTMLElement;
  authentication: Authentication;
  signedOutLabel?: string;
  signedInLabel?: (viewerId?: string) => string;
  explanation?: string;
  loginLabel?: string;
  logoutLabel?: string;
  onError?: (error: unknown) => void;
  onChange?: (authenticated: boolean) => void;
}

export interface AuthenticationStatusController {
  readonly element: HTMLElement;
  refresh(): void;
}

export function createAuthenticationStatus(
  options: AuthenticationStatusOptions,
): AuthenticationStatusController {
  const element = document.createElement("section");
  element.className = "feedback-authentication-status";
  const action = document.createElement("button");
  action.type = "button";
  action.className = "feedback-authentication-action";
  const dot = document.createElement("span");
  dot.className = "feedback-authentication-dot";
  dot.setAttribute("aria-hidden", "true");
  const identity = document.createElement("span");
  element.append(dot, identity, action);
  options.mount.replaceChildren(element);

  const refresh = (): void => {
    const token = options.authentication.token();
    const signedIn = token !== null;
    const status = signedIn
      ? (options.signedInLabel?.(token.viewerId) ?? "Authenticated")
      : (options.signedOutLabel ?? "Not authenticated");
    dot.classList.toggle("authenticated", signedIn);
    identity.replaceChildren();
    if (signedIn) {
      const profile = document.createElement("a");
      profile.href = `https://github.com/${encodeURIComponent(token.viewerLogin ?? "")}`;
      profile.target = "_blank";
      profile.rel = "noopener noreferrer";
      if (token.viewerAvatarUrl) {
        const avatar = document.createElement("img");
        avatar.src = token.viewerAvatarUrl;
        avatar.alt = "";
        avatar.width = 24;
        avatar.height = 24;
        profile.append(avatar);
      }
      profile.append(document.createTextNode(token.viewerLogin ?? status));
      identity.append(profile);
    }
    action.textContent = signedIn
      ? (options.logoutLabel ?? "Log out")
      : (options.loginLabel ?? "Log in with GitHub");
    action.setAttribute("aria-label", `${status}. ${action.textContent}`);
    action.onclick = () => {
      if (options.authentication.token() !== null) {
        options.authentication.clear();
        refresh();
        options.onChange?.(false);
        return;
      }
      action.disabled = true;
      void options.authentication.authenticate()
        .then(() => {
          refresh();
          options.onChange?.(true);
        })
        .catch((error: unknown) => {
          options.onError?.(error);
          refresh();
        })
        .finally(() => { action.disabled = false; });
    };
  };

  if (options.explanation) element.title = options.explanation;
  refresh();
  return { element, refresh };
}
