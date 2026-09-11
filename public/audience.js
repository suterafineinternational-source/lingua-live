import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";

const roomCode = location.pathname.split("/").filter(Boolean).at(-1).toUpperCase();
const elements = {
  roomCode: document.querySelector("#room-code"),
  error: document.querySelector("#error"),
  history: document.querySelector("#caption-history"),
  current: document.querySelector("#caption-current"),
  connection: document.querySelector("#connection-status"),
  listenerCount: document.querySelector("#listener-count"),
  pulse: document.querySelector("#live-pulse"),
  enableAudio: document.querySelector("#enable-audio"),
};

let socket;
let reconnectAttempt = 0;
let reconnectTimer;
let shouldConnect = true;
let activeResponse;
let activeText = "";

class PcmPlayer {
  constructor() {
    this.context = null;
    this.nextStart = 0;
    this.pending = [];
  }

  async enable() {
    this.context ||= new AudioContext({ sampleRate: 24000 });
    await this.context.resume();
    for (const chunk of this.pending.splice(0)) this.play(chunk);
  }

  enqueue(base64) {
    if (!this.context || this.context.state !== "running") {
      this.pending.push(base64);
      if (this.pending.length > 50) this.pending.shift();
      return;
    }
    this.play(base64);
  }

  play(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const pcm = new Int16Array(bytes.buffer);
    const buffer = this.context.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.025, this.nextStart);
    source.start(start);
    this.nextStart = start + buffer.duration;
  }

  reset() {
    this.pending = [];
    this.nextStart = this.context?.currentTime || 0;
  }
}

const player = new PcmPlayer();

function showError(error) {
  elements.error.textContent = error?.message || "Something went wrong.";
  elements.error.classList.remove("hidden");
}

function addCaption(text) {
  if (!text?.trim()) return;
  const paragraph = document.createElement("p");
  paragraph.className = "caption";
  paragraph.textContent = text.trim();
  elements.history.append(paragraph);
  while (elements.history.children.length > 4) elements.history.firstElementChild.remove();
}

function updateRoom(room) {
  const live = room.status === "live";
  elements.pulse.classList.toggle("live", live);
  setText(elements.connection, live ? "Live interpretation" : room.status === "ended" ? "Room ended" : "Waiting for host");
  setText(elements.listenerCount, String(room.listenerCount));
  if (room.status === "ended") {
    shouldConnect = false;
    player.reset();
    elements.current.textContent = "This room has ended.";
  }
}

function handleEvent(event) {
  if (event.type === "session.ready") {
    updateRoom(event.room);
    for (const item of event.history || []) addCaption(item.transcript);
  }
  if (event.type === "room.status" || event.type === "room.ended") updateRoom(event.room);
  if (event.type === "presence") setText(elements.listenerCount, String(event.listenerCount));
  if (event.type === "speaker.status") elements.pulse.classList.toggle("live", event.speaking);
  if (event.type === "transcript.delta") {
    if (activeResponse && activeResponse !== event.responseId) addCaption(activeText);
    if (activeResponse !== event.responseId) activeText = "";
    activeResponse = event.responseId;
    activeText += event.delta;
    elements.current.textContent = activeText;
  }
  if (event.type === "transcript.done") {
    const finalText = event.transcript || activeText;
    addCaption(finalText);
    activeResponse = null;
    activeText = "";
    elements.current.textContent = "Listening…";
  }
  if (event.type === "audio.delta") player.enqueue(event.audio);
  if (event.type === "service.status") setText(elements.connection, event.message);
  if (event.type === "service.error" || event.type === "client.error") showError(event.error);
}

function connect() {
  clearTimeout(reconnectTimer);
  setText(elements.connection, reconnectAttempt ? "Reconnecting…" : "Connecting…");
  socket = new WebSocket(
    webSocketUrl({ room: roomCode, role: "audience", clientId: clientId(`lingua-audience-${roomCode}`) }),
  );
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    socket.send(JSON.stringify({ type: "client.ready" }));
  });
  socket.addEventListener("message", (message) => handleEvent(JSON.parse(message.data)));
  socket.addEventListener("close", () => {
    if (!shouldConnect) return;
    const delay = reconnectDelay(reconnectAttempt++);
    setText(elements.connection, `Reconnecting in ${Math.ceil(delay / 1000)}s…`);
    reconnectTimer = setTimeout(connect, delay);
  });
  socket.addEventListener("error", () => setText(elements.connection, "Connection interrupted"));
}

elements.enableAudio.addEventListener("click", async () => {
  try {
    await player.enable();
    elements.enableAudio.textContent = "Translated audio on";
    elements.enableAudio.disabled = true;
  } catch (error) {
    showError(error);
  }
});

async function initialize() {
  setText(elements.roomCode, roomCode);
  try {
    const payload = await api(`/api/rooms/${roomCode}`);
    updateRoom(payload.room);
    if (payload.room.status !== "ended") connect();
  } catch (error) {
    shouldConnect = false;
    showError(error);
    setText(elements.connection, "Room unavailable");
  }
}

initialize();
