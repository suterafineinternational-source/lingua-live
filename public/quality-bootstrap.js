import { RealtimeQualityMonitor, qualityLabel } from "/quality-monitor.js?v=20260911-1";

const quality = new RealtimeQualityMonitor();
const NativeWebSocket = window.WebSocket;
let roomLive = false;
let capturedChunks = 0;
let capturedNonSilent = 0;
let captureBaseline = 0;
let nonSilentBaseline = 0;
let audioBufferUntil = 0;
let lastError = "";

function element(id) { return document.getElementById(id); }
function formatSeconds(value) { return value == null ? "—" : `${Math.max(0, value).toFixed(2)} s`; }
function formatLag(value) { return value == null ? "—" : `${(value / 1000).toFixed(2)} s`; }

function parseCaptureStatus() {
  const text = element("service-status")?.textContent || "";
  const match = text.match(/(\d+) chunks sent\s*·\s*(\d+) with speech signal/i);
  if (!match) return;
  capturedChunks = Number(match[1]);
  capturedNonSilent = Number(match[2]);
  if (roomLive) quality.recordCaptureTotals(capturedChunks - captureBaseline, capturedNonSilent - nonSilentBaseline);
}

function playbackBufferSeconds() {
  return Math.max(0, audioBufferUntil - performance.now() / 1000);
}

function paceLabel(pace) {
  return {
    waiting: "Waiting for speech",
    normal: "Normal",
    brisk: "Brisk (150+ WPM)",
    fast: "Fast (180+ WPM)",
    "very-fast": "Very fast (210+ WPM)",
  }[pace] || pace;
}

function verdict(snapshot) {
  if (!roomLive) return "Start interpretation to measure realtime performance.";
  if (lastError) return `FAIL · ${lastError}`;
  if (snapshot.elapsedSeconds < 20) return "Warming up · speak continuously for at least 30–60 seconds.";
  if (snapshot.wpm < 150) return `Stable so far · ${snapshot.wpm || 0} WPM. Speak faster to stress-test 150–210 WPM.`;
  if (snapshot.health === "healthy" && snapshot.inputDrops === 0 && (snapshot.averageLagMs ?? Infinity) <= 2500 && snapshot.playbackBufferSeconds <= 2.5) {
    return `PASS at ${snapshot.wpm} WPM · translation stream is keeping up without measurable relay loss.`;
  }
  if (snapshot.health === "warning") return `WATCH at ${snapshot.wpm} WPM · the stream is working but latency/backlog is increasing.`;
  if (snapshot.health === "critical") return `FAIL at ${snapshot.wpm} WPM · backlog or input loss is too high for clean simultaneous interpretation.`;
  return `Measuring at ${snapshot.wpm} WPM…`;
}

function renderEnglishDelay(snapshot) {
  const delayNode = element("current-english-delay");
  const detailNode = element("english-delay-detail");
  if (!delayNode) return;

  if (!roomLive) {
    delayNode.textContent = "Current English delay: —";
    delayNode.dataset.state = "idle";
    if (detailNode) detailNode.textContent = "Measured continuously from the live translation stream.";
    return;
  }

  if (snapshot.latestLagMs == null) {
    delayNode.textContent = "Current English delay: measuring…";
    delayNode.dataset.state = "idle";
    if (detailNode) detailNode.textContent = "Waiting for matching Italian and English realtime segments.";
    return;
  }

  const estimatedDelayMs = Math.max(0, snapshot.latestLagMs + snapshot.playbackBufferSeconds * 1000);
  const seconds = estimatedDelayMs / 1000;
  delayNode.textContent = `Current English delay: ${seconds.toFixed(2)} s`;
  delayNode.dataset.state = seconds <= 2.5 ? "good" : seconds <= 5 ? "watch" : "high";
  if (detailNode) detailNode.textContent = `Live estimate · translation onset ${formatLag(snapshot.latestLagMs)} + English playback buffer ${formatSeconds(snapshot.playbackBufferSeconds)}.`;
}

function renderQuality() {
  const snapshot = quality.snapshot({ playbackBufferSeconds: playbackBufferSeconds() });
  const health = element("quality-health");
  if (health) {
    health.textContent = qualityLabel(snapshot);
    health.dataset.state = snapshot.health;
  }
  if (element("quality-wpm")) element("quality-wpm").textContent = snapshot.wpm ? `${snapshot.wpm} WPM` : "—";
  if (element("quality-pace")) element("quality-pace").textContent = paceLabel(snapshot.pace);
  if (element("quality-lag")) element("quality-lag").textContent = formatLag(snapshot.averageLagMs);
  if (element("quality-lag-max")) element("quality-lag-max").textContent = `latest ${formatLag(snapshot.latestLagMs)} · max ${formatLag(snapshot.maxLagMs)}`;
  if (element("quality-buffer")) element("quality-buffer").textContent = formatSeconds(snapshot.playbackBufferSeconds);
  if (element("quality-input")) element("quality-input").textContent = `${Math.max(0, snapshot.inputChunks)} sent · ${snapshot.inputDrops} missed`;
  if (element("quality-output")) element("quality-output").textContent = `${snapshot.audioChunks} English audio chunks · ${snapshot.pendingTranslations} pending segment${snapshot.pendingTranslations === 1 ? "" : "s"}`;
  if (element("quality-verdict")) element("quality-verdict").textContent = verdict(snapshot);
  renderEnglishDelay(snapshot);
}

function startLiveMeasurement() {
  parseCaptureStatus();
  captureBaseline = capturedChunks;
  nonSilentBaseline = capturedNonSilent;
  audioBufferUntil = performance.now() / 1000;
  lastError = "";
  quality.reset();
  roomLive = true;
}

function stopLiveMeasurement() {
  roomLive = false;
  renderQuality();
}

function onRealtimeEvent(event) {
  if (event.type === "room.status") {
    if (event.room?.status === "live" && !roomLive) startLiveMeasurement();
    if (event.room?.status !== "live" && roomLive) stopLiveMeasurement();
  }
  if (event.type === "room.ended") stopLiveMeasurement();
  if (!roomLive) return;

  if (event.type === "source_transcript.delta") quality.recordSourceDelta(event.itemId || "source-current");
  if (event.type === "source_transcript.done") quality.recordSourceDone(event.itemId || "source-current", event.transcript || "");
  if (event.type === "transcript.delta") quality.recordTranslationDelta(event.itemId || event.responseId || "target-current");
  if (event.type === "transcript.done") quality.recordTranslationDone();
  if (event.type === "audio.delta" && event.audio) {
    quality.recordAudioChunk();
    const padding = event.audio.endsWith("==") ? 2 : event.audio.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor(event.audio.length * 3 / 4) - padding);
    const duration = bytes / (24000 * 2);
    const now = performance.now() / 1000;
    audioBufferUntil = Math.max(now, audioBufferUntil) + duration;
  }
  if (event.type === "service.error" || event.type === "client.error") lastError = event.error?.message || "Realtime service error";
  renderQuality();
}

class QualityWebSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    this.__linguaHostSocket = false;
    try {
      const parsed = new URL(String(url), location.href);
      this.__linguaHostSocket = parsed.pathname === "/ws" && parsed.searchParams.get("role") === "host";
    } catch {}
    if (this.__linguaHostSocket) {
      this.addEventListener("message", ({ data }) => {
        try { onRealtimeEvent(JSON.parse(data)); } catch {}
      });
    }
  }

  send(data) {
    if (this.__linguaHostSocket && roomLive && typeof data === "string") {
      try {
        const message = JSON.parse(data);
        if (message.type === "audio.append") quality.recordInputSent();
      } catch {}
    }
    return super.send(data);
  }
}

Object.defineProperties(QualityWebSocket, {
  CONNECTING: { value: NativeWebSocket.CONNECTING },
  OPEN: { value: NativeWebSocket.OPEN },
  CLOSING: { value: NativeWebSocket.CLOSING },
  CLOSED: { value: NativeWebSocket.CLOSED },
});
window.WebSocket = QualityWebSocket;

const serviceStatus = element("service-status");
if (serviceStatus) new MutationObserver(() => { parseCaptureStatus(); renderQuality(); }).observe(serviceStatus, { childList: true, characterData: true, subtree: true });

element("quality-reset")?.addEventListener("click", () => {
  parseCaptureStatus();
  captureBaseline = capturedChunks;
  nonSilentBaseline = capturedNonSilent;
  audioBufferUntil = performance.now() / 1000;
  lastError = "";
  quality.reset();
  renderQuality();
});

setInterval(renderQuality, 500);
renderQuality();
