import { trustedOrigin } from "../auth/origin.js";

export interface CallbackPayload {
  type: "cppsocial-feedback-oauth";
  state: string;
  code?: string;
  error?: string;
}

export interface CallbackMessage {
  origin: string;
  payload: CallbackPayload;
}

export function callbackMessage(parameters: URLSearchParams): CallbackMessage {
  const state = parameters.get("state");
  if (!state || state.length > 4096) throw new TypeError("Invalid OAuth state");
  const [encoded] = state.split(".", 1);
  if (!encoded) throw new TypeError("Invalid OAuth state");
  let decoded: { origin?: unknown };
  try {
    decoded = JSON.parse(decodeBase64Url(encoded)) as { origin?: unknown };
  } catch {
    throw new TypeError("Invalid OAuth state");
  }
  if (typeof decoded.origin !== "string") throw new TypeError("Invalid OAuth origin");
  const origin = trustedOrigin(decoded.origin, "OAuth origin");
  const code = parameters.get("code");
  const error = parameters.get("error");
  if ((!code && !error) || (code && error)) throw new TypeError("Invalid OAuth response");
  return {
    origin,
    payload: {
      type: "cppsocial-feedback-oauth",
      state,
      ...(code ? { code } : { error: error ?? "authorization_failed" }),
    },
  };
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid OAuth state");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="));
}
