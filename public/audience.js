import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";
import { PcmQueuePlayer } from "/pcm-playback.js?v=20260915-2";

const roomCode = location.pathname.split("/").filter(Boolean).at(-1).toUpperCase();
const elements = {
  roomCode: document.querySelector("#room-code"), error: document.querySelector("#error"), history: document.querySelector("#caption-history"), current: document.querySelector("#caption-current"), connection: document.querySelector("#connection-status"), listenerCount: document.querySelector("#listener-count"), pulse: document.querySelector("#live-pulse"), enableAudio: document.querySelector("#enable-audio"), volume: document.querySelector("#volume"), pinPanel: document.querySelector("#pin-panel"), audiencePin: document.querySelector("#audience-pin"), joinRoom: document.querySelector("#join-room"), captionStage: document.querySelector("#caption-stage"), eventTitle: document.querySelector("#event-title"), languagePair: document.querySelector("#language-pair"), sharedScreen: document.querySelector("#shared-screen"), screenPlaceholder: document.querySelector("#screen-placeholder"), screenStatus: document.querySelector("#screen-status"), playbackStatus: document.querySelector("#playback-status"),
};

let socket, reconnectTimer, admissionToken;
let reconnectAttempt = 0, shouldConnect = true, activeResponse, activeText = "";
let lastPlaybackTelemetry = 0, screenFramesReceived = 0;

class AudiencePlayer {
  constructor() { this.engine = new PcmQueuePlayer({ volume: 1, lookAhead: 0.03, maxPending: 30 }); }
  get enabled() { return this.engine.enabled; }
  get volume() { return this.engine.volume; }
  snapshot() { return this.engine.snapshot(); }
  status(prefix) {
    const state = this.snapshot();
    setText(elements.playbackStatus, `${prefix} · context ${state.state} · ${state.receivedChunks} received · ${state.scheduledChunks} played/scheduled · queue ${state.queuedSeconds.toFixed(2)} s`);
  }
  async enable() {
    await this.engine.enable();
    this.status("English audio ON");
    reportAudioState();
  }
  disable() {
    this.engine.disable();
    this.status("English audio OFF");
    reportAudioState();
  }
  setVolume(value) {
    this.engine.setVolume(value);
    this.status(this.enabled ? "English audio LIVE" : "English audio OFF");
    reportAudioState();
  }
  enqueue(base64, sampleRate = 24000) {
    try {
      const before = this.snapshot();
      this.engine.enqueue(base64, sampleRate);
      const after = this.snapshot();
      if (!after.enabled) this.status("English voice ready — tap Enable English audio");
      else this.status("English audio LIVE");
      if (after.scheduledChunks > before.scheduledChunks) {
        const now = Date.now();
        if (now - lastPlaybackTelemetry > 600) { lastPlaybackTelemetry = now; reportPlayback(now); }
      }
    } catch (error) {
      showError(new Error(`Could not play English audio: ${error.message}`));
      setText(elements.playbackStatus, `English audio playback error · ${error.message}`);
      reportAudioState();
    }
  }
  reset() { this.engine.reset(); }
}
const player = new AudiencePlayer();

function showError(error) { elements.error.textContent = error?.message || "Something went wrong."; elements.error.classList.remove("hidden"); }
function clearError() { elements.error.classList.add("hidden"); elements.error.textContent = ""; }
function addCaption(text) { if (!text?.trim()) return; const p = document.createElement("p"); p.className = "caption"; p.textContent = text.trim(); elements.history.append(p); while (elements.history.children.length > 6) elements.history.firstElementChild.remove(); }
function sendTelemetry(payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
function playbackPayload(type, now = null) {
  const state = player.snapshot();
  return {
    type,
    enabled: state.enabled,
    volume: state.volume,
    playedChunks: state.scheduledChunks,
    receivedChunks: state.receivedChunks,
    pendingChunks: state.pendingChunks,
    queuedSeconds: Number(state.queuedSeconds.toFixed(3)),
    audioContextState: state.state,
    lastPlaybackAt: now || state.lastScheduledAt || null,
  };
}
function reportAudioState() { sendTelemetry(playbackPayload("listener.audio_state")); }
function reportPlayback(now = Date.now()) { sendTelemetry(playbackPayload("listener.playback", now)); }

function updateRoom(room) {
  const live = room.status === "live"; elements.pulse.classList.toggle("live", live);
  setText(elements.connection, live ? "Live interpretation" : room.status === "ended" ? "Room ended" : "Waiting for host");
  setText(elements.listenerCount, String(room.listenerCount)); setText(elements.eventTitle, room.title || "Live interpretation"); setText(elements.languagePair, `${room.sourceLanguage?.toUpperCase() || "IT"} → ${room.targetLanguage?.toUpperCase() || "EN"}`);
  if (room.status === "ended") { shouldConnect = false; player.reset(); elements.current.textContent = "This event has ended."; }
}

function showScreenFrame(event) {
  screenFramesReceived += 1;
  elements.sharedScreen.onload = () => {
    elements.sharedScreen.classList.remove("hidden");
    elements.screenPlaceholder.classList.add("hidden");
    setText(elements.screenStatus, `Host screen LIVE · ${screenFramesReceived} frames received · last update ${new Date(event.at || Date.now()).toLocaleTimeString()}`);
  };
  elements.sharedScreen.onerror = () => setText(elements.screenStatus, "A host screen frame arrived but could not be rendered.");
  elements.sharedScreen.src = event.image;
}

function handleEvent(event) {
  if (event.type === "session.ready") { updateRoom(event.room); for (const item of event.history || []) addCaption(item.transcript); reportAudioState(); }
  if (event.type === "room.status" || event.type === "room.ended") updateRoom(event.room);
  if (event.type === "presence") setText(elements.listenerCount, String(event.listenerCount));
  if (event.type === "speaker.status") elements.pulse.classList.toggle("live", event.speaking);
  if (event.type === "transcript.delta") { if (activeResponse && activeResponse !== event.responseId) addCaption(activeText); if (activeResponse !== event.responseId) activeText = ""; activeResponse = event.responseId; activeText += event.delta || ""; elements.current.textContent = activeText || "Listening…"; }
  if (event.type === "transcript.done") { const finalText = event.transcript || activeText; addCaption(finalText); activeResponse = null; activeText = ""; elements.current.textContent = "Listening…"; }
  if (event.type === "audio.delta") player.enqueue(event.audio, event.sampleRate || 24000);
  if (event.type === "screen.frame") showScreenFrame(event);
  if (event.type === "service.status") setText(elements.connection, event.message);
  if (event.type === "service.error" || event.type === "client.error") showError(event.error);
}

function connect() {
  clearTimeout(reconnectTimer); setText(elements.connection, reconnectAttempt ? "Reconnecting…" : "Connecting…");
  socket = new WebSocket(webSocketUrl({ room: roomCode, role: "audience", clientId: clientId(`lingua-audience-${roomCode}`), admission: admissionToken }));
  socket.addEventListener("open", () => { reconnectAttempt = 0; socket.send(JSON.stringify({ type: "client.ready" })); setTimeout(reportAudioState, 100); });
  socket.addEventListener("message", ({ data }) => handleEvent(JSON.parse(data)));
  socket.addEventListener("close", () => { if (!shouldConnect) return; const delay = reconnectDelay(reconnectAttempt++); setText(elements.connection, `Reconnecting in ${Math.ceil(delay/1000)}s…`); reconnectTimer = setTimeout(connect, delay); });
  socket.addEventListener("error", () => setText(elements.connection, "Connection interrupted"));
}

async function admit(pin) {
  const payload = await api(`/api/rooms/${roomCode}/admit`, { method: "POST", body: JSON.stringify({ pin }) }); admissionToken = payload.admissionToken; sessionStorage.setItem(`lingua-admission-${roomCode}`, admissionToken); elements.pinPanel.classList.add("hidden"); clearError(); connect();
}

elements.joinRoom.addEventListener("click", async () => { try { elements.joinRoom.disabled = true; await admit(elements.audiencePin.value); } catch (error) { showError(error); elements.joinRoom.disabled = false; } });
elements.enableAudio.addEventListener("click", async () => {
  clearError();
  try {
    if (player.enabled) {
      player.disable(); elements.enableAudio.textContent = "Enable English audio"; return;
    }
    await player.enable();
    elements.enableAudio.textContent = "Turn English audio OFF";
  } catch (error) {
    showError(new Error(`Could not enable English audio: ${error.message}`));
    setText(elements.playbackStatus, `Audio blocked by browser · ${error.message}`);
  }
});
elements.volume.addEventListener("input", () => player.setVolume(elements.volume.value));

async function initialize() {
  setText(elements.roomCode, roomCode);
  try {
    const payload = await api(`/api/rooms/${roomCode}`); updateRoom(payload.room); if (payload.room.status === "ended") return;
    admissionToken = sessionStorage.getItem(`lingua-admission-${roomCode}`);
    if (payload.room.pinRequired && !admissionToken) { elements.pinPanel.classList.remove("hidden"); setText(elements.connection, "PIN required"); return; }
    if (!admissionToken) { const admitted = await api(`/api/rooms/${roomCode}/admit`, { method: "POST", body: JSON.stringify({}) }); admissionToken = admitted.admissionToken; }
    connect();
  } catch (error) { shouldConnect = false; showError(error); setText(elements.connection, "Room unavailable"); }
}
initialize();