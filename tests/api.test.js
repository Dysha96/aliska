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

test("history filters malformed messages and keeps last 16", () => {
  const input = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 16);
  assert.equal(result[0].text, "4");
  assert.equal(result[15].text, "19");
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
  assert.deepEqual(payload, { ok: true });
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

function mockSearch(reply) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
      delete process.env.TAVILY_API_KEY;
      delete process.env.SERPER_API_KEY;
    }
  };
}

test("Tavily is used when its key is set, even if Serper is configured too", async () => {
  const { searchWeb } = await import("../api/index.js");
  const mock = mockSearch({
    status: 200,
    body: { results: [{ title: "ЦБ РФ", content: "Курс доллара 95 рублей", url: "https://cbr.ru" }] }
  });
  process.env.TAVILY_API_KEY = " tvly-test ";
  process.env.SERPER_API_KEY = "serper-test";
  try {
    const context = await searchWeb("курс доллара сегодня", 1000);
    assert.equal(mock.calls[0].url, "https://api.tavily.com/search");
    assert.equal(mock.calls[0].headers.Authorization, "Bearer tvly-test");
    assert.equal(mock.calls[0].body.query, "курс доллара сегодня");
    assert.equal(mock.calls[0].body.max_results, 3);
    assert.equal(context, "1. ЦБ РФ: Курс доллара 95 рублей");
  } finally {
    mock.restore();
  }
});

test("Serper still works when only its key is set", async () => {
  const { searchWeb } = await import("../api/index.js");
  const mock = mockSearch({
    status: 200,
    body: { answerBox: { answer: "95 рублей" }, organic: [{ title: "Курс", snippet: "Доллар", link: "https://example.ru" }] }
  });
  process.env.SERPER_API_KEY = "serper-test";
  try {
    const context = await searchWeb("курс доллара", 1000);
    assert.equal(mock.calls[0].url, "https://google.serper.dev/search");
    assert.equal(context, "Краткий ответ поисковика: 95 рублей\n1. Курс: Доллар");
  } finally {
    mock.restore();
  }
});

test("a failed search does not break the answer", async () => {
  const { searchWeb } = await import("../api/index.js");
  const mock = mockSearch({ status: 432, body: { detail: { error: "Usage limit exceeded" } } });
  process.env.TAVILY_API_KEY = "tvly-test";
  try {
    assert.equal(await searchWeb("новости сегодня", 1000), "");
  } finally {
    mock.restore();
  }
});

test("no search key means no search request", async () => {
  const { searchWeb } = await import("../api/index.js");
  const mock = mockSearch({ status: 200, body: {} });
  try {
    assert.equal(await searchWeb("погода сегодня", 1000), "");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

function mockGeminiAndRedis(geminiDelayMs, answer) {
  const original = globalThis.fetch;
  const db = new Map();
  const geminiBodies = [];
  globalThis.fetch = (url, { body, signal }) => {
    if (url === "https://redis.test") {
      const [command, key, value, ...rest] = JSON.parse(body);
      let result = "OK";
      if (command === "GET") result = db.get(key) ?? null;
      if (command === "MGET") result = [key, value, ...rest].map(name => db.get(name) ?? null);
      if (command === "SET") db.set(key, value);
      if (command === "DEL") db.delete(key);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ result }) });
    }
    geminiBodies.push(JSON.parse(body));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }] })
      }), geminiDelayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };
  process.env.GEMINI_API_KEY = "test-key";
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "redis-token";
  return {
    db,
    geminiBodies,
    restore() {
      globalThis.fetch = original;
      delete process.env.GEMINI_API_KEY;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
  };
}

async function reply(command, sessionId = "session-1") {
  const handler = (await import("../api/index.js")).default;
  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
  await handler({ method: "POST", body: { session: { session_id: sessionId }, request: { command }, state: { session: {} } } }, res);
  return payload.response;
}

async function say(command, sessionId = "session-1") {
  return (await reply(command, sessionId)).text;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("follow-up phrases are recognised", async () => {
  const { isFollowUp } = await import("../api/index.js");
  for (const phrase of ["ну что", "Ну что?", "что там", "ну", "готово", "дальше", "ну что там"]) {
    assert.equal(isFollowUp(phrase), true, phrase);
  }
  for (const phrase of ["что такое любовь", "почему небо голубое", "какая погода"]) {
    assert.equal(isFollowUp(phrase), false, phrase);
  }
});

test("a fast answer is given right away even when the store is configured", async () => {
  const mock = mockGeminiAndRedis(50, "Быстрый ответ");
  try {
    assert.equal(await say("Почему небо голубое?"), "Быстрый ответ");
    assert.equal(mock.db.has("alice:pending:session-1"), false);
  } finally {
    mock.restore();
  }
});

test("a slow answer is deferred and given on «ну что»", async () => {
  const mock = mockGeminiAndRedis(3800, "Медленный, но полный ответ");
  try {
    const waiting = await reply("Почему небо голубое?");
    assert.match(waiting.text, /ещё думаю/);
    assert.doesNotMatch(waiting.text, /speaker/);
    assert.match(waiting.tts, /<speaker audio="alice-music-drums-3\.opus">/);
    await sleep(700);
    const answer = await reply("ну что");
    assert.equal(answer.text, "Медленный, но полный ответ");
    assert.equal(answer.tts, undefined);
    assert.equal(mock.db.has("alice:pending:session-1"), false);
  } finally {
    mock.restore();
  }
});

test("«ну что» waits for an answer that is still being prepared", async () => {
  const mock = mockGeminiAndRedis(5000, "Ответ после ожидания");
  try {
    assert.match(await say("Расскажи про чёрные дыры"), /ещё думаю/);
    assert.equal(await say("ну что?"), "Ответ после ожидания");
  } finally {
    mock.restore();
  }
});

test("without a store a slow answer still ends with the timeout message", async () => {
  const mock = mockGeminiAndRedis(5000, "поздно");
  delete process.env.KV_REST_API_URL;
  try {
    assert.match(await say("Почему небо голубое?"), /Не успела/);
  } finally {
    mock.restore();
  }
});

async function health(url) {
  const handler = (await import("../api/index.js")).default;
  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
  await handler({ method: "GET", url }, res);
  return payload;
}

test("without the secret word /api reveals nothing and calls nothing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not be called"); };
  process.env.GEMINI_API_KEY = "test-key";
  try {
    assert.deepEqual(await health("/api"), { ok: true });
    assert.deepEqual(await health("/api?check=1"), { ok: true });
    assert.deepEqual(await health("/api?check="), { ok: true });
    process.env.HEALTH_TOKEN = "secret-word";
    assert.deepEqual(await health("/api?check=wrong"), { ok: true });
  } finally {
    globalThis.fetch = original;
    delete process.env.GEMINI_API_KEY;
    delete process.env.HEALTH_TOKEN;
  }
});

test("?check=<HEALTH_TOKEN> shows the configuration and verifies Gemini, search and the store", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
    if (url.endsWith("/models/gemini-3.5-flash-lite")) return reply(200, { name: "models/gemini-3.5-flash-lite" });
    if (url.endsWith("/models/gemini-3.1-flash-lite")) return reply(404, { error: { code: 404 } });
    if (url === "https://api.tavily.com/usage") {
      assert.equal(options.headers.Authorization, "Bearer tvly-test");
      return reply(200, { key: { usage: 12, limit: 1000 } });
    }
    if (url === "https://redis.test") return reply(200, { result: "PONG" });
    throw new Error(`unexpected ${url}`);
  };
  process.env.GEMINI_API_KEY = "test-key";
  process.env.TAVILY_API_KEY = "tvly-test";
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "redis-token";
  process.env.HEALTH_TOKEN = "secret-word";
  try {
    const report = await health("/api?check=secret-word");
    assert.equal(report.ok, true);
    assert.deepEqual(report.config, {
      gemini: "ключ задан",
      geminiModels: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
      search: "tavily",
      weather: "Open-Meteo, город по умолчанию: Новосибирск",
      deferredAnswers: true,
      memory: true
    });
    assert.deepEqual(report.checks, {
      gemini: { ok: true, models: { "gemini-3.5-flash-lite": "ok", "gemini-3.1-flash-lite": "модель не найдена" } },
      search: { provider: "tavily", ok: true, status: "ok", used: 12, limit: 1000 },
      deferredAnswers: { ok: true, status: "ok" }
    });
  } finally {
    globalThis.fetch = original;
    for (const name of ["GEMINI_API_KEY", "TAVILY_API_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN", "HEALTH_TOKEN"]) delete process.env[name];
  }
});

test("the health report marks a rejected Gemini key as not ok", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { details: [{ reason: "API_KEY_INVALID" }] } }) });
  process.env.GEMINI_API_KEY = "AQ.wrong";
  process.env.HEALTH_TOKEN = "secret-word";
  try {
    const report = await health("/api?check=secret-word");
    assert.equal(report.ok, false);
    assert.equal(report.checks.gemini.models["gemini-3.5-flash-lite"], "ключ не принят");
    assert.equal(report.checks.search.ok, false);
    assert.equal(report.checks.deferredAnswers.ok, false);
  } finally {
    globalThis.fetch = original;
    delete process.env.GEMINI_API_KEY;
    delete process.env.HEALTH_TOKEN;
  }
});

function mockSlowTavily(tavilyDelayMs) {
  const original = globalThis.fetch;
  const tavilyBodies = [];
  globalThis.fetch = (url, { body, signal }) => {
    const reply = (payload, delayMs = 0) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => payload }), delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
    if (url === "https://redis.test") return reply({ result: null });
    if (url === "https://api.tavily.com/search") {
      tavilyBodies.push(JSON.parse(body));
      return reply({ answer: "Курс доллара 95 рублей", results: [] }, tavilyDelayMs);
    }
    const usedSearch = body.includes("Курс доллара 95 рублей");
    return reply({ candidates: [{ content: { parts: [{ text: usedSearch ? "С поиском" : "Без поиска" }] } }] }, 50);
  };
  process.env.GEMINI_API_KEY = "test-key";
  process.env.TAVILY_API_KEY = "tvly-test";
  return {
    tavilyBodies,
    restore() {
      globalThis.fetch = original;
      for (const name of ["GEMINI_API_KEY", "TAVILY_API_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[name];
    }
  };
}

test("with the store configured, a slow search is waited for and asked for a short answer", async () => {
  const mock = mockSlowTavily(2500);
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "redis-token";
  try {
    assert.equal(await say("Какой курс доллара сегодня?"), "С поиском");
    assert.equal(mock.tavilyBodies[0].include_answer, true);
  } finally {
    mock.restore();
  }
});

test("without the store, search keeps its short limit so Alice is not kept waiting", async () => {
  const mock = mockSlowTavily(2500);
  try {
    assert.equal(await say("Какой курс доллара сегодня?"), "Без поиска");
    assert.equal(mock.tavilyBodies[0].include_answer, false);
  } finally {
    mock.restore();
  }
});

test("the prompt carries the current date and local time", async () => {
  const { systemPrompt } = await import("../api/index.js");
  const prompt = systemPrompt("Europe/Moscow", new Date("2026-10-24T19:05:00Z"));
  assert.match(prompt, /суббота, 24 октября 2026/);
  assert.match(prompt, /22:05/);
  assert.match(prompt, /без Markdown, списков, ссылок и эмодзи/);
  assert.match(systemPrompt("Not/AZone", new Date("2026-10-24T19:05:00Z")), /Europe\/Moscow/);
});

test("weather questions are recognised", async () => {
  const { isWeatherIntent } = await import("../api/index.js");
  for (const phrase of ["какая погода в москве", "нужен ли завтра зонт", "что на улице", "прогноз на выходные", "будет ли дождь в санкт-петербурге", "сколько градусов в казани"]) {
    assert.equal(isWeatherIntent(phrase), true, phrase);
  }
  assert.equal(isWeatherIntent("почему небо голубое"), false);
});

test("the city is taken from the phrase and put back into its basic form", async () => {
  const { cityCandidates } = await import("../api/index.js");
  assert.ok(cityCandidates("какая погода в москве").includes("москва"));
  assert.ok(cityCandidates("погода в санкт-петербурге завтра").includes("санкт-петербург"));
  assert.ok(cityCandidates("погода в казани").includes("казань"));
  assert.ok(cityCandidates("погода в нижнем новгороде").includes("нижний новгород"));
  assert.deepEqual(cityCandidates("какая погода будет в субботу"), []);
  assert.ok(cityCandidates("погода во вторник в москве").includes("москва"));
  assert.ok(cityCandidates("какая погода в 5 вечера в сочи").includes("сочи"));
  assert.ok(cityCandidates("погода в ростове-на-дону").includes("ростов-на-дону"));
  assert.deepEqual(cityCandidates("погода на завтра"), []);
});

function mockOpenMeteo() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(url);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("https://geocoding-api.open-meteo.com/")) {
      const name = new URL(url).searchParams.get("name");
      if (name === "казань") return reply({ results: [{ name: "Казань", admin1: "Татарстан", country: "Россия", latitude: 55.79, longitude: 49.12, population: 1250000 }] });
      if (name === "москва") return reply({ results: [{ name: "Москва", country: "Россия", latitude: 55.75, longitude: 37.62, population: 12000000 }] });
      if (name === "новосибирск") return reply({ results: [{ name: "Новосибирск", admin1: "Новосибирская область", country: "Россия", latitude: 55.04, longitude: 82.93, population: 1600000 }] });
      // Loose matching of other forms returns a small unrelated village.
      return reply({ results: [{ name: "Казанка", country: "Россия", latitude: 1, longitude: 1, population: 300 }] });
    }
    if (url.startsWith("https://api.open-meteo.com/")) {
      return reply({
        current: { temperature_2m: 4.6, apparent_temperature: 1.2, weather_code: 3, wind_speed_10m: 4.4, relative_humidity_2m: 81 },
        daily: {
          time: ["2026-10-24", "2026-10-25", "2026-10-26"],
          weather_code: [61, 0, 71],
          temperature_2m_max: [6.2, 8, -0.4],
          temperature_2m_min: [1.8, 2.1, -3.6],
          precipitation_sum: [1.2, 0, 2.5],
          precipitation_probability_max: [60, 5, 80]
        }
      });
    }
    const usedWeather = String(options.body).includes("Данные о погоде");
    return reply({ candidates: [{ content: { parts: [{ text: usedWeather ? "По данным о погоде" : "Без данных" }] } }] });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
      for (const name of ["GEMINI_API_KEY", "TAVILY_API_KEY", "WEATHER_CITY"]) delete process.env[name];
    }
  };
}

test("weather is fetched from Open-Meteo for the named city", async () => {
  const { weatherContext } = await import("../api/index.js");
  const mock = mockOpenMeteo();
  try {
    const context = await weatherContext("какая погода в казани", 2000);
    assert.match(context, /для: Казань, Татарстан, Россия/);
    assert.match(context, /Сейчас: \+5 °C, ощущается как \+1 °C, пасмурно, ветер 4 м\/с/);
    assert.match(context, /Сегодня \(суббота, 24 октября\): от \+2 °C до \+6 °C, небольшой дождь/);
    assert.match(context, /Послезавтра \(понедельник, 26 октября\): от -4 °C до 0 °C, небольшой снег/);
  } finally {
    mock.restore();
  }
});

test("without a city in the phrase the default city is used", async () => {
  const { weatherContext } = await import("../api/index.js");
  const mock = mockOpenMeteo();
  try {
    assert.match(await weatherContext("какая погода", 2000), /для: Новосибирск, Новосибирская область, Россия/);
    assert.match(await weatherContext("нужен ли завтра зонт", 2000), /для: Новосибирск/);
    assert.match(await weatherContext("какая погода в москве", 2000), /для: Москва, Россия/);
  } finally {
    mock.restore();
  }
});

test("a weather question goes to Open-Meteo instead of the web search", async () => {
  const mock = mockOpenMeteo();
  process.env.GEMINI_API_KEY = "test-key";
  process.env.TAVILY_API_KEY = "tvly-test";
  try {
    assert.equal(await say("Какая погода сегодня в Москве?"), "По данным о погоде");
    assert.equal(mock.calls.some(url => url.includes("tavily")), false);
  } finally {
    mock.restore();
  }
});

test("search snippets become one clean line each", async () => {
  const { searchWeb } = await import("../api/index.js");
  const mock = mockSearch({
    status: 200,
    body: {
      answer: "Курс\nдоллара 95",
      results: [{ title: "## Курсы | ЦБ", content: "**Доллар**\n\n| 95 | рублей |\n" }, { title: "Второй", content: "текст" }]
    }
  });
  process.env.TAVILY_API_KEY = "tvly-test";
  try {
    assert.equal(
      await searchWeb("курс доллара", 1000),
      "Краткий ответ поисковика: Курс доллара 95\n1. Курсы ЦБ: Доллар 95 рублей\n2. Второй: текст"
    );
  } finally {
    mock.restore();
  }
});

test("the conversation is remembered within a session", async () => {
  const mock = mockGeminiAndRedis(10, "Лев Толстой.");
  try {
    await say("Кто написал «Войну и мир»?", "chat-1");
    await say("А сколько ему было лет?", "chat-1");
    const second = mock.geminiBodies.at(-2).contents;
    assert.deepEqual(second.map(item => item.role), ["user", "model", "user"]);
    assert.equal(second[0].parts[0].text, "Кто написал «Войну и мир»?");
    assert.equal(second[1].parts[0].text, "Лев Толстой.");
    assert.equal(JSON.parse(mock.db.get("alice:history:chat-1")).length, 4);

    await say("Привет", "another-chat");
    assert.equal(mock.geminiBodies.at(-1).contents.length, 1);
  } finally {
    mock.restore();
  }
});

test("a deferred answer joins the conversation history", async () => {
  const mock = mockGeminiAndRedis(3800, "Подробный ответ");
  try {
    await say("Расскажи про чёрные дыры", "chat-2");
    await sleep(700);
    await say("ну что", "chat-2");
    assert.deepEqual(JSON.parse(mock.db.get("alice:history:chat-2")), [
      { role: "user", text: "Расскажи про чёрные дыры" },
      { role: "model", text: "Подробный ответ" }
    ]);
  } finally {
    mock.restore();
  }
});

test("repeat requests are recognised", async () => {
  const { isRepeatRequest } = await import("../api/index.js");
  for (const phrase of ["повтори", "Повтори, пожалуйста", "ещё раз", "что?", "не расслышал", "можешь повторить", "а что ты сказала"]) {
    assert.equal(isRepeatRequest(phrase), true, phrase);
  }
  for (const phrase of ["повтори таблицу умножения", "что такое любовь", "ещё раз про погоду расскажи подробнее"]) {
    assert.equal(isRepeatRequest(phrase), false, phrase);
  }
});

test("«повтори» and the same question again return the last answer without asking Gemini", async () => {
  const mock = mockGeminiAndRedis(10, "Лев Толстой.");
  try {
    assert.equal(await say("Кто написал «Войну и мир»?", "chat-3"), "Лев Толстой.");
    const asked = mock.geminiBodies.length;
    assert.equal(await say("повтори", "chat-3"), "Лев Толстой.");
    assert.equal(await say("кто написал войну и мир", "chat-3"), "Лев Толстой.");
    assert.equal(mock.geminiBodies.length, asked);
    assert.equal(JSON.parse(mock.db.get("alice:history:chat-3")).length, 2);
  } finally {
    mock.restore();
  }
});

test("«повтори» with nothing said yet goes to Gemini as usual", async () => {
  const mock = mockGeminiAndRedis(10, "Мне пока нечего повторить.");
  try {
    assert.equal(await say("повтори", "chat-4"), "Мне пока нечего повторить.");
  } finally {
    mock.restore();
  }
});

test("the built-in secret word opens the health report without HEALTH_TOKEN", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const report = await health("/api?check=check-L4uNVTVVVYhF");
    assert.ok(report.checks);
    assert.equal(report.config.gemini, "ключ задан");
  } finally {
    globalThis.fetch = original;
    delete process.env.GEMINI_API_KEY;
  }
});
