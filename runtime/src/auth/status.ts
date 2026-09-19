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
  const message = document.createElement("span");
  const action = document.createElement("button");
  action.type = "button";
  element.append(message, action);
  options.mount.replaceChildren(element);

  const refresh = (): void => {
    const token = options.authentication.token();
    const signedIn = token !== null;
    message.textContent = signedIn
      ? (options.signedInLabel?.(token.viewerId) ?? "Authenticated")
      : (options.signedOutLabel ?? "Not authenticated");
    action.textContent = signedIn
      ? (options.logoutLabel ?? "Log out")
      : (options.loginLabel ?? "Log in");
    action.setAttribute("aria-label", action.textContent);
    action.onclick = () => {
      if (options.authentication.token() !== null) {
        options.authentication.clear();
        refresh();
        return;
      }
      action.disabled = true;
      void options.authentication.authenticate()
        .then(refresh)
        .catch((error: unknown) => {
          options.onError?.(error);
          refresh();
        })
        .finally(() => { action.disabled = false; });
    };
  };

  if (options.explanation) {
    const explanation = document.createElement("small");
    explanation.textContent = options.explanation;
    element.insertBefore(explanation, message);
  }
  refresh();
  return { element, refresh };
}
