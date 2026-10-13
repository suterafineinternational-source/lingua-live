const NativeWebSocket = window.WebSocket;
const nativeFetch = window.fetch.bind(window);

const STALL_AFTER_MS = 4500;
const SPEECH_RECENT_MS = 2500;
const WARMUP_MS = 6000;
const CHECK_INTERVAL_MS = 750;

let transportMode = "idle";
let directStartedAt = 0;
let lastSpeechAt = 0;
let lastTranslationAt = 0;
let fallbackStarted = false;
let audioMessages = 0;

function roomCredentials() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
  if (!code) return null;
  const token = sessionStorage.getItem(`lingua-host-token-${code}`);
  if (!token) return null;
  return { code, token };
}

function pcmPeak(base64) {
  try {
    const binary = atob(base64);
    let max = 0;
    for (let i = 0; i + 1 < binary.length; i += 8) {
      const lo = binary.charCodeAt(i);
      const hi = binary.charCodeAt(i + 1);
      let sample = (hi << 8) | lo;
      if (sample & 0x8000) sample -= 0x10000;
      max = Math.max(max, Math.abs(sample));
    }
    return max / 32768;
  } catch {
    return 0;
  }
}

function noteSourceMessage(raw) {
  audioMessages += 1;
  if (audioMessages % 4 !== 0) return;
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message?.type !== "audio.append" || typeof message.audio !== "string") return;
  if (pcmPeak(message.audio) > 0.025) lastSpeechAt = Date.now();
}

function noteServerMessage(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  if (event?.type === "transcript.delta" || event?.type === "transcript.done" || event?.type === "audio.delta") {
    lastTranslationAt = Date.now();
  }
}

function setFallbackUi(message) {
  const mode = document.querySelector("#transport-mode");
  const detail = document.querySelector("#transport-detail");
  if (mode) {
    mode.textContent = "TRANSPORT: SERVER RECOVERY";
    mode.dataset.state = "fallback";
  }
  if (detail) detail.textContent = message;
}

async function switchToServer(reason) {
  if (fallbackStarted || transportMode !== "webrtc") return;
  const credentials = roomCredentials();
  if (!credentials) return;
  fallbackStarted = true;
  setFallbackUi("Realtime WebRTC stalled; switching automatically to the server translation path…");
  try {
    const response = await nativeFetch(`/api/rooms/${credentials.code}/fallback-server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.token}` },
      body: JSON.stringify({ reason }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Server recovery failed (${response.status}).`);
    transportMode = "server-websocket";
    setFallbackUi("Automatic recovery active · server realtime translation · stale source audio is discarded instead of replayed late.");
    window.dispatchEvent(new CustomEvent("lingua:translation-recovered", { detail: { transport: "server-websocket", at: Date.now(), reason } }));
  } catch (error) {
    fallbackStarted = false;
    setFallbackUi(`Automatic translation recovery failed: ${error.message}`);
  }
}

function checkHealth() {
  if (transportMode !== "webrtc" || fallbackStarted || !directStartedAt) return;
  const now = Date.now();
  if (now - directStartedAt < WARMUP_MS) return;
  const sourceIsSpeaking = lastSpeechAt && now - lastSpeechAt <= SPEECH_RECENT_MS;
  if (!sourceIsSpeaking) return;
  const outputAge = lastTranslationAt ? now - lastTranslationAt : now - directStartedAt;
  if (outputAge >= STALL_AFTER_MS) void switchToServer(`No translated output for ${outputAge} ms while source speech remained active.`);
}

class RealtimeHealthWebSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    try {
      const parsed = new URL(String(url), location.href);
      if (parsed.pathname === "/ws" && parsed.searchParams.get("role") === "host") {
        this.addEventListener("message", ({ data }) => noteServerMessage(data));
      }
    } catch {}
  }

  send(data) {
    if (typeof data === "string" && data.includes('"audio.append"')) noteSourceMessage(data);
    return super.send(data);
  }
}

for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
  try { Object.defineProperty(RealtimeHealthWebSocket, key, { value: NativeWebSocket[key] }); } catch {}
}
window.WebSocket = RealtimeHealthWebSocket;

window.addEventListener("lingua:transport", ({ detail }) => {
  transportMode = detail?.mode || "idle";
  if (transportMode === "webrtc") {
    directStartedAt = Date.now();
    lastTranslationAt = 0;
    fallbackStarted = false;
  }
});

const timer = setInterval(checkHealth, CHECK_INTERVAL_MS);
window.addEventListener("beforeunload", () => clearInterval(timer), { once: true });

export function realtimeHealthSnapshot() {
  const now = Date.now();
  return {
    transportMode,
    sourceSpeechAgeMs: lastSpeechAt ? now - lastSpeechAt : null,
    translationAgeMs: lastTranslationAt ? now - lastTranslationAt : null,
    fallbackStarted,
  };
}
