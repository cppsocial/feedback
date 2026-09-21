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
  action.className = "feedback-authentication-dot";
  element.append(action);
  options.mount.replaceChildren(element);

  const refresh = (): void => {
    const token = options.authentication.token();
    const signedIn = token !== null;
    const status = signedIn
      ? (options.signedInLabel?.(token.viewerId) ?? "Authenticated")
      : (options.signedOutLabel ?? "Not authenticated");
    action.classList.toggle("authenticated", signedIn);
    action.title = `${status}. ${signedIn ? (options.logoutLabel ?? "Log out") : (options.loginLabel ?? "Log in")}`;
    action.setAttribute("aria-label", action.title);
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
