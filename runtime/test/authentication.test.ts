import assert from "node:assert/strict";
import test from "node:test";

import { Authentication, type AuthEnvironment, type AuthMessage } from "../src/auth/controller.js";
import type { OAuthTransport } from "../src/auth/controller.js";
import type { KeyValueStorage } from "../src/storage.js";

void test("authentication verifies the callback and GitHub viewer before storing a token", async () => {
  const values = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let listener: ((message: AuthMessage) => void) | undefined;
  let navigated = "";
  let closed = false;
  const source = {};
  const environment: AuthEnvironment = {
    crypto: globalThis.crypto,
    openPopup: () => ({
      source,
      closed: false,
      navigate: (url) => { navigated = url; },
      close: () => { closed = true; },
    }),
    listen: (handler) => {
      listener = handler;
      return () => { listener = undefined; };
    },
    timeout: () => () => undefined,
    interval: () => () => undefined,
  };
  const service: OAuthTransport = {
    authorize: () => Promise.resolve({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      state: "signed-state",
    }),
    exchange: (code, state, verifier) => {
      assert.equal(code, "temporary-code");
      assert.equal(state, "signed-state");
      assert.equal(verifier.length, 43);
      return Promise.resolve({
        value: "ghu_user",
        expiresAt: 2_000_000_000,
        creationGrant: "grant",
      });
    },
  };
  const githubFetch = (): Promise<Response> => Promise.resolve(Response.json({
    data: {
      viewer: {
        id: "U_1",
        login: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
    },
  }));
  const authentication = new Authentication({
    site: "cpp-social",
    callbackOrigin: "https://feedback.cpp.social",
    service,
    storage,
    githubFetch,
    environment,
  });

  const pending = authentication.authenticate();
  for (let attempt = 0; attempt < 100 && listener === undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(navigated, "https://github.com/login/oauth/authorize");
  assert.ok(listener);
  listener({
    origin: "https://attacker.example",
    source,
    data: { type: "cppsocial-feedback-oauth", state: "signed-state", code: "stolen" },
  });
  listener({
    origin: "https://feedback.cpp.social",
    source: {},
    data: { type: "cppsocial-feedback-oauth", state: "signed-state", code: "stolen" },
  });
  listener({
    origin: "https://feedback.cpp.social",
    source,
    data: { type: "cppsocial-feedback-oauth", state: "wrong-state", code: "stolen" },
  });
  listener({
    origin: "https://feedback.cpp.social",
    source,
    data: { type: "cppsocial-feedback-oauth", state: "signed-state", code: "temporary-code" },
  });
  const token = await pending;

  assert.equal(token.value, "ghu_user");
  assert.equal(token.viewerLogin, "octocat");
  assert.equal(authentication.token()?.value, "ghu_user");
  assert.equal(closed, true);
  assert.equal([...values.values()].some((value) => value.includes("temporary-code")), false);
});

void test("authentication permits loopback HTTP but rejects other insecure origins", () => {
  const service = {
    authorize: (): Promise<never> => Promise.reject(new Error("unused")),
    exchange: (): Promise<never> => Promise.reject(new Error("unused")),
  };
  const storage: KeyValueStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  assert.doesNotThrow(() => new Authentication({
    site: "test",
    callbackOrigin: "http://localhost:8081",
    service,
    storage,
  }));
  assert.throws(() => new Authentication({
    site: "test",
    callbackOrigin: "http://example.com",
    service,
    storage,
  }), /loopback/);
});
