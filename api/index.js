const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Asked in parallel with the main model: whichever answers first wins.
const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4000;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 3400;

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

async function searchWeb(query, timeoutMs) {
  const key = cleanKey(process.env.SERPER_API_KEY);
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
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
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs),
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
    case "GEMINI_EMPTY_RESPONSE":
      return "Нейросеть вернула пустой ответ. Попробуйте спросить иначе.";
    default:
      return `Не получилось получить ответ от нейросети (${error?.status ? "ошибка " + error.status : "сетевая ошибка"}). Попробуйте ещё раз чуть позже.`;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
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
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 300))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    // Raw fetch error messages are not logged: some of them echo the API key.
    const code = /^[A-Z_]+$/.test(error?.message || "")
      ? error.message
      : `NETWORK_ERROR ${error?.cause?.code || error?.name || ""}`;
    console.warn("Alice webhook returned a fallback response:", code, error?.status || "");
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, askGemini, cleanKey, errorForUser, fitAliceText, isSearchIntent, safeHistory };
