const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Asked in parallel with the main model: whichever answers first wins.
const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3700;
const SERPER_TIMEOUT_MS = 600;
// Tavily is usually slower than Serper, so it gets a bit more of the 4.5 s Alice budget.
const TAVILY_TIMEOUT_MS = 1200;
// With a store configured, a slow answer is finished in the background and given on the next phrase.
const INLINE_WAIT_MS = 3300;
const BACKGROUND_BUDGET_MS = 20000;
const PENDING_TTL_SECONDS = 300;
const DEFER_TEXT = "Секунду, ещё думаю. Скажите «ну что», и я отвечу.";
const STILL_THINKING_TEXT = "Всё ещё думаю. Скажите «ну что» ещё раз через пару секунд.";

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  const signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal;
  try {
    const response = await fetch(url, { ...options, signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function searchProvider() {
  if (cleanKey(process.env.TAVILY_API_KEY)) return "tavily";
  if (cleanKey(process.env.SERPER_API_KEY)) return "serper";
  return "";
}

function formatSearchItems(items, shortAnswer) {
  const lines = items.slice(0, 3).map((item, i) => {
    const title = String(item.title || "").slice(0, 180);
    const snippet = String(item.snippet || "").slice(0, 350);
    const link = String(item.link || "").slice(0, 240);
    return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
  });
  if (shortAnswer) lines.unshift(`Краткий ответ поисковика: ${String(shortAnswer).slice(0, 350)}`);
  return lines.join("\n");
}

async function searchSerper(query, timeoutMs) {
  const { response, data } = await fetchJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "X-API-KEY": cleanKey(process.env.SERPER_API_KEY),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
    },
    Math.min(SERPER_TIMEOUT_MS, timeoutMs)
  );
  if (!response.ok) throw Object.assign(new Error("SEARCH_FAILED"), { status: response.status });

  const items = (Array.isArray(data.organic) ? data.organic : []).map(item => ({
    title: item.title,
    snippet: item.snippet,
    link: item.link
  }));
  return formatSearchItems(items, data.answerBox?.answer || data.answerBox?.snippet);
}

async function searchTavily(query, timeoutMs) {
  const { response, data } = await fetchJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cleanKey(process.env.TAVILY_API_KEY)}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 3, include_answer: false })
    },
    Math.min(TAVILY_TIMEOUT_MS, timeoutMs)
  );
  if (!response.ok) throw Object.assign(new Error("SEARCH_FAILED"), { status: response.status });

  const items = (Array.isArray(data.results) ? data.results : []).map(item => ({
    title: item.title,
    snippet: item.content,
    link: item.url
  }));
  return formatSearchItems(items, data.answer);
}

async function searchWeb(query, timeoutMs) {
  const provider = searchProvider();
  if (!provider || timeoutMs < 150) return "";

  try {
    return provider === "tavily" ? await searchTavily(query, timeoutMs) : await searchSerper(query, timeoutMs);
  } catch (error) {
    console.warn(`Search via ${provider} failed; continuing without search:`, error?.status || error?.message);
    return "";
  }
}

function geminiModels() {
  const main = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const fallback = String(process.env.GEMINI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL).trim();
  return [...new Set([main, fallback].filter(Boolean))];
}

const ERROR_PRIORITY = [
  "MISSING_GEMINI_KEY",
  "GEMINI_KEY_MALFORMED",
  "INVALID_MODEL_NAME",
  "GEMINI_KEY_REJECTED",
  "GEMINI_MODEL_NOT_FOUND",
  "GEMINI_QUOTA",
  "GEMINI_OVERLOADED",
  "TIMEOUT",
  "GEMINI_BLOCKED"
];

function mostUsefulError(errors) {
  for (const name of ERROR_PRIORITY) {
    const found = errors.find(error => error?.message === name);
    if (found) return found;
  }
  return errors[0];
}

function cleanKey(value) {
  // Keys pasted into Vercel often come with quotes, spaces, line breaks or invisible characters.
  return String(value || "")
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "")
    .replace(/^["'«“]+|["'»”]+$/g, "");
}

function geminiHttpError(status, data) {
  const reason = JSON.stringify(data?.error?.details || "");
  if (status === 401 || status === 403 || reason.includes("API_KEY_INVALID")) return new Error("GEMINI_KEY_REJECTED");
  if (status === 429) return new Error("GEMINI_QUOTA");
  if (status === 500 || status === 503) return new Error("GEMINI_OVERLOADED");
  if (status === 404) return new Error("GEMINI_MODEL_NOT_FOUND");
  return Object.assign(new Error("GEMINI_REQUEST_FAILED"), { status });
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = cleanKey(process.env.GEMINI_API_KEY);
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  // Non-Latin characters (e.g. a Cyrillic "А") make fetch fail before the request is even sent.
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("GEMINI_KEY_MALFORMED");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  // Gemini latency varies a lot under load, so the models race and the slower request is cancelled.
  const race = new AbortController();
  try {
    return await Promise.any(geminiModels().map(model =>
      askGeminiModel(model, key, text, history, searchContext, timeoutMs, race.signal)
    ));
  } catch (error) {
    throw mostUsefulError(error?.errors || [error]);
  } finally {
    race.abort();
  }
}

async function askGeminiModel(model, key, text, history, searchContext, timeoutMs, signal) {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    timeoutMs,
    signal
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error(`Gemini ${model} request failed with HTTP`, status, String(data?.error?.message || "").slice(0, 300));
    throw geminiHttpError(status, data);
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn(`Gemini ${model} reached the output token limit.`);
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_MALFORMED":
      return "В ключе GEMINI_API_KEY есть лишние символы, например русские буквы. Скопируйте ключ из Google AI Studio заново и вставьте его в Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "GEMINI_OVERLOADED":
      return "Нейросеть сейчас перегружена. Попробуйте ещё раз через минуту.";
    case "INVALID_MODEL_NAME":
    case "GEMINI_MODEL_NOT_FOUND":
      return "Модель Gemini не найдена. Проверьте переменную GEMINI_MODEL в настройках Vercel или удалите её.";
    case "TIME_BUDGET_EXHAUSTED":
    case "TIMEOUT":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    case "STORE_FAILED":
      return "Не успела подготовить ответ, а отложить его не получилось. Проверьте базу Upstash в настройках Vercel.";
    case "GEMINI_EMPTY_RESPONSE":
      return "Нейросеть вернула пустой ответ. Попробуйте спросить иначе.";
    default:
      return `Не получилось получить ответ от нейросети (${error?.status ? "ошибка " + error.status : "сетевая ошибка"}). Попробуйте ещё раз чуть позже.`;
  }
}

async function answerQuestion(text, history, budgetMs) {
  const startedAt = Date.now();
  const remainingMs = () => budgetMs - (Date.now() - startedAt);

  let searchContext = "";
  if (isSearchIntent(text) && searchProvider()) {
    // Search gets only what is left after reserving time for Gemini; each provider also has its own cap.
    searchContext = await searchWeb(text, Math.max(0, remainingMs() - 2600));
  }
  return askGemini(text, history, searchContext, Math.max(0, remainingMs()));
}

function withAnswer(history, question, answer) {
  return [
    ...history,
    { role: "user", text: question.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
    { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
  ].slice(-MAX_HISTORY_MESSAGES);
}

function logFallback(error) {
  // Raw fetch error messages are not logged: some of them echo the API key.
  const code = /^[A-Z_]+$/.test(error?.message || "")
    ? error.message
    : `NETWORK_ERROR ${error?.cause?.code || error?.name || ""}`;
  console.warn("Alice webhook returned a fallback response:", code, error?.status || "");
}

function isFollowUp(text) {
  return /^(?:(?:ну|и|а|так)\s*)?(?:что там|что|как|чё|че|готово|готов|дальше|давай|какой ответ|ответ|говори|скажи|продолжай)?[\s?!.]*$/i.test(text.trim());
}

// Upstash Redis over its REST API. Vercel's Upstash integration sets KV_REST_API_*,
// a database created on upstash.com directly gives UPSTASH_REDIS_REST_*.
function redisConfig() {
  const url = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = cleanKey(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);
  return url && token ? { url, token } : null;
}

async function redis(command) {
  const { url, token } = redisConfig();
  const { response, data } = await fetchJson(
    url,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command)
    },
    800
  );
  if (!response.ok || data?.error) throw Object.assign(new Error("STORE_FAILED"), { status: response.status });
  return data.result;
}

function pendingStore(sessionId) {
  if (!redisConfig() || !sessionId) return null;
  const key = `alice:pending:${sessionId}`;
  const store = {
    async get() {
      const raw = await redis(["GET", key]);
      return raw ? JSON.parse(raw) : null;
    },
    set(value) {
      return redis(["SET", key, JSON.stringify(value), "EX", PENDING_TTL_SECONDS]);
    },
    clear() {
      return redis(["DEL", key]);
    },
    async waitForResult(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await store.get();
        if (value?.status !== "pending" || Date.now() + 300 > deadline) return value;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  };
  return store;
}

// Same as waitUntil from @vercel/functions, without pulling in its dependency tree:
// keeps the function alive after the response until the promise settles.
function waitUntil(promise) {
  globalThis[Symbol.for("@vercel/request-context")]?.get?.()?.waitUntil?.(promise);
}

function settleWithin(promise, timeoutMs) {
  return Promise.race([
    promise.then(answer => ({ answer }), error => ({ error })),
    new Promise(resolve => setTimeout(() => resolve(null), Math.max(0, timeoutMs)))
  ]);
}

async function replyToFollowUp(store, pending, history, inlineLeft) {
  const result = pending.status === "pending" ? await store.waitForResult(inlineLeft()) : pending;
  if (result?.status === "done") {
    await store.clear();
    return aliceResponse(result.answer, false, withAnswer(history, result.question, result.answer));
  }
  if (result?.status === "error") {
    await store.clear();
    const error = Object.assign(new Error(result.code), { status: result.httpStatus });
    logFallback(error);
    return aliceResponse(errorForUser(error), false, history);
  }
  return aliceResponse(STILL_THINKING_TEXT, false, history);
}

async function replyWithStore(store, text, history, inlineLeft) {
  const pending = await store.get().catch(() => null);
  if (pending && isFollowUp(text)) return replyToFollowUp(store, pending, history, inlineLeft);

  const work = answerQuestion(text, history, BACKGROUND_BUDGET_MS);
  const quick = await settleWithin(work, inlineLeft());
  if (quick?.error) throw quick.error;
  if (quick) {
    if (pending) await store.clear().catch(() => {});
    return aliceResponse(quick.answer, false, withAnswer(history, text, quick.answer));
  }

  // Too slow for Alice's timeout: keep working after the response and give the answer on the next phrase.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.set({ status: "pending", id, question: text });
  // A newer question may have replaced this one meanwhile; its slot must not be overwritten.
  const saveIfCurrent = async value => {
    if ((await store.get())?.id === id) await store.set({ ...value, id, question: text });
  };
  waitUntil(work.then(
    answer => saveIfCurrent({ status: "done", answer }),
    error => {
      logFallback(error);
      return saveIfCurrent({ status: "error", code: error?.message, httpStatus: error?.status });
    }
  ).catch(error => console.warn("Could not save the background answer:", error?.message)));
  return aliceResponse(DEFER_TEXT, false, history);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      deferredAnswers: Boolean(redisConfig()),
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    const store = pendingStore(body?.session?.session_id);
    if (store) {
      return res.status(200).json(await replyWithStore(store, text, oldHistory, () => INLINE_WAIT_MS - elapsedMs()));
    }

    const answer = await answerQuestion(text, oldHistory, TOTAL_RESPONSE_BUDGET_MS - elapsedMs());
    return res.status(200).json(aliceResponse(answer, false, withAnswer(oldHistory, text, answer)));
  } catch (error) {
    logFallback(error);
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, askGemini, cleanKey, errorForUser, fitAliceText, isFollowUp, isSearchIntent, safeHistory, searchWeb };
