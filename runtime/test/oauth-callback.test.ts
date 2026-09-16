import assert from "node:assert/strict";
import test from "node:test";

import { callbackMessage } from "../src/callback/message.js";

function state(origin: string): string {
  const payload = Buffer.from(JSON.stringify({ origin })).toString("base64url");
  return `${payload}.signature`;
}

void test("callback targets only the origin bound into state", () => {
  const message = callbackMessage(
    new URLSearchParams({ state: state("https://cpp.social"), code: "temporary-code" }),
  );

  assert.equal(message.origin, "https://cpp.social");
  assert.deepEqual(message.payload, {
    type: "cppsocial-feedback-oauth",
    state: state("https://cpp.social"),
    code: "temporary-code",
  });
});

void test("callback rejects non-HTTPS and malformed responses", () => {
  assert.throws(
    () => callbackMessage(new URLSearchParams({ state: state("https://cpp.social/path"), code: "code" })),
    /origin/,
  );
  assert.throws(
    () => callbackMessage(new URLSearchParams({ state: state("http://cpp.social"), code: "code" })),
    /origin/,
  );
  assert.throws(() => callbackMessage(new URLSearchParams({ state: "bad", code: "code" })), /state/);
});

void test("callback supports a loopback development origin", () => {
  const message = callbackMessage(new URLSearchParams({
    state: state("http://localhost:8081"),
    code: "temporary-code",
  }));

  assert.equal(message.origin, "http://localhost:8081");
  assert.equal(message.payload.code, "temporary-code");
});
