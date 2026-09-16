import { callbackMessage } from "./message.js";

const parameters = new URLSearchParams(location.search);
const state = parameters.get("state");
const opener = window.opener as Window | null;

if (state && opener) {
  try {
    const message = callbackMessage(parameters);
    opener.postMessage(message.payload, message.origin);
  } catch {
    document.title = "Authentication failed";
  }
}

window.close();
