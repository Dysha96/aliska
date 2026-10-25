import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { handler } = createRequire(import.meta.url)("../yandex-cloud/index.js");

function mockFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test("relay forwards the Alice request and returns the skill's answer", async () => {
  let sent;
  const restore = mockFetch(async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ version: "1.0", response: { text: "Ответ", end_session: false } }) };
  });
  try {
    const event = { session: { session_id: "s" }, request: { command: "привет" }, version: "1.0" };
    const result = await handler(event);
    assert.equal(sent.url, "https://aliska.vercel.app/api");
    assert.deepEqual(sent.body, event);
    assert.equal(result.response.text, "Ответ");
  } finally {
    restore();
  }
});

test("relay explains when the skill server cannot be reached", async () => {
  const restore = mockFetch(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
  try {
    const result = await handler({ request: { command: "привет" } });
    assert.match(result.response.text, /Не могу достучаться/);
    assert.equal(result.response.end_session, false);
  } finally {
    restore();
  }
});

test("relay reports an HTTP error from the skill", async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    assert.match((await handler({})).response.text, /ошибкой 500/);
  } finally {
    restore();
  }
});
