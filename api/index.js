const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Asked in parallel with the main model: whichever answers first wins.
const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3700;
// Search time when the answer must fit into Alice's 4.5 s: Tavily is usually slower than Serper.
const SEARCH_TIMEOUT_MS = { serper: 600, tavily: 1200 };
// When a slow answer can be deferred to "ну что", search may take longer and return fuller results.
const PATIENT_SEARCH_TIMEOUT_MS = 5000;
// With a store configured, a slow answer is finished in the background and given on the next phrase.
const INLINE_WAIT_MS = 3300;
const BACKGROUND_BUDGET_MS = 20000;
const PENDING_TTL_SECONDS = 300;
const DEFER_TEXT = "Секунду, ещё думаю. Скажите «ну что», и я отвечу.";
const STILL_THINKING_TEXT = "Всё ещё думаю. Скажите «ну что» ещё раз через пару секунд.";

const DEFAULT_TIMEZONE = "Europe/Moscow";

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Ты работаешь на нейросети Gemini от Google, а не на модели Яндекса; если спрашивают, кто ты или какая ты модель, так и отвечай.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Ответ будет произнесён вслух: не называй ссылки и адреса сайтов, не используй эмодзи.",
  "Если переданы данные о погоде или результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

// Gemini does not know today's date, so "сегодня", "завтра" and "сколько дней до…" need it in the prompt.
function systemPrompt(timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const timeZone = validTimezone(timezone);
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(now);
  return `${SYSTEM_PROMPT} Сегодня ${date}, местное время ${time} (${timeZone}).`;
}

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
    // Links are left out: they cost tokens and the model might read them aloud.
    return `${i + 1}. ${title}: ${snippet}`.trim();
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
    timeoutMs
  );
  if (!response.ok) throw Object.assign(new Error("SEARCH_FAILED"), { status: response.status });

  const items = (Array.isArray(data.organic) ? data.organic : []).map(item => ({
    title: item.title,
    snippet: item.snippet
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
      // Tavily's short answer often holds the actual numbers (weather, rates), but takes extra time.
      body: JSON.stringify({ query, search_depth: "basic", max_results: 3, include_answer: timeoutMs >= 3000 })
    },
    timeoutMs
  );
  if (!response.ok) throw Object.assign(new Error("SEARCH_FAILED"), { status: response.status });

  const items = (Array.isArray(data.results) ? data.results : []).map(item => ({
    title: item.title,
    snippet: item.content
  }));
  return formatSearchItems(items, data.answer);
}

async function searchWeb(query, timeoutMs) {
  const provider = searchProvider();
  if (!provider || timeoutMs < 150) return "";

  const startedAt = Date.now();
  try {
    const context = provider === "tavily" ? await searchTavily(query, timeoutMs) : await searchSerper(query, timeoutMs);
    console.log(`Search via ${provider}: ${context ? context.split("\n").length : 0} results in ${Date.now() - startedAt} ms`);
    return context;
  } catch (error) {
    console.warn(`Search via ${provider} failed; continuing without search:`, error?.status || error?.message);
    return "";
  }
}

// Weather comes straight from Open-Meteo: free, no key, and much faster and more precise than a web search.
const DEFAULT_WEATHER_CITY = "Новосибирск";
const WEATHER_TIMEOUT_MS = 1500;
const PATIENT_WEATHER_TIMEOUT_MS = 4000;
const WEATHER_CODES = {
  0: "ясно", 1: "в основном ясно", 2: "переменная облачность", 3: "пасмурно",
  45: "туман", 48: "туман с изморозью",
  51: "слабая морось", 53: "морось", 55: "сильная морось", 56: "ледяная морось", 57: "сильная ледяная морось",
  61: "небольшой дождь", 63: "дождь", 65: "сильный дождь", 66: "ледяной дождь", 67: "сильный ледяной дождь",
  71: "небольшой снег", 73: "снег", 75: "сильный снег", 77: "снежная крупа",
  80: "небольшой ливень", 81: "ливень", 82: "сильный ливень", 85: "снегопад", 86: "сильный снегопад",
  95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом"
};
// Words after "в" that are about time, not a place: "в субботу", "в выходные", "в 5 вечера".
const NOT_A_PLACE = /^(понедельник|вторник|сред[уа]|четверг|пятниц[уа]|суббот[уа]|воскресень[ея]|выходн|будни|течени|час|минут|секунд|этот|этом|эту|эти|ближайш|следующ|прошл|начал|конц|середин|утром|обед|полдень|полночь|\d)/;
const geocodeCache = new Map();

function isWeatherIntent(text) {
  return /погод|прогноз|осадк|зонт|на улице|дожд|снегопад|гроз[аыу]|градус|\bweather\b/i.test(text);
}

// Alice sends the place in the prepositional case ("в москве"), the geocoder expects "москва".
function wordForms(word) {
  const forms = [word];
  if (/е$/.test(word)) forms.push(word.slice(0, -1) + "а", word.slice(0, -1));
  if (/и$/.test(word)) forms.push(word.slice(0, -1) + "ь", word.slice(0, -1) + "а", word.slice(0, -1) + "я");
  if (/[ео]м$/.test(word)) forms.push(word.slice(0, -2) + "ий", word.slice(0, -2) + "ый");
  if (/ой$/.test(word)) forms.push(word.slice(0, -2) + "ая");
  // "ростове-на-дону": the ending is on the first part.
  const [head, ...rest] = word.split("-");
  if (rest.length > 1) forms.push(...wordForms(head).slice(1).map(form => [form, ...rest].join("-")));
  return forms;
}

const TIME_WORD = /^(сегодня|завтра|послезавтра|сейчас|вечером|утром|днём|днем|ночью)$/;

function cityCandidates(text) {
  const words = text.toLowerCase().split(/[^\p{L}\d-]+/u).filter(Boolean);
  const at = words.findIndex((word, i) => (word === "в" || word === "во") && words[i + 1] && !NOT_A_PLACE.test(words[i + 1]));
  if (at < 0) return [];
  const [first, second] = [words[at + 1], words[at + 2]];
  const candidates = [];
  if (second && !NOT_A_PLACE.test(second) && !TIME_WORD.test(second) && second !== "в" && second !== "во") {
    for (const a of wordForms(first).slice(0, 3)) {
      for (const b of wordForms(second).slice(0, 3)) candidates.push(`${a} ${b}`);
    }
  }
  candidates.push(...wordForms(first));
  return [...new Set(candidates)].slice(0, 10);
}

async function geocode(candidates, timeoutMs) {
  const cacheKey = candidates.join("|");
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  const lookups = await Promise.all(candidates.map(async name => {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=ru&format=json`;
    const { response, data } = await fetchJson(url, {}, timeoutMs).catch(() => ({ response: { ok: false } }));
    return response.ok && Array.isArray(data.results) ? data.results.map(place => ({ ...place, query: name })) : [];
  }));
  const places = lookups.flat();
  // The geocoder matches loosely, so a place whose name equals one of the word forms wins, then the biggest one.
  const exact = places.filter(place => candidates.includes(String(place.name).toLowerCase()));
  const best = (exact.length ? exact : places).sort((a, b) => (b.population || 0) - (a.population || 0))[0] || null;
  if (best) geocodeCache.set(cacheKey, best);
  return best;
}

function signedDegrees(value) {
  const rounded = Math.round(Number(value));
  return `${rounded > 0 ? "+" : ""}${rounded} °C`;
}

function weatherSummary(place, data) {
  const current = data.current || {};
  const daily = data.daily || {};
  const label = ["Сегодня", "Завтра", "Послезавтра"];
  const days = (daily.time || []).slice(0, 3).map((day, i) => {
    const date = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
      .format(new Date(`${day}T12:00:00Z`));
    return `${label[i]} (${date}): от ${signedDegrees(daily.temperature_2m_min[i])} до ${signedDegrees(daily.temperature_2m_max[i])}, ` +
      `${WEATHER_CODES[daily.weather_code[i]] || "без уточнения"}, осадки ${daily.precipitation_sum[i]} мм, ` +
      `вероятность осадков ${daily.precipitation_probability_max[i] ?? "неизвестна"}%.`;
  });
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  return [
    `Данные о погоде (Open-Meteo) для: ${where}.`,
    `Сейчас: ${signedDegrees(current.temperature_2m)}, ощущается как ${signedDegrees(current.apparent_temperature)}, ` +
      `${WEATHER_CODES[current.weather_code] || "без уточнения"}, ветер ${Math.round(current.wind_speed_10m)} м/с, влажность ${current.relative_humidity_2m}%.`,
    ...days
  ].join("\n");
}

async function weatherContext(text, timeoutMs) {
  const startedAt = Date.now();
  const remainingMs = () => timeoutMs - (Date.now() - startedAt);
  try {
    const candidates = cityCandidates(text);
    const defaultCity = String(process.env.WEATHER_CITY || DEFAULT_WEATHER_CITY).trim().toLowerCase();
    const place = await geocode(candidates.length ? candidates : [defaultCity], Math.min(1000, remainingMs()));
    if (!place) {
      console.warn("Weather: place not found for", candidates.join(", ") || defaultCity);
      return "";
    }

    const params = new URLSearchParams({
      latitude: place.latitude,
      longitude: place.longitude,
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "3",
      wind_speed_unit: "ms"
    });
    const { response, data } = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, {}, Math.max(100, remainingMs()));
    if (!response.ok) throw Object.assign(new Error("WEATHER_FAILED"), { status: response.status });
    console.log(`Weather for ${place.name} in ${Date.now() - startedAt} ms`);
    return weatherSummary(place, data);
  } catch (error) {
    console.warn("Weather request failed; falling back to search:", error?.status || error?.message);
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

async function askGemini(text, history, context, timeoutMs, timezone = DEFAULT_TIMEZONE) {
  const key = cleanKey(process.env.GEMINI_API_KEY);
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  // Non-Latin characters (e.g. a Cyrillic "А") make fetch fail before the request is even sent.
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("GEMINI_KEY_MALFORMED");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  // Gemini latency varies a lot under load, so the models race and the slower request is cancelled.
  const race = new AbortController();
  const instruction = systemPrompt(timezone);
  try {
    return await Promise.any(geminiModels().map(model =>
      askGeminiModel(model, key, text, history, context, instruction, timeoutMs, race.signal)
    ));
  } catch (error) {
    throw mostUsefulError(error?.errors || [error]);
  } finally {
    race.abort();
  }
}

async function askGeminiModel(model, key, text, history, context, instruction, timeoutMs, signal) {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = context ? `${text}\n\n${context}` : text;
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
        systemInstruction: { parts: [{ text: instruction }] },
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

async function answerQuestion(text, history, budgetMs, timezone = DEFAULT_TIMEZONE) {
  const startedAt = Date.now();
  const remainingMs = () => budgetMs - (Date.now() - startedAt);
  // Lookups get only what is left after reserving time for Gemini, and no more than their cap.
  const patient = budgetMs > TOTAL_RESPONSE_BUDGET_MS;

  let context = "";
  if (isWeatherIntent(text)) {
    const cap = patient ? PATIENT_WEATHER_TIMEOUT_MS : WEATHER_TIMEOUT_MS;
    context = await weatherContext(text, Math.min(cap, Math.max(0, remainingMs() - 2400)));
  }

  const provider = searchProvider();
  if (!context && isSearchIntent(text) && provider) {
    const cap = patient ? PATIENT_SEARCH_TIMEOUT_MS : SEARCH_TIMEOUT_MS[provider];
    const results = await searchWeb(text, Math.min(cap, Math.max(0, remainingMs() - 2600)));
    if (results) context = `Результаты поиска в интернете:\n${results}\nИспользуй их только там, где они относятся к вопросу.`;
  }
  return askGemini(text, history, context, Math.max(0, remainingMs()), timezone);
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

async function replyWithStore(store, text, history, inlineLeft, timezone) {
  const pending = await store.get().catch(() => null);
  if (pending && isFollowUp(text)) return replyToFollowUp(store, pending, history, inlineLeft);

  const work = answerQuestion(text, history, BACKGROUND_BUDGET_MS, timezone);
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

// Health checks use endpoints that do not spend Gemini or search quota.
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_TEXT = {
  GEMINI_KEY_REJECTED: "ключ не принят",
  GEMINI_MODEL_NOT_FOUND: "модель не найдена",
  GEMINI_QUOTA: "лимит исчерпан",
  GEMINI_OVERLOADED: "сервис перегружен"
};

async function probe(url, headers, okResult, body) {
  try {
    const { response, data } = await fetchJson(
      url,
      body ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers },
      HEALTH_TIMEOUT_MS
    );
    if (response.ok && !data?.error) return { ok: true, status: "ok", ...okResult(data) };
    const status = Number(response.status);
    if (status === 401 || status === 403) return { ok: false, status: "ключ не принят" };
    if (status === 429 || status === 432 || status === 433) return { ok: false, status: "лимит исчерпан" };
    return { ok: false, status: `ошибка HTTP ${status}`, httpStatus: status, data };
  } catch (error) {
    return { ok: false, status: error?.message === "TIMEOUT" ? "нет ответа" : "сетевая ошибка" };
  }
}

async function checkGemini() {
  const key = cleanKey(process.env.GEMINI_API_KEY);
  if (!key) return { ok: false, status: "ключ GEMINI_API_KEY не задан" };
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return { ok: false, status: "в ключе лишние символы, например русские буквы" };

  const models = {};
  await Promise.all(geminiModels().map(async model => {
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      models[model] = "неправильное имя модели";
      return;
    }
    const result = await probe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}`,
      { "x-goog-api-key": key },
      () => ({})
    );
    models[model] = result.httpStatus
      ? HEALTH_TEXT[geminiHttpError(result.httpStatus, result.data).message] || result.status
      : result.status;
  }));
  // The models race, so one working model is enough to answer.
  return { ok: Object.values(models).includes("ok"), models };
}

async function checkSearch() {
  const provider = searchProvider();
  if (!provider) return { ok: false, status: "выключен: не задан TAVILY_API_KEY или SERPER_API_KEY" };

  if (provider === "tavily") {
    const result = await probe(
      "https://api.tavily.com/usage",
      { "Authorization": `Bearer ${cleanKey(process.env.TAVILY_API_KEY)}` },
      data => ({
        used: data?.key?.usage ?? data?.account?.plan_usage,
        limit: data?.key?.limit ?? data?.account?.plan_limit
      })
    );
    return { provider, ...stripProbeDetails(result) };
  }

  const result = await probe(
    "https://google.serper.dev/account",
    { "X-API-KEY": cleanKey(process.env.SERPER_API_KEY) },
    data => (data?.balance !== undefined ? { balance: data.balance } : {})
  );
  // Serper's account endpoint is not documented, so anything but a clear answer is "unknown", not a failure.
  if (!result.ok && result.httpStatus) return { provider, ok: null, status: "ключ задан, проверить не удалось" };
  return { provider, ...stripProbeDetails(result) };
}

async function checkStore() {
  const config = redisConfig();
  if (!config) return { ok: false, status: "не подключена: медленные ответы не откладываются" };
  const result = await probe(config.url, { "Authorization": `Bearer ${config.token}` }, () => ({}), ["PING"]);
  return stripProbeDetails(result);
}

function stripProbeDetails({ httpStatus, data, ...rest }) {
  return rest;
}

function healthConfig() {
  return {
    gemini: cleanKey(process.env.GEMINI_API_KEY) ? "ключ задан" : "ключ не задан",
    geminiModels: geminiModels(),
    search: searchProvider() || "выключен",
    weather: `Open-Meteo, город по умолчанию: ${String(process.env.WEATHER_CITY || DEFAULT_WEATHER_CITY).trim()}`,
    deferredAnswers: Boolean(redisConfig())
  };
}

async function healthReport(deep) {
  const report = {
    ok: true,
    service: "alice-gemini-serper",
    message: "Webhook is ready. Yandex Dialogs should send POST requests to /api.",
    config: healthConfig()
  };
  if (!deep) return { ...report, hint: "Откройте /api?check=1, чтобы проверить ключи и подключения." };

  const [gemini, search, deferredAnswers] = await Promise.all([checkGemini(), checkSearch(), checkStore()]);
  // Search and the store are optional: only Gemini decides whether the skill can answer at all.
  return { ...report, ok: gemini.ok, checks: { gemini, search, deferredAnswers } };
}

function wantsDeepCheck(req) {
  const value = req.query?.check ?? new URL(req.url || "/", "http://localhost").searchParams.get("check");
  return Boolean(value) && value !== "0";
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json(await healthReport(wantsDeepCheck(req)));
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
  const timezone = validTimezone(body?.meta?.timezone || DEFAULT_TIMEZONE);

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
      return res.status(200).json(await replyWithStore(store, text, oldHistory, () => INLINE_WAIT_MS - elapsedMs(), timezone));
    }

    const answer = await answerQuestion(text, oldHistory, TOTAL_RESPONSE_BUDGET_MS - elapsedMs(), timezone);
    return res.status(200).json(aliceResponse(answer, false, withAnswer(oldHistory, text, answer)));
  } catch (error) {
    logFallback(error);
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export {
  aliceResponse,
  askGemini,
  cityCandidates,
  cleanKey,
  errorForUser,
  fitAliceText,
  isFollowUp,
  isSearchIntent,
  isWeatherIntent,
  safeHistory,
  searchWeb,
  systemPrompt,
  weatherContext
};
