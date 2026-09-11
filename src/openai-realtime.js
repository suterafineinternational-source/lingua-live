import WebSocket from "ws";
import { AppError } from "./errors.js";

const OPEN = WebSocket.OPEN;
const MAX_QUEUED_AUDIO_CHUNKS = 150;

function languageName(code) {
  const normalized = String(code || "").toLowerCase();
  return { it: "Italian", en: "English", "en-us": "English", "en-gb": "English", es: "Spanish", fr: "French", de: "German" }[normalized] || normalized;
}

function translationInstructions(glossary, sourceLanguage = "it", targetLanguage = "en") {
  const terms = glossary.length
    ? `\nUse these glossary entries exactly when relevant:\n${glossary.map((entry) => `- ${entry}`).join("\n")}`
    : "";
  return [
    "You are a professional live interpreter.",
    `Translate every ${languageName(sourceLanguage)} utterance into natural ${languageName(targetLanguage)}.`,
    "Preserve meaning, tone, names, numbers and terminology.",
    "Respond only with the translation. Do not answer the speaker or add commentary.",
    "Keep pace with the speaker and use fluent phrasing suitable for live captions.",
    terms,
  ].join(" ");
}

function sessionUpdate(model, glossary, sourceLanguage = "it", targetLanguage = "en") {
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
          transcription: { model: "gpt-4o-mini-transcribe", language: sourceLanguage.split("-")[0] },
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

function safeUpstreamMessage(message) {
  if (!message) return "The interpretation service reported an error.";
  return String(message).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}

export class OpenAIRealtimeSession {
  constructor({ apiKey, model = "gpt-realtime", glossary = [], sourceLanguage = "it", targetLanguage = "en", onEvent, onStatus, logger = console }) {
    if (!apiKey) throw new AppError(503, "OPENAI_API_KEY_MISSING", "Live interpretation is unavailable until OPENAI_API_KEY is configured.");
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
        reject(new AppError(504, "INTERPRETATION_CONNECTION_TIMEOUT", "The interpretation service did not connect in time.", { retriable: true }));
      }, 10_000);
      this.initialTimer.unref?.();
      this.connect();
    });
  }

  connect() {
    if (!this.shouldRun) return;
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.apiKey}`, "OpenAI-Beta": "realtime=v1" } });
    this.socket = socket;

    socket.on("open", () => {
      if (socket !== this.socket || !this.shouldRun) return socket.close();
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify(sessionUpdate(this.model, this.glossary, this.sourceLanguage, this.targetLanguage)));
      for (const audio of this.audioQueue.splice(0)) this.sendAudio(audio);
      this.onStatus?.({ state: "connected", message: "Interpretation service connected." });
      if (!this.initialSettled) {
        this.initialSettled = true;
        clearTimeout(this.initialTimer);
        this.initialResolve?.();
      }
    });

    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => this.logger.error("OpenAI Realtime socket error:", safeUpstreamMessage(error.message)));
    socket.on("close", (code) => {
      if (socket !== this.socket || !this.shouldRun) return;
      this.socket = null;
      this.scheduleReconnect(code);
    });
  }

  handleMessage(data) {
    let event;
    try { event = JSON.parse(data.toString()); } catch { this.logger.error("OpenAI Realtime returned a non-JSON event."); return; }

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
        this.onEvent?.({ type: "audio.delta", responseId: event.response_id, itemId: event.item_id, audio: event.delta, format: "pcm16", sampleRate: 24000 });
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
      case "error": {
        const message = safeUpstreamMessage(event.error?.message);
        this.logger.error("OpenAI Realtime API error:", message);
        this.onEvent?.({ type: "service.error", error: { code: "INTERPRETATION_SERVICE_ERROR", message: "The interpretation service reported an error.", retriable: event.error?.type === "server_error" } });
        break;
      }
      default:
        break;
    }
  }

  appendAudio(audio) {
    if (typeof audio !== "string" || audio.length === 0 || audio.length > 512_000 || audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
      throw new AppError(400, "INVALID_AUDIO", "Audio chunks must be non-empty base64 strings under 512 KB.");
    }
    if (this.socket?.readyState === OPEN) return this.sendAudio(audio);
    this.audioQueue.push(audio);
    if (this.audioQueue.length > MAX_QUEUED_AUDIO_CHUNKS) this.audioQueue.shift();
  }

  sendAudio(audio) { this.socket?.send(JSON.stringify({ type: "input_audio_buffer.append", audio })); }

  updateGlossary(glossary) {
    this.glossary = glossary;
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(sessionUpdate(this.model, this.glossary, this.sourceLanguage, this.targetLanguage)));
  }

  scheduleReconnect(closeCode) {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(500 * 2 ** (this.reconnectAttempt - 1), 8000);
    this.onStatus?.({ state: "reconnecting", message: "Interpretation service disconnected; reconnecting.", attempt: this.reconnectAttempt, retryInMs: delayMs });
    if (!this.initialSettled && closeCode === 1008) {
      this.initialSettled = true;
      this.shouldRun = false;
      clearTimeout(this.initialTimer);
      this.initialReject?.(new AppError(502, "INTERPRETATION_CONNECTION_FAILED", "The interpretation service rejected the connection."));
      return;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    this.reconnectTimer.unref?.();
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
      this.initialReject?.(new AppError(503, "INTERPRETATION_STOPPED", "The interpretation connection was stopped.", { retriable: true }));
    }
  }
}

export function createOpenAIRealtimeFactory(config = {}) {
  return ({ glossary, sourceLanguage, targetLanguage, onEvent, onStatus }) => new OpenAIRealtimeSession({
    apiKey: config.apiKey,
    model: config.model,
    glossary,
    sourceLanguage,
    targetLanguage,
    onEvent,
    onStatus,
    logger: config.logger,
  });
}

export { sessionUpdate, translationInstructions };
