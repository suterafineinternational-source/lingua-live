import { AppError } from "./errors.js";

const CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/translations/client_secrets";
const DEFAULT_MODEL = "gpt-realtime-translate";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

function safeText(value) {
  return String(value ?? "").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

export function buildTranslationClientSecretRequest({ apiKey, sourceLanguage = "it", targetLanguage = "en", sourceType = "microphone", model = DEFAULT_MODEL } = {}) {
  if (!apiKey) throw new AppError(503, "OPENAI_API_KEY_MISSING", "Live interpretation is unavailable until OPENAI_API_KEY is configured.");
  const source = String(sourceLanguage || "it").split("-")[0].toLowerCase();
  const target = String(targetLanguage || "en").split("-")[0].toLowerCase();
  const noiseReduction = sourceType === "display" ? null : { type: "near_field" };
  return {
    url: CLIENT_SECRET_URL,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model,
          audio: {
            input: {
              transcription: { model: DEFAULT_TRANSCRIPTION_MODEL, language: source },
              noise_reduction: noiseReduction,
            },
            output: { language: target },
          },
        },
      }),
    },
    model,
    sourceLanguage: source,
    targetLanguage: target,
  };
}

export async function createTranslationClientSecret(options = {}) {
  const request = buildTranslationClientSecretRequest(options);
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) {
    let detail = "";
    try { detail = await response.text(); } catch {}
    throw new AppError(502, "TRANSLATION_CLIENT_SECRET_FAILED", `Could not create low-latency translation session (${response.status}). ${safeText(detail)}`.trim(), { retriable: response.status >= 500 });
  }
  const data = await response.json();
  if (!data || typeof data.value !== "string" || !data.value) throw new AppError(502, "TRANSLATION_CLIENT_SECRET_INVALID", "OpenAI did not return a usable low-latency translation credential.");
  return {
    clientSecret: data.value,
    expiresAt: data.expires_at ?? null,
    model: request.model,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
  };
}
