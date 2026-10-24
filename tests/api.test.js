import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

function mockGemini(byModel) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, { signal }) => {
    const model = url.match(/models\/([^:]+):/)[1];
    const { status = 200, text = "", delayMs = 0, body } = byModel[model] || { status: 404 };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        ok: status === 200,
        status,
        json: async () => body || ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] })
      }), delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      });
    });
  };
  process.env.GEMINI_API_KEY = "test-key";
  return () => {
    globalThis.fetch = original;
    delete process.env.GEMINI_API_KEY;
  };
}

test("answer comes from the fallback model when the main one is overloaded", async () => {
  const { askGemini } = await import("../api/index.js");
  const restore = mockGemini({
    "gemini-3.5-flash-lite": { status: 503 },
    "gemini-3.1-flash-lite": { text: "Ответ запасной модели", delayMs: 20 }
  });
  try {
    assert.equal(await askGemini("вопрос", [], "", 1000), "Ответ запасной модели");
  } finally {
    restore();
  }
});

test("the faster model wins the race", async () => {
  const { askGemini } = await import("../api/index.js");
  const restore = mockGemini({
    "gemini-3.5-flash-lite": { text: "Медленный", delayMs: 300 },
    "gemini-3.1-flash-lite": { text: "Быстрый", delayMs: 10 }
  });
  try {
    assert.equal(await askGemini("вопрос", [], "", 1000), "Быстрый");
  } finally {
    restore();
  }
});

test("slow Gemini is reported as a timeout, not as a generic failure", async () => {
  const { askGemini, errorForUser } = await import("../api/index.js");
  const restore = mockGemini({
    "gemini-3.5-flash-lite": { text: "поздно", delayMs: 2000 },
    "gemini-3.1-flash-lite": { text: "поздно", delayMs: 2000 }
  });
  try {
    await assert.rejects(askGemini("вопрос", [], "", 300), error => {
      assert.equal(error.message, "TIMEOUT");
      assert.match(errorForUser(error), /Не успела/);
      return true;
    });
  } finally {
    restore();
  }
});

test("overloaded Gemini gets its own message", async () => {
  const { askGemini, errorForUser } = await import("../api/index.js");
  const restore = mockGemini({
    "gemini-3.5-flash-lite": { status: 503 },
    "gemini-3.1-flash-lite": { status: 503 }
  });
  try {
    await assert.rejects(askGemini("вопрос", [], "", 1000), error => {
      assert.equal(error.message, "GEMINI_OVERLOADED");
      assert.match(errorForUser(error), /перегружена/);
      return true;
    });
  } finally {
    restore();
  }
});

test("spaces and quotes around the pasted key are removed", async () => {
  const { cleanKey } = await import("../api/index.js");
  assert.equal(cleanKey('  "AQ.abc-123"\n'), "AQ.abc-123");
  assert.equal(cleanKey("'AQ.abc'"), "AQ.abc");
  assert.equal(cleanKey("AIzaSyX"), "AIzaSyX");
});

test("invalid key answered with HTTP 400 is reported as a key problem", async () => {
  const { askGemini, errorForUser } = await import("../api/index.js");
  const invalidKey = {
    status: 400,
    body: { error: { code: 400, message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } }
  };
  const restore = mockGemini({ "gemini-3.5-flash-lite": invalidKey, "gemini-3.1-flash-lite": invalidKey });
  try {
    await assert.rejects(askGemini("вопрос", [], "", 1000), error => {
      assert.equal(error.message, "GEMINI_KEY_REJECTED");
      assert.match(errorForUser(error), /API-ключ/);
      return true;
    });
  } finally {
    restore();
  }
});

test("unexpected Gemini errors name the HTTP status", async () => {
  const { askGemini, errorForUser } = await import("../api/index.js");
  const restore = mockGemini({
    "gemini-3.5-flash-lite": { status: 400, body: { error: { message: "Bad request" } } },
    "gemini-3.1-flash-lite": { status: 400, body: { error: { message: "Bad request" } } }
  });
  try {
    await assert.rejects(askGemini("вопрос", [], "", 1000), error => {
      assert.match(errorForUser(error), /ошибка 400/);
      return true;
    });
  } finally {
    restore();
  }
});

test("invisible characters inside the key are removed", async () => {
  const { cleanKey } = await import("../api/index.js");
  assert.equal(cleanKey("AQ.Ab8\u200bRN6\nI4b\uFEFF"), "AQ.Ab8RN6I4b");
  assert.equal(cleanKey("«AQ.abc»"), "AQ.abc");
});

test("a key with Cyrillic letters gets a clear message instead of a network error", async () => {
  const { askGemini, errorForUser } = await import("../api/index.js");
  const restore = mockGemini({});
  process.env.GEMINI_API_KEY = "\u0410Q.Ab8RN6I4b";
  try {
    await assert.rejects(askGemini("вопрос", [], "", 1000), error => {
      assert.equal(error.message, "GEMINI_KEY_MALFORMED");
      assert.match(errorForUser(error), /русские буквы/);
      return true;
    });
  } finally {
    restore();
  }
});
