import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";

const roomCode = location.pathname.split("/").filter(Boolean).at(-1).toUpperCase();
const elements = {
  roomCode: document.querySelector("#room-code"), error: document.querySelector("#error"), history: document.querySelector("#caption-history"), current: document.querySelector("#caption-current"), connection: document.querySelector("#connection-status"), listenerCount: document.querySelector("#listener-count"), pulse: document.querySelector("#live-pulse"), enableAudio: document.querySelector("#enable-audio"), volume: document.querySelector("#volume"), pinPanel: document.querySelector("#pin-panel"), audiencePin: document.querySelector("#audience-pin"), joinRoom: document.querySelector("#join-room"), captionStage: document.querySelector("#caption-stage"), eventTitle: document.querySelector("#event-title"), languagePair: document.querySelector("#language-pair"), sharedScreen: document.querySelector("#shared-screen"), screenPlaceholder: document.querySelector("#screen-placeholder"), playbackStatus: document.querySelector("#playback-status"),
};

let socket, reconnectTimer, admissionToken;
let reconnectAttempt = 0, shouldConnect = true, activeResponse, activeText = "";
let playedChunks = 0, lastPlaybackTelemetry = 0;

class PcmPlayer {
  constructor() { this.context = null; this.nextStart = 0; this.pending = []; this.gain = null; this.volume = 1; this.enabled = false; }
  async enable() {
    this.context ||= new AudioContext({ sampleRate: 24000 });
    this.gain ||= this.context.createGain();
    this.gain.gain.value = this.volume;
    try { this.gain.connect(this.context.destination); } catch {}
    await this.context.resume();
    this.enabled = true;
    for (const chunk of this.pending.splice(0)) this.play(chunk);
    reportAudioState();
  }
  setVolume(value) { this.volume = Number(value); if (this.gain) this.gain.gain.value = this.volume; reportAudioState(); }
  enqueue(base64) {
    if (!this.context || this.context.state !== "running" || !this.enabled) {
      this.pending.push(base64); if (this.pending.length > 50) this.pending.shift(); return;
    }
    this.play(base64);
  }
  play(base64) {
    const binary = atob(base64), bytes = new Uint8Array(binary.length); for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer), buffer = this.context.createBuffer(1, pcm.length, 24000), channel = buffer.getChannelData(0);
    for (let i=0;i<pcm.length;i++) channel[i] = pcm[i] / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    const start = Math.max(this.context.currentTime + 0.025, this.nextStart); source.start(start); this.nextStart = start + buffer.duration;
    playedChunks += 1; setText(elements.playbackStatus, `English audio playing · ${playedChunks} chunks received`);
    const now = Date.now(); if (now - lastPlaybackTelemetry > 1000) { lastPlaybackTelemetry = now; reportPlayback(now); }
  }
  reset() { this.pending = []; this.nextStart = this.context?.currentTime || 0; }
}
const player = new PcmPlayer();

function showError(error) { elements.error.textContent = error?.message || "Something went wrong."; elements.error.classList.remove("hidden"); }
function clearError() { elements.error.classList.add("hidden"); elements.error.textContent = ""; }
function addCaption(text) { if (!text?.trim()) return; const p = document.createElement("p"); p.className = "caption"; p.textContent = text.trim(); elements.history.append(p); while (elements.history.children.length > 6) elements.history.firstElementChild.remove(); }
function sendTelemetry(payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }
function reportAudioState() { sendTelemetry({ type: "listener.audio_state", enabled: player.enabled, volume: player.volume, playedChunks, lastPlaybackAt: playedChunks ? Date.now() : null }); }
function reportPlayback(now = Date.now()) { sendTelemetry({ type: "listener.playback", enabled: player.enabled, volume: player.volume, playedChunks, lastPlaybackAt: now }); }

function updateRoom(room) {
  const live = room.status === "live"; elements.pulse.classList.toggle("live", live);
  setText(elements.connection, live ? "Live interpretation" : room.status === "ended" ? "Room ended" : "Waiting for host");
  setText(elements.listenerCount, String(room.listenerCount)); setText(elements.eventTitle, room.title || "Live interpretation"); setText(elements.languagePair, `${room.sourceLanguage?.toUpperCase() || "IT"} → ${room.targetLanguage?.toUpperCase() || "EN"}`);
  if (room.status === "ended") { shouldConnect = false; player.reset(); elements.current.textContent = "This event has ended."; }
}

function handleEvent(event) {
  if (event.type === "session.ready") { updateRoom(event.room); for (const item of event.history || []) addCaption(item.transcript); reportAudioState(); }
  if (event.type === "room.status" || event.type === "room.ended") updateRoom(event.room);
  if (event.type === "presence") setText(elements.listenerCount, String(event.listenerCount));
  if (event.type === "speaker.status") elements.pulse.classList.toggle("live", event.speaking);
  if (event.type === "transcript.delta") { if (activeResponse && activeResponse !== event.responseId) addCaption(activeText); if (activeResponse !== event.responseId) activeText = ""; activeResponse = event.responseId; activeText += event.delta || ""; elements.current.textContent = activeText || "Listening…"; }
  if (event.type === "transcript.done") { const finalText = event.transcript || activeText; addCaption(finalText); activeResponse = null; activeText = ""; elements.current.textContent = "Listening…"; }
  if (event.type === "audio.delta") player.enqueue(event.audio);
  if (event.type === "screen.frame") { elements.sharedScreen.src = event.image; elements.sharedScreen.classList.remove("hidden"); elements.screenPlaceholder.classList.add("hidden"); }
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
elements.enableAudio.addEventListener("click", async () => { try { await player.enable(); elements.enableAudio.textContent = "English audio ON"; elements.enableAudio.disabled = true; setText(elements.playbackStatus, "English audio enabled · waiting for translation"); reportAudioState(); } catch (error) { showError(error); } });
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
