import { test } from "node:test";
import assert from "node:assert/strict";
import { adviceFor, classifyError, cleanError, describeError, RATE_LIMIT_ADVICE } from "./errorAdvice";

test("cleanError drops the engine's boilerplate", () => {
  assert.equal(cleanError("Encountered an error in the response stream: boom"), "boom");
  assert.equal(cleanError("An unknown error occurred: boom"), "boom");
  assert.equal(cleanError("dispatch failure - service error - something broke"), "Something broke");
  assert.equal(cleanError("dispatch failure"), "dispatch failure");
  assert.equal(cleanError("No token found"), "Not authenticated");
  assert.equal(cleanError("the token expired"), "Session expired");
  assert.equal(cleanError("error sending request for url (https://x)"), "Network error - unable to connect");
  assert.equal(cleanError("I/O error talking to url (https://x)"), "Network error - unable to reach service");
  assert.equal(cleanError("io error"), "Network error");
  assert.equal(cleanError("plain failure"), "plain failure");
});

test("classifyError follows the TUI's rules in order", () => {
  const cases: Array<[string, string]> = [
    ["No token", "auth"],
    ["request unauthorized", "auth"],
    ["please login", "auth"],
    ["Session not found", "session"],
    ["connection reset", "network"],
    ["ENOTFOUND api", "network"],
    ["EACCES: denied", "permission"],
    ["mcp server crashed", "mcp"],
    ["throttling exception", "rate_limit"],
    ["tool failed", "tool"],
    ["something else", "unknown"],
  ];
  for (const [msg, cat] of cases) {
    assert.equal(classifyError(msg), cat, msg);
  }
});

test("adviceFor gives a hint for auth, session, network and rate limit only", () => {
  assert.match(adviceFor("token expired", "/login") ?? "", /Log in again \(\/login\)/);
  assert.match(adviceFor("session locked", "x") ?? "", /start a new session/);
  assert.match(adviceFor("connection timeout", "x") ?? "", /timed out/);
  assert.match(adviceFor("ECONNREFUSED", "x") ?? "", /refused/);
  assert.match(adviceFor("ENOTFOUND host", "x") ?? "", /resolve host/);
  assert.match(adviceFor("network down", "x") ?? "", /Network error occurred/);
  assert.equal(adviceFor("rate limit hit", "x"), RATE_LIMIT_ADVICE);
  assert.equal(adviceFor("EACCES", "x"), undefined);
  assert.equal(adviceFor("mcp broke", "x"), undefined);
  assert.equal(adviceFor("weird", "x"), undefined);
});

test("describeError joins the message and the hint, without doubled dots", () => {
  assert.equal(describeError("weird failure", "x"), "weird failure");
  assert.equal(
    describeError("No token", "/login"),
    "Not authenticated. Log in again (/login), then try your message again."
  );
  assert.equal(describeError("Request failed.", "x").endsWith("failed."), true);
  assert.equal(
    describeError("Session lost.", "x"),
    "Session lost. A session error occurred. Please try again, or start a new session if it keeps happening."
  );
});
