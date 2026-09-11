const params = new URLSearchParams(location.search);
const roomCode = params.get("room")?.trim().toUpperCase();
const meta = document.querySelector("#meta");
const pinPanel = document.querySelector("#pin");
const pinValue = document.querySelector("#pin-value");
const join = document.querySelector("#join");
const caption = document.querySelector("#caption");
let token;
let socket;
let activeText = "";
let activeResponse;
let reconnectAttempt = 0;
let shouldReconnect = true;

function setMeta(text) { meta.textContent = text; meta.classList.remove("hidden"); }
function showCaption(text) { caption.textContent = text || "Listening…"; caption.classList.remove("hidden"); meta.classList.add("hidden"); }
function clientId() {
  const key = `lingua-captions-${roomCode}`;
  let value = sessionStorage.getItem(key);
  if (!value) { value = `obs-${crypto.randomUUID().replaceAll("-", "")}`; sessionStorage.setItem(key, value); }
  return value;
}
async function json(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || "Request failed");
  return body;
}
async function admit(pin) {
  const result = await json(`/api/rooms/${roomCode}/admit`, { method: "POST", body: JSON.stringify({ pin }) });
  token = result.admissionToken;
  pinPanel.classList.add("hidden");
  connect();
}
function connect() {
  const url = new URL("/ws", location.origin); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", roomCode); url.searchParams.set("role", "audience"); url.searchParams.set("clientId", clientId()); if (token) url.searchParams.set("admission", token);
  socket = new WebSocket(url);
  socket.addEventListener("open", () => { reconnectAttempt = 0; setMeta("Connected. Waiting for interpretation…"); socket.send(JSON.stringify({ type: "client.ready" })); });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "room.ended") { shouldReconnect = false; showCaption("Event ended"); socket.close(); }
    if (event.type === "transcript.delta") { if (activeResponse !== event.responseId) { activeResponse = event.responseId; activeText = ""; } activeText += event.delta || ""; showCaption(activeText); }
    if (event.type === "transcript.done") { showCaption(event.transcript || activeText); activeText = ""; activeResponse = null; }
    if (event.type === "service.error") setMeta(event.error?.message || "Interpretation service error");
  });
  socket.addEventListener("close", () => {
    if (!shouldReconnect) return;
    const delay = Math.min(500 * 2 ** reconnectAttempt++, 10000) + Math.random() * 250;
    setMeta(`Reconnecting in ${Math.ceil(delay/1000)}s…`); setTimeout(connect, delay);
  });
}
async function init() {
  if (!roomCode || !/^[A-Z2-9]{6}$/.test(roomCode)) return setMeta("Add ?room=ROOMCODE to this browser source URL.");
  try {
    const status = await json(`/api/rooms/${roomCode}`);
    if (status.room.pinRequired) { pinPanel.classList.remove("hidden"); meta.classList.add("hidden"); return; }
    await admit();
  } catch (error) { setMeta(error.message); }
}
join.addEventListener("click", async () => { try { join.disabled = true; await admit(pinValue.value); } catch (error) { setMeta(error.message); pinPanel.classList.remove("hidden"); join.disabled = false; } });
init();
