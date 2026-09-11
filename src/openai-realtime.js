import WebSocket from "ws";
import { AppError } from "./errors.js";

const OPEN = WebSocket.OPEN;
const MAX_QUEUED_AUDIO_CHUNKS = 150;
const DEFAULT_TRANSLATION_MODEL = "gpt-realtime-translate";
const DEFAULT_PROMPTED_MODEL = "gpt-realtime-2.1";

function languageName(code) {
  const normalized = String(code || "").toLowerCase();
  return {
    it: "Italian",
    en: "English",
    "en-us": "English",
    "en-gb": "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    pt: "Portuguese",
    ja: "Japanese",
    ru: "Russian",
    zh: "Chinese",
    ko: "Korean",
    hi: "Hindi",
    id: "Indonesian",
    vi: "Vietnamese",
  }[normalized] || normalized;
}

function translationInstructions(glossary, sourceLanguage = "it", targetLanguage = "en") {
  const target = languageName(targetLanguage);
  const terms = glossary.length
    ? `\nUse these glossary entries exactly when relevant:\n${glossary.map((entry) => `- ${entry}`).join("\n")}`
    : "";
  return [
    "You are a professional live interpreter.",
    `Translate every ${languageName(sourceLanguage)} utterance into natural ${target}.`,
    "Preserve meaning, tone, names, numbers and terminology.",
    `Respond only with the ${target} translation. Do not answer the speaker or add commentary.`,
    "Keep pace with the speaker and use fluent phrasing suitable for live captions.",
    terms,
  ].join(" ");
}

function promptedSessionUpdate(model, glossary, sourceLanguage = "it", targetLanguage = "en") {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      instructions: translationInstructions(glossary, sourceLanguage, targetLanguage),
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          noise_reduction: { type: "far_field" },
          transcription: { model: "gpt-realtime-whisper", language: sourceLanguage.split("-")[0] },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: false,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: "marin",
        },
      },
    },
  };
}

function translationSessionUpdate(targetLanguage = "en") {
  return {
    type: "session.update",
    session: {
      audio: {
        input: {
          transcription: { model: "gpt-realtime-whisper" },
          noise_reduction: { type: "near_field" },
        },
        output: { language: targetLanguage.split("-")[0] },
      },
    },
  };
}

function safeUpstreamMessage(message) {
  if (!message) return "The interpretation service reported an error.";
  return String(message).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}

function validateAudio(audio) {
  if (
    typeof audio !== "string" ||
    audio.length === 0 ||
    audio.length > 512_000 ||
    audio.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)
  ) {
    throw new AppError(400, "INVALID_AUDIO", "Audio chunks must be non-empty base64 strings under 512 KB.");
  }
}

class BaseRealtimeSession {
  constructor({ apiKey, model, glossary = [], sourceLanguage = "it", targetLanguage = "en", onEvent, onStatus, logger = console }) {
    if (!apiKey) {
      throw new AppError(
        503,
        "OPENAI_API_KEY_MISSING",
        "Live interpretation is unavailable until OPENAI_API_KEY is configured.",
      );
    }
    this.apiKey = apiKey;
    this.model = model;
    this.glossary = glossary;
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.logger = logger;
    this.socket = null;
    this.shouldRun = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.initialTimer = null;
    this.audioQueue = [];
    this.initialSettled = false;
  }

  start() {
    if (this.shouldRun) return Promise.resolve();
    this.shouldRun = true;
    return new Promise((resolve, reject) => {
      this.initialResolve = resolve;
      this.initialReject = reject;
      this.initialTimer = setTimeout(() => {
        if (this.initialSettled) return;
        this.initialSettled = true;
        this.shouldRun = false;
        this.socket?.terminate();
        reject(
          new AppError(
            504,
            "INTERPRETATION_CONNECTION_TIMEOUT",
            "The interpretation service did not connect in time.",
            { retriable: true },
          ),
        );
      }, 10_000);
      this.initialTimer.unref?.();
      this.connect();
    });
  }

  connect() {
    if (!this.shouldRun) return;
    const socket = new WebSocket(this.connectionUrl(), { headers: this.connectionHeaders() });
    this.socket = socket;

    socket.on("open", () => {
      if (socket !== this.socket || !this.shouldRun) return socket.close();
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify(this.sessionUpdateEvent()));
      for (const audio of this.audioQueue.splice(0)) this.sendAudio(audio);
      this.onStatus?.({ state: "connected", message: this.connectedMessage(), ...this.capabilities() });
      if (!this.initialSettled) {
        this.initialSettled = true;
        clearTimeout(this.initialTimer);
        this.initialResolve?.();
      }
    });

    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => {
      this.logger.error("OpenAI Realtime socket error:", safeUpstreamMessage(error.message));
    });
    socket.on("close", (code) => {
      if (socket !== this.socket || !this.shouldRun) return;
      this.socket = null;
      this.scheduleReconnect(code);
    });
  }

  connectionHeaders() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  appendAudio(audio) {
    validateAudio(audio);
    if (this.socket?.readyState === OPEN) return this.sendAudio(audio);
    this.audioQueue.push(audio);
    if (this.audioQueue.length > MAX_QUEUED_AUDIO_CHUNKS) this.audioQueue.shift();
  }

  scheduleReconnect(closeCode) {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(500 * 2 ** (this.reconnectAttempt - 1), 8000);
    this.onStatus?.({
      state: "reconnecting",
      message: "Interpretation service disconnected; reconnecting.",
      attempt: this.reconnectAttempt,
      retryInMs: delayMs,
      ...this.capabilities(),
    });
    if (!this.initialSettled && closeCode === 1008) {
      this.initialSettled = true;
      this.shouldRun = false;
      clearTimeout(this.initialTimer);
      this.initialReject?.(
        new AppError(502, "INTERPRETATION_CONNECTION_FAILED", "The interpretation service rejected the connection."),
      );
      return;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    this.reconnectTimer.unref?.();
  }

  emitServiceError(event) {
    const message = safeUpstreamMessage(event.error?.message);
    this.logger.error("OpenAI Realtime API error:", message);
    this.onEvent?.({
      type: "service.error",
      error: {
        code: "INTERPRETATION_SERVICE_ERROR",
        message: "The interpretation service reported an error.",
        retriable: event.error?.type === "server_error",
      },
    });
  }

  close() {
    this.shouldRun = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.initialTimer);
    this.reconnectTimer = null;
    this.audioQueue = [];
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Room ended");
    if (!this.initialSettled) {
      this.initialSettled = true;
      this.initialReject?.(
        new AppError(503, "INTERPRETATION_STOPPED", "The interpretation connection was stopped.", { retriable: true }),
      );
    }
  }
}

export class OpenAITranslationSession extends BaseRealtimeSession {
  constructor(options) {
    super({ ...options, model: options.model || DEFAULT_TRANSLATION_MODEL });
  }

  capabilities() {
    return {
      engineMode: "translate",
      engineModel: this.model,
      purposeBuiltTranslation: true,
      continuous: true,
      autoDetectSourceLanguage: true,
      glossaryPromptSupported: false,
      voiceSelectionSupported: false,
    };
  }

  connectedMessage() {
    return this.glossary.length
      ? "Dedicated Realtime Translation connected. Custom glossary prompting is not supported in this mode; stored glossary terms are not injected into the model."
      : "Dedicated Realtime Translation connected.";
  }

  connectionUrl() {
    return `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(this.model)}`;
  }

  sessionUpdateEvent() {
    return translationSessionUpdate(this.targetLanguage);
  }

  sendAudio(audio) {
    this.socket?.send(JSON.stringify({ type: "session.input_audio_buffer.append", audio }));
  }

  updateGlossary(glossary) {
    this.glossary = glossary;
    this.onStatus?.({
      state: "capability",
      message: glossary.length
        ? "Dedicated Realtime Translation does not support custom glossary prompts; glossary terms are stored but not injected into this model."
        : "Dedicated Realtime Translation mode active.",
      ...this.capabilities(),
    });
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      this.logger.error("OpenAI Realtime Translation returned a non-JSON event.");
      return;
    }

    switch (event.type) {
      case "session.input_transcript.delta":
        this.onEvent?.({ type: "source_transcript.delta", itemId: event.item_id, delta: event.delta || "" });
        break;
      case "session.input_transcript.done":
      case "conversation.item.input_audio_transcription.completed":
        this.onEvent?.({
          type: "source_transcript.done",
          itemId: event.item_id,
          transcript: event.transcript ?? event.text ?? "",
        });
        break;
      case "session.output_transcript.delta":
        this.onEvent?.({
          type: "transcript.delta",
          responseId: event.response_id ?? event.session_id,
          itemId: event.item_id,
          delta: event.delta || "",
        });
        break;
      case "session.output_transcript.done":
        this.onEvent?.({
          type: "transcript.done",
          responseId: event.response_id ?? event.session_id,
          itemId: event.item_id,
          transcript: event.transcript ?? event.text ?? "",
        });
        break;
      case "session.output_audio.delta":
        this.onEvent?.({
          type: "audio.delta",
          responseId: event.response_id ?? event.session_id,
          itemId: event.item_id,
          audio: event.delta,
          format: "pcm16",
          sampleRate: 24000,
        });
        break;
      case "session.output_audio.done":
        this.onEvent?.({ type: "audio.done", responseId: event.response_id ?? event.session_id, itemId: event.item_id });
        break;
      case "error":
        this.emitServiceError(event);
        break;
      default:
        break;
    }
  }

  close() {
    const socket = this.socket;
    if (socket?.readyState === OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {}
    }
    super.close();
  }
}

export class OpenAIPromptedRealtimeSession extends BaseRealtimeSession {
  constructor(options) {
    super({ ...options, model: options.model || DEFAULT_PROMPTED_MODEL });
  }

  capabilities() {
    return {
      engineMode: "prompted",
      engineModel: this.model,
      purposeBuiltTranslation: false,
      continuous: false,
      autoDetectSourceLanguage: false,
      glossaryPromptSupported: true,
      voiceSelectionSupported: true,
    };
  }

  connectedMessage() {
    return "Prompted Realtime compatibility mode connected. Custom glossary instructions are active.";
  }

  connectionUrl() {
    return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
  }

  connectionHeaders() {
    return { ...super.connectionHeaders(), "OpenAI-Beta": "realtime=v1" };
  }

  sessionUpdateEvent() {
    return promptedSessionUpdate(this.model, this.glossary, this.sourceLanguage, this.targetLanguage);
  }

  sendAudio(audio) {
    this.socket?.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
  }

  updateGlossary(glossary) {
    this.glossary = glossary;
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(this.sessionUpdateEvent()));
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      this.logger.error("OpenAI Realtime returned a non-JSON event.");
      return;
    }

    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta":
        this.onEvent?.({ type: "source_transcript.delta", itemId: event.item_id, delta: event.delta || "" });
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.onEvent?.({ type: "source_transcript.done", itemId: event.item_id, transcript: event.transcript || "" });
        break;
      case "response.output_audio_transcript.delta":
        this.onEvent?.({ type: "transcript.delta", responseId: event.response_id, itemId: event.item_id, delta: event.delta });
        break;
      case "response.output_audio_transcript.done":
        this.onEvent?.({ type: "transcript.done", responseId: event.response_id, itemId: event.item_id, transcript: event.transcript });
        break;
      case "response.output_audio.delta":
        this.onEvent?.({
          type: "audio.delta",
          responseId: event.response_id,
          itemId: event.item_id,
          audio: event.delta,
          format: "pcm16",
          sampleRate: 24000,
        });
        break;
      case "response.output_audio.done":
        this.onEvent?.({ type: "audio.done", responseId: event.response_id, itemId: event.item_id });
        break;
      case "input_audio_buffer.speech_started":
        this.onEvent?.({ type: "speaker.status", speaking: true });
        break;
      case "input_audio_buffer.speech_stopped":
        this.onEvent?.({ type: "speaker.status", speaking: false });
        break;
      case "error":
        this.emitServiceError(event);
        break;
      default:
        break;
    }
  }
}

function normalizeMode(value) {
  const mode = String(value || "translate").toLowerCase();
  if (!new Set(["translate", "prompted"]).has(mode)) {
    throw new AppError(500, "INVALID_TRANSLATION_MODE", "OPENAI_TRANSLATION_MODE must be translate or prompted.");
  }
  return mode;
}

function configuredTranslationModel(config = {}) {
  const candidate = config.translationModel ?? process.env.OPENAI_REALTIME_MODEL;
  if (!candidate || candidate === "gpt-realtime" || !String(candidate).includes("translate")) return DEFAULT_TRANSLATION_MODEL;
  return String(candidate);
}

export function translationEngineCapabilities(config = {}) {
  const mode = normalizeMode(config.mode ?? process.env.OPENAI_TRANSLATION_MODE ?? "translate");
  if (mode === "prompted") {
    return {
      mode,
      model: config.promptedModel ?? process.env.OPENAI_PROMPTED_REALTIME_MODEL ?? DEFAULT_PROMPTED_MODEL,
      purposeBuiltTranslation: false,
      continuous: false,
      autoDetectSourceLanguage: false,
      glossaryPromptSupported: true,
      voiceSelectionSupported: true,
    };
  }
  return {
    mode,
    model: configuredTranslationModel(config),
    purposeBuiltTranslation: true,
    continuous: true,
    autoDetectSourceLanguage: true,
    glossaryPromptSupported: false,
    voiceSelectionSupported: false,
  };
}

export function createOpenAIRealtimeFactory(config = {}) {
  const capabilities = translationEngineCapabilities(config);
  const factory = ({ glossary, sourceLanguage, targetLanguage, onEvent, onStatus }) => {
    const common = {
      apiKey: config.apiKey,
      glossary,
      sourceLanguage,
      targetLanguage,
      onEvent,
      onStatus,
      logger: config.logger,
    };
    if (capabilities.mode === "prompted") {
      return new OpenAIPromptedRealtimeSession({ ...common, model: capabilities.model });
    }
    return new OpenAITranslationSession({ ...common, model: capabilities.model });
  };
  factory.capabilities = () => ({ ...capabilities });
  return factory;
}

// Backward-compatible exports used by existing tests and integrations.
const sessionUpdate = promptedSessionUpdate;
const OpenAIRealtimeSession = OpenAIPromptedRealtimeSession;

export {
  DEFAULT_PROMPTED_MODEL,
  DEFAULT_TRANSLATION_MODEL,
  OpenAIRealtimeSession,
  promptedSessionUpdate,
  sessionUpdate,
  translationInstructions,
  translationSessionUpdate,
};
