// Relay for Yandex Cloud Functions: Alice calls this function directly (inside Yandex, so it is never blocked),
// and it forwards the request to the skill on Vercel, which Yandex's own servers may not be able to reach.
// Runtime: Node.js 22, entry point: index.handler. Setup steps are in README.md.

const SKILL_URL = process.env.SKILL_URL || "https://aliska-aliska.vercel.app/api";
// Alice waits 4.5 s in total; leave room for the hop from Yandex to this function and back.
const TIMEOUT_MS = 4200;

function aliceText(text) {
  return { version: "1.0", response: { text, end_session: false } };
}

module.exports.handler = async function (event) {
  const startedAt = Date.now();
  try {
    const response = await fetch(SKILL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
      console.warn("Skill answered with HTTP", response.status, "in", Date.now() - startedAt, "ms");
      return aliceText(`Сервер навыка ответил ошибкой ${response.status}. Попробуйте позже.`);
    }
    return await response.json();
  } catch (error) {
    console.warn("Skill is unreachable:", error?.name, error?.cause?.code || "", "after", Date.now() - startedAt, "ms");
    return aliceText(error?.name === "TimeoutError"
      ? "Сервер навыка не успел ответить. Спросите ещё раз."
      : "Не могу достучаться до сервера навыка из Яндекс Облака.");
  }
};
