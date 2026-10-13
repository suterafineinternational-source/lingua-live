import WebSocket from "ws";
import { AppError } from "./errors.js";

const OPEN = WebSocket.OPEN;
const TEXT_FLUSH_INTERVAL_MS = 45;
const MAX_PENDING_TEXT_CHARS = 320;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;

function safeMessage(message) {
  if (!message) return "ElevenLabs voice service reported an error.";
  return String(message).replace(/xi-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

export function reassemblePcm16Base64(audio, carry = Buffer.alloc(0)) {
  const incoming = Buffer.from(String(audio || ""), "base64");
  const prefix = Buffer.isBuffer(carry) && carry.length ? carry : Buffer.alloc(0);
  const combined = prefix.length ? Buffer.concat([prefix, incoming]) : incoming;
  const alignedLength = combined.length - (combined.length % 2);
  return {
    audio: alignedLength ? combined.subarray(0, alignedLength).toString("base64") : "",
    carry: alignedLength < combined.length ? Buffer.from(combined.subarray(alignedLength)) : Buffer.alloc(0),
  };
}

export class ElevenLabsRealtimeVoice {
  constructor({ apiKey, voiceId, modelId = "eleven_flash_v2_5", languageCode = "en", outputFormat = "pcm_24000", onAudio, onStatus, logger = console }) {
    if (!apiKey) throw new AppError(503, "ELEVENLABS_API_KEY_MISSING", "Evan voice is unavailable until ELEVENLABS_API_KEY is configured on the server.");
    if (!voiceId) throw new AppError(503, "ELEVENLABS_VOICE_ID_MISSING", "Evan voice is unavailable until ELEVENLABS_VOICE_ID is configured on the server.");
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.languageCode = languageCode;
    this.outputFormat = outputFormat;
    this.onAudio = onAudio;
    this.onStatus = onStatus;
    this.logger = logger;
    this.socket = null;
    this.shouldRun = false;
    this.started = false;
    this.pendingText = "";
    this.pendingTimer = null;
    this.flushRequested = false;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.hadTextThisTurn = false;
    this.lastSendAt = 0;
    this.pcmCarry = Buffer.alloc(0);
    this.droppedTextChars = 0;
    this.textMessagesSent = 0;
    this.maxPendingTextSeen = 0;
  }

  connectionUrl() {
    const url = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream-input`);
    url.searchParams.set("model_id", this.modelId);
    url.searchParams.set("output_format", this.outputFormat);
    url.searchParams.set("language_code", this.languageCode);
    url.searchParams.set("inactivity_timeout", "180");
    return url.toString();
  }

  start() {
    if (this.shouldRun && this.started) return Promise.resolve();
    this.shouldRun = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new AppError(504, "EVAN_CONNECTION_TIMEOUT", "Evan voice service did not connect in time.", { retriable: true }));
        try { this.socket?.terminate(); } catch {}
      }, 10_000);
      timeout.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      };
      this.connect({ initialFinish: finish });
    });
  }

  connect({ initialFinish } = {}) {
    if (!this.shouldRun) return;
    this.pcmCarry = Buffer.alloc(0);
    const socket = new WebSocket(this.connectionUrl(), { headers: { "xi-api-key": this.apiKey } });
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket || !this.shouldRun) return socket.close();
      this.started = true;
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify({ text: " ", generation_config: { chunk_length_schedule: [50, 90, 140, 220] } }));
      this.lastSendAt = Date.now();
      this.startKeepAlive();
      this.onStatus?.({ state: "connected", provider: "elevenlabs", voiceName: "Evan", voiceId: this.voiceId, modelId: this.modelId });
      this.logger.info?.(`[Lingua] ElevenLabs Evan connected voice=${this.voiceId} model=${this.modelId}`);
      initialFinish?.();
      this.flushPendingSoon(0);
    });
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("unexpected-response", (_request, response) => {
      const error = new AppError(response.statusCode === 401 || response.statusCode === 403 ? 503 : 502, "EVAN_CONNECTION_REJECTED", `Evan voice service rejected the connection (HTTP ${response.statusCode}).`);
      this.logger.error?.(`[Lingua] ElevenLabs websocket rejected: HTTP ${response.statusCode}`);
      initialFinish?.(error);
    });
    socket.on("error", (error) => this.logger.error?.("ElevenLabs Evan socket error:", safeMessage(error.message)));
    socket.on("close", (code, reason) => {
      this.logger.warn?.(`[Lingua] ElevenLabs Evan closed code=${code} reason=${safeMessage(reason?.toString())}`);
      if (socket !== this.socket || !this.shouldRun) return;
      this.socket = null;
      this.started = false;
      this.stopKeepAlive();
      if (initialFinish) initialFinish(new AppError(502, "EVAN_CONNECTION_FAILED", "Evan voice service disconnected during startup.", { retriable: true }));
      this.scheduleReconnect();
    });
  }

  handleMessage(data) {
    let event;
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event.error) {
      const message = safeMessage(event.error?.message || event.message || event.error);
      this.logger.error?.("ElevenLabs Evan API error:", message);
      this.onStatus?.({ state: "error", provider: "elevenlabs", voiceName: "Evan", message });
      return;
    }
    if (event.audio) {
      const aligned = reassemblePcm16Base64(event.audio, this.pcmCarry);
      this.pcmCarry = aligned.carry;
      if (aligned.audio) this.onAudio?.(aligned.audio, { provider: "elevenlabs", voiceName: "Evan", voiceId: this.voiceId, sampleRate: 24000 });
    }
    if ((event.is_final || event.isFinal) && this.pcmCarry.length) {
      this.logger.warn?.("[Lingua] ElevenLabs Evan ended with an incomplete PCM16 sample; dropping one trailing byte.");
      this.pcmCarry = Buffer.alloc(0);
    }
  }

  trimPendingText() {
    this.maxPendingTextSeen = Math.max(this.maxPendingTextSeen, this.pendingText.length);
    if (this.pendingText.length <= MAX_PENDING_TEXT_CHARS) return;
    const minimumCut = this.pendingText.length - MAX_PENDING_TEXT_CHARS;
    const nearbyBoundary = this.pendingText.indexOf(" ", minimumCut);
    const cutAt = nearbyBoundary >= minimumCut && nearbyBoundary <= minimumCut + 80 ? nearbyBoundary + 1 : minimumCut;
    this.pendingText = this.pendingText.slice(cutAt);
    this.droppedTextChars += cutAt;
    this.onStatus?.({
      state: "dropping_stale_voice_text",
      provider: "elevenlabs",
      voiceName: "Evan",
      message: "Evan briefly fell behind; stale translated text was discarded to keep spoken interpretation realtime.",
      droppedTextChars: this.droppedTextChars,
      pendingTextChars: this.pendingText.length,
    });
  }

  sendDelta(delta) {
    if (!this.shouldRun || !delta) return;
    this.pendingText += String(delta);
    this.hadTextThisTurn = true;
    this.trimPendingText();
    this.flushPendingSoon(TEXT_FLUSH_INTERVAL_MS);
  }

  flushPendingSoon(delayMs = TEXT_FLUSH_INTERVAL_MS) {
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => this.flushPending(false), Math.max(0, delayMs));
    this.pendingTimer.unref?.();
  }

  flushPending(flush = false) {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (flush) this.flushRequested = true;
    if (this.socket?.readyState !== OPEN) return;
    if ((Number(this.socket.bufferedAmount) || 0) > MAX_SOCKET_BUFFERED_BYTES) {
      this.onStatus?.({
        state: "voice_backpressure",
        provider: "elevenlabs",
        voiceName: "Evan",
        message: "Evan output is briefly backpressured; holding only a short realtime text window.",
        bufferedBytes: Number(this.socket.bufferedAmount) || 0,
        pendingTextChars: this.pendingText.length,
      });
      this.flushPendingSoon(TEXT_FLUSH_INTERVAL_MS);
      return;
    }

    const text = this.pendingText;
    const shouldFlush = this.flushRequested;
    this.pendingText = "";
    this.flushRequested = false;
    if (text) {
      this.socket.send(JSON.stringify({ text, ...(shouldFlush ? { flush: true } : {}) }));
      this.textMessagesSent += 1;
      this.lastSendAt = Date.now();
    } else if (shouldFlush) {
      this.socket.send(JSON.stringify({ text: " ", flush: true }));
      this.textMessagesSent += 1;
      this.lastSendAt = Date.now();
    }
  }

  finishTurn(fallbackText = "") {
    if (!this.shouldRun) return;
    if (!this.hadTextThisTurn && fallbackText) {
      this.pendingText += String(fallbackText);
      this.trimPendingText();
    }
    this.hadTextThisTurn = false;
    this.flushPending(true);
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.shouldRun || this.socket?.readyState !== OPEN) return;
      if (this.pendingText || this.flushRequested) return;
      if (Date.now() - this.lastSendAt < 15_000) return;
      this.socket.send(JSON.stringify({ text: " " }));
      this.lastSendAt = Date.now();
    }, 15_000);
    this.keepAliveTimer.unref?.();
  }

  stopKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(500 * 2 ** (this.reconnectAttempt - 1), 8000);
    this.onStatus?.({ state: "reconnecting", provider: "elevenlabs", voiceName: "Evan", retryInMs: delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  snapshot() {
    return {
      pendingTextChars: this.pendingText.length,
      maxPendingTextSeen: this.maxPendingTextSeen,
      droppedTextChars: this.droppedTextChars,
      textMessagesSent: this.textMessagesSent,
      socketBufferedBytes: Number(this.socket?.bufferedAmount) || 0,
    };
  }

  close() {
    this.shouldRun = false;
    this.started = false;
    clearTimeout(this.pendingTimer);
    clearTimeout(this.reconnectTimer);
    this.pendingTimer = null;
    this.reconnectTimer = null;
    this.stopKeepAlive();
    this.pendingText = "";
    this.flushRequested = false;
    this.hadTextThisTurn = false;
    this.pcmCarry = Buffer.alloc(0);
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === OPEN) {
      try { socket.send(JSON.stringify({ text: "" })); } catch {}
      try { socket.close(1000, "Room ended"); } catch {}
    } else {
      try { socket?.terminate(); } catch {}
    }
  }
}

export function createElevenLabsVoiceFactory(options = {}) {
  return (sessionOptions = {}) => new ElevenLabsRealtimeVoice({ ...options, ...sessionOptions });
}

export { MAX_PENDING_TEXT_CHARS, MAX_SOCKET_BUFFERED_BYTES, TEXT_FLUSH_INTERVAL_MS };
