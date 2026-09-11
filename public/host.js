import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";

const el = Object.fromEntries([
  "create-panel","room-panel","create-glossary","room-glossary","create-room","start-room","end-room","save-glossary","copy-link","room-code","room-status","invite-link","qr-code","listener-count","service-status","error","event-title","scheduled-at","audience-pin","source-language","target-language","event-summary","source-transcript","translated-transcript","download-transcript"
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]));

let room, hostToken, socket, reconnectTimer, mediaStream, audioContext, captureNode;
let reconnectAttempt = 0;
let shouldConnect = false;
let sourceCurrent = "", targetCurrent = "";

function glossaryFrom(textarea) { return textarea.value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean); }
function showError(error) { el.error.textContent = error?.message || "Something went wrong."; el.error.classList.remove("hidden"); }
function clearError() { el.error.classList.add("hidden"); el.error.textContent = ""; }
function selectedSource() { return document.querySelector('input[name="source"]:checked')?.value || "microphone"; }
function appendLine(container, text) {
  if (!text?.trim()) return;
  const p = document.createElement("p"); p.className = "transcript-line"; p.textContent = text.trim(); container.append(p);
  while (container.children.length > 80) container.firstElementChild.remove();
}

function renderRoom(nextRoom) {
  room = nextRoom;
  el.create_panel.classList.add("hidden");
  el.room_panel.classList.remove("hidden");
  setText(el.room_code, room.code);
  setText(el.listener_count, String(room.listenerCount));
  setText(el.room_status, room.status[0].toUpperCase() + room.status.slice(1));
  el.room_status.dataset.state = room.status;
  setText(el.event_summary, `${room.title || "Lingua Live event"} · ${room.sourceLanguage?.toUpperCase()} → ${room.targetLanguage?.toUpperCase()}`);
  el.start_room.disabled = ["starting","live","ended"].includes(room.status);
  el.end_room.disabled = room.status === "ended";
  el.save_glossary.disabled = room.status === "ended";
  if (room.glossary) el.room_glossary.value = room.glossary.join("\n");
  if (room.status === "ended") { shouldConnect = false; stopCapture(); setText(el.service_status, "This event has ended."); }
  if (hostToken) el.download_transcript.href = `/api/rooms/${room.code}/transcript.csv?download=1`;
}

function invitation(inviteUrl) {
  el.invite_link.href = inviteUrl; el.invite_link.textContent = inviteUrl; el.qr_code.src = `/api/rooms/${room.code}/qr`;
}

function connectSocket() {
  if (!room || !hostToken || room.status === "ended") return;
  clearTimeout(reconnectTimer); shouldConnect = true;
  socket = new WebSocket(webSocketUrl({ room: room.code, role: "host", clientId: clientId(`lingua-host-client-${room.code}`), token: hostToken }));
  socket.addEventListener("open", () => { reconnectAttempt = 0; setText(el.service_status, room.status === "live" ? "Live source connected." : "Host connected. Ready to start."); socket.send(JSON.stringify({ type: "client.ready" })); });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "session.ready") {
      renderRoom(event.room);
      for (const row of event.transcript || []) { appendLine(el.source_transcript, row.source); appendLine(el.translated_transcript, row.translation); }
    }
    if (event.type === "room.status") renderRoom(event.room);
    if (event.type === "presence") setText(el.listener_count, String(event.listenerCount));
    if (event.type === "service.status") setText(el.service_status, event.message);
    if (event.type === "client.error" || event.type === "service.error") showError(event.error);
    if (event.type === "room.ended") renderRoom(event.room);
    if (event.type === "source_transcript.delta") { sourceCurrent += event.delta || ""; setText(el.service_status, `Hearing: ${sourceCurrent.slice(-80)}`); }
    if (event.type === "source_transcript.done") { appendLine(el.source_transcript, event.transcript || sourceCurrent); sourceCurrent = ""; }
    if (event.type === "transcript.delta") { targetCurrent += event.delta || ""; }
    if (event.type === "transcript.done") { appendLine(el.translated_transcript, event.transcript || targetCurrent); targetCurrent = ""; }
  });
  socket.addEventListener("close", (event) => {
    if (!shouldConnect || room?.status === "ended" || event.code === 4001) return;
    stopCapture(); const delay = reconnectDelay(reconnectAttempt++); setText(el.service_status, `Connection lost. Reconnecting in ${Math.ceil(delay/1000)}s…`); reconnectTimer = setTimeout(connectSocket, delay);
  });
  socket.addEventListener("error", () => setText(el.service_status, "Host connection interrupted."));
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let binary = ""; for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]); return btoa(binary);
}

async function startCapture() {
  if (mediaStream) return;
  try {
    if (selectedSource() === "display") {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Browser-tab/system audio capture is not supported by this browser.");
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!mediaStream.getAudioTracks().length) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; throw new Error("No audio track was shared. Choose a browser tab/window with audio sharing enabled."); }
    } else {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
  } catch (error) {
    if (error?.name === "NotAllowedError") throw new Error("Audio permission was denied. Allow microphone/screen audio access and try again.");
    throw error;
  }
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("/pcm-worklet.js"); await audioContext.resume();
  const source = audioContext.createMediaStreamSource(mediaStream); captureNode = new AudioWorkletNode(audioContext, "pcm-capture");
  const silent = audioContext.createGain(); silent.gain.value = 0; source.connect(captureNode).connect(silent).connect(audioContext.destination);
  captureNode.port.onmessage = ({ data }) => { if (socket?.readyState === WebSocket.OPEN && room?.status === "live") socket.send(JSON.stringify({ type: "audio.append", audio: bytesToBase64(data) })); };
}

function stopCapture() {
  captureNode?.disconnect(); captureNode = null; mediaStream?.getTracks().forEach((track) => track.stop()); mediaStream = null; audioContext?.close(); audioContext = null;
}

el.create_room.addEventListener("click", async () => {
  clearError(); el.create_room.disabled = true;
  try {
    const payload = await api("/api/rooms", { method: "POST", body: JSON.stringify({
      title: el.event_title.value,
      scheduledAt: el.scheduled_at.value || null,
      sourceLanguage: el.source_language.value,
      targetLanguage: el.target_language.value,
      audiencePin: el.audience_pin.value || null,
      glossary: glossaryFrom(el.create_glossary),
    }) });
    room = payload.room; hostToken = payload.hostToken; sessionStorage.setItem(`lingua-host-token-${room.code}`, hostToken);
    history.replaceState(null, "", `/host?room=${room.code}`); renderRoom(room); invitation(payload.inviteUrl); connectSocket();
  } catch (error) { showError(error); } finally { el.create_room.disabled = false; }
});

el.start_room.addEventListener("click", async () => {
  clearError(); el.start_room.disabled = true; setText(el.service_status, "Connecting interpretation service…");
  try {
    const payload = await api(`/api/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } });
    renderRoom(payload.room); await startCapture(); setText(el.service_status, selectedSource() === "display" ? "Live tab/system audio connected." : "Live microphone connected.");
  } catch (error) { showError(error); setText(el.service_status, "Ready to start when audio and interpretation are available."); el.start_room.disabled = false; stopCapture(); }
});

el.end_room.addEventListener("click", async () => {
  clearError(); el.end_room.disabled = true;
  try { const payload = await api(`/api/rooms/${room.code}/end`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } }); shouldConnect = false; socket?.close(); stopCapture(); renderRoom(payload.room); }
  catch (error) { showError(error); el.end_room.disabled = false; }
});

el.save_glossary.addEventListener("click", async () => {
  clearError();
  try { const payload = await api(`/api/rooms/${room.code}`, { method: "PATCH", headers: { Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ glossary: glossaryFrom(el.room_glossary) }) }); renderRoom(payload.room); setText(el.service_status, "Glossary updated live."); }
  catch (error) { showError(error); }
});

el.copy_link.addEventListener("click", async () => { try { await navigator.clipboard.writeText(el.invite_link.href); setText(el.service_status, "Invite copied."); } catch { showError(new Error("Could not copy automatically. Select the invite link instead.")); } });

el.download_transcript.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch(`/api/rooms/${room.code}/transcript.csv`, { headers: { Authorization: `Bearer ${hostToken}` } });
    if (!response.ok) throw new Error("Transcript export failed.");
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `lingua-live-${room.code}.csv`; a.click(); URL.revokeObjectURL(url);
  } catch (error) { showError(error); }
});

async function restoreRoom() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase(); if (!code) return;
  hostToken = sessionStorage.getItem(`lingua-host-token-${code}`); if (!hostToken) return showError(new Error("This browser no longer has the host credential for that event. Create a new event."));
  try { const payload = await api(`/api/rooms/${code}`); renderRoom(payload.room); invitation(`${location.origin}/audience/${code}`); connectSocket(); }
  catch (error) { showError(error); }
}
restoreRoom();
