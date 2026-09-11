import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";

const el = Object.fromEntries([
  "create-panel","room-panel","create-glossary","room-glossary","create-room","start-room","end-room","save-glossary","copy-link","room-code","room-status","invite-link","qr-code","listener-count","service-status","error","event-title","scheduled-at","audience-pin","source-language","target-language","event-summary","source-transcript","translated-transcript","download-transcript","record-source","download-recording","download-summary","monitor-audio","share-screen","listener-statuses","host-screen-preview","screen-share-status"
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]));

let room, hostToken, socket, reconnectTimer, mediaStream, audioContext, captureNode;
let recorder, recordingChunks = [], recordingBlob;
let reconnectAttempt = 0;
let shouldConnect = false;
let sourceCurrent = "", targetCurrent = "";
let audioChunkCount = 0, nonSilentChunkCount = 0, lastPeak = 0;
let engineStatus = "Host connected. Ready to start.";
let screenStream, screenVideo, screenCanvas, screenTimer;
const listenerStatuses = new Map();

class PcmMonitor {
  constructor() { this.context = null; this.gain = null; this.nextStart = 0; this.enabled = false; this.pending = []; }
  async enable() {
    this.context ||= new AudioContext({ sampleRate: 24000 });
    this.gain ||= this.context.createGain();
    if (!this.gain.context) return;
    this.gain.gain.value = 1;
    if (!this.gain.numberOfOutputs) this.gain.connect(this.context.destination);
    else {
      try { this.gain.connect(this.context.destination); } catch {}
    }
    await this.context.resume();
    this.enabled = true;
    for (const chunk of this.pending.splice(0)) this.play(chunk);
  }
  enqueue(base64) {
    if (!this.enabled || !this.context || this.context.state !== "running") {
      this.pending.push(base64);
      if (this.pending.length > 30) this.pending.shift();
      return;
    }
    this.play(base64);
  }
  play(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);
    const buffer = this.context.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    const start = Math.max(this.context.currentTime + 0.02, this.nextStart); source.start(start); this.nextStart = start + buffer.duration;
  }
  reset() { this.pending = []; this.nextStart = this.context?.currentTime || 0; }
}
const monitor = new PcmMonitor();

function glossaryFrom(textarea) { return textarea.value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean); }
function showError(error) { el.error.textContent = error?.message || "Something went wrong."; el.error.classList.remove("hidden"); }
function clearError() { el.error.classList.add("hidden"); el.error.textContent = ""; }
function selectedSource() { return document.querySelector('input[name="source"]:checked')?.value || "microphone"; }
function appendLine(container, text) {
  if (!text?.trim()) return;
  const placeholder = container.querySelector(".meta"); if (placeholder) placeholder.remove();
  const p = document.createElement("p"); p.className = "transcript-line"; p.textContent = text.trim(); container.append(p);
  while (container.children.length > 80) container.firstElementChild.remove();
  container.scrollTop = container.scrollHeight;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function peakPercent(buffer) {
  const pcm = new Int16Array(buffer); let max = 0; for (let i = 0; i < pcm.length; i += 1) max = Math.max(max, Math.abs(pcm[i]));
  return Math.min(100, Math.round((max / 32768) * 100));
}
function renderLiveDiagnostic() {
  if (!mediaStream) return setText(el.service_status, engineStatus);
  if (!audioChunkCount) return setText(el.service_status, `${engineStatus} · Waiting for audio samples…`);
  if (lastPeak <= 1 && audioChunkCount > 10) return setText(el.service_status, `${engineStatus} · Audio stream connected, but level is near zero (${lastPeak}%). Check the selected microphone/tab.`);
  setText(el.service_status, `${engineStatus} · Input ${lastPeak}% · ${audioChunkCount} chunks sent · ${nonSilentChunkCount} with speech signal`);
}
function renderListenerStatuses() {
  el.listener_statuses.innerHTML = "";
  const rows = [...listenerStatuses.entries()];
  if (!rows.length) { const p = document.createElement("p"); p.className = "meta"; p.textContent = "No guest playback telemetry yet."; el.listener_statuses.append(p); return; }
  for (const [id, status] of rows) {
    const p = document.createElement("p"); p.className = "transcript-line";
    if (status.disconnected) p.textContent = `${id.slice(-6)} · disconnected`;
    else p.textContent = `${id.slice(-6)} · audio ${status.audioEnabled ? "ON" : "OFF"} · ${status.playedChunks || 0} translated chunks played · volume ${Math.round((status.volume ?? 1) * 100)}%${status.lastPlaybackAt ? ` · last ${new Date(status.lastPlaybackAt).toLocaleTimeString()}` : ""}`;
    el.listener_statuses.append(p);
  }
}

function renderRoom(nextRoom) {
  room = nextRoom; el.create_panel.classList.add("hidden"); el.room_panel.classList.remove("hidden");
  setText(el.room_code, room.code); setText(el.listener_count, String(room.listenerCount)); setText(el.room_status, room.status[0].toUpperCase() + room.status.slice(1)); el.room_status.dataset.state = room.status;
  setText(el.event_summary, `${room.title || "Lingua Live event"} · ${room.sourceLanguage?.toUpperCase()} → ${room.targetLanguage?.toUpperCase()}`);
  el.start_room.disabled = ["starting","live","ended"].includes(room.status); el.end_room.disabled = room.status === "ended"; el.save_glossary.disabled = room.status === "ended";
  if (room.glossary) el.room_glossary.value = room.glossary.join("\n");
  if (room.status === "ended") { shouldConnect = false; stopCapture(); stopScreenShare(); monitor.reset(); setText(el.service_status, "This event has ended."); }
  if (hostToken) el.download_transcript.href = `/api/rooms/${room.code}/transcript.csv?download=1`;
}
function invitation(inviteUrl) { el.invite_link.href = inviteUrl; el.invite_link.textContent = inviteUrl; el.qr_code.src = `/api/rooms/${room.code}/qr`; }

function connectSocket() {
  if (!room || !hostToken || room.status === "ended") return;
  clearTimeout(reconnectTimer); shouldConnect = true;
  socket = new WebSocket(webSocketUrl({ room: room.code, role: "host", clientId: clientId(`lingua-host-client-${room.code}`), token: hostToken }));
  socket.addEventListener("open", () => { reconnectAttempt = 0; engineStatus = room.status === "live" ? "Host relay connected" : "Host connected. Ready to start."; renderLiveDiagnostic(); socket.send(JSON.stringify({ type: "client.ready" })); });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "session.ready") { renderRoom(event.room); for (const row of event.transcript || []) { appendLine(el.source_transcript, row.source); appendLine(el.translated_transcript, row.translation); } }
    if (event.type === "room.status") renderRoom(event.room);
    if (event.type === "presence") setText(el.listener_count, String(event.listenerCount));
    if (event.type === "service.status") { engineStatus = event.message || "Interpretation service connected"; renderLiveDiagnostic(); }
    if (event.type === "client.error" || event.type === "service.error") { showError(event.error); engineStatus = event.error?.message || "Interpretation error"; renderLiveDiagnostic(); }
    if (event.type === "room.ended") renderRoom(event.room);
    if (event.type === "speaker.status" && event.speaking) { engineStatus = "Translation engine detects speech"; renderLiveDiagnostic(); }
    if (event.type === "source_transcript.delta") { sourceCurrent += event.delta || ""; setText(el.service_status, `HEARD: ${sourceCurrent.slice(-120)}`); }
    if (event.type === "source_transcript.done") { appendLine(el.source_transcript, event.transcript || sourceCurrent); sourceCurrent = ""; engineStatus = "Source speech transcribed"; renderLiveDiagnostic(); }
    if (event.type === "transcript.delta") { targetCurrent += event.delta || ""; if (targetCurrent) setText(el.service_status, `TRANSLATING: ${targetCurrent.slice(-120)}`); }
    if (event.type === "transcript.done") { appendLine(el.translated_transcript, event.transcript || targetCurrent); targetCurrent = ""; engineStatus = "Translation received"; renderLiveDiagnostic(); }
    if (event.type === "audio.delta") monitor.enqueue(event.audio);
    if (event.type === "listener.status") { listenerStatuses.set(event.clientId, event); renderListenerStatuses(); }
  });
  socket.addEventListener("close", (event) => {
    if (!shouldConnect || room?.status === "ended" || event.code === 4001) return;
    stopCapture(); const delay = reconnectDelay(reconnectAttempt++); engineStatus = `Host relay disconnected. Reconnecting in ${Math.ceil(delay/1000)}s…`; renderLiveDiagnostic(); reconnectTimer = setTimeout(connectSocket, delay);
  });
  socket.addEventListener("error", () => { engineStatus = "Host relay connection interrupted"; renderLiveDiagnostic(); });
}

function bytesToBase64(buffer) { const bytes = new Uint8Array(buffer); let binary = ""; for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); }

function beginRecording() {
  recordingBlob = null; recordingChunks = []; el.download_recording.classList.add("hidden");
  if (!el.record_source.checked || !mediaStream || !window.MediaRecorder) return;
  const audioOnly = new MediaStream(mediaStream.getAudioTracks()); if (!audioOnly.getAudioTracks().length) return;
  try {
    recorder = new MediaRecorder(audioOnly);
    recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) recordingChunks.push(event.data); });
    recorder.addEventListener("stop", () => { if (!recordingChunks.length) return; recordingBlob = new Blob(recordingChunks, { type: recorder.mimeType || "audio/webm" }); el.download_recording.classList.remove("hidden"); });
    recorder.start(1000);
  } catch (error) { recorder = null; showError(new Error(`Local recording could not start: ${error.message}`)); }
}

async function prepareScreenRelay(stream) {
  if (!stream?.getVideoTracks().length) return;
  stopScreenRelayOnly();
  screenStream = stream;
  screenVideo = document.createElement("video"); screenVideo.muted = true; screenVideo.playsInline = true; screenVideo.srcObject = new MediaStream(stream.getVideoTracks()); await screenVideo.play();
  screenCanvas = document.createElement("canvas");
  const sendFrame = () => {
    if (!screenVideo || !socket || socket.readyState !== WebSocket.OPEN || !room || room.status !== "live") return;
    const width = 960; const ratio = (screenVideo.videoHeight || 540) / (screenVideo.videoWidth || 960); screenCanvas.width = width; screenCanvas.height = Math.max(320, Math.round(width * ratio));
    const ctx = screenCanvas.getContext("2d"); ctx.drawImage(screenVideo, 0, 0, screenCanvas.width, screenCanvas.height);
    const image = screenCanvas.toDataURL("image/jpeg", 0.62); el.host_screen_preview.src = image; el.host_screen_preview.classList.remove("hidden"); setText(el.screen_share_status, "Sharing webinar screen live to audience.");
    if (image.length < 640000) socket.send(JSON.stringify({ type: "screen.frame", image }));
  };
  sendFrame(); screenTimer = setInterval(sendFrame, 900); screenTimer.unref?.();
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopScreenRelayOnly());
}
function stopScreenRelayOnly() {
  clearInterval(screenTimer); screenTimer = null;
  if (screenVideo) { screenVideo.pause(); screenVideo.srcObject = null; }
  screenVideo = null; screenCanvas = null; el.host_screen_preview.classList.add("hidden"); setText(el.screen_share_status, "Not sharing yet.");
}
function stopScreenShare() {
  stopScreenRelayOnly();
  if (screenStream && screenStream !== mediaStream) screenStream.getTracks().forEach((track) => track.stop());
  screenStream = null;
}

async function startCapture() {
  if (mediaStream) return;
  try {
    if (selectedSource() === "display") {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Browser-tab/system audio capture is not supported by this browser.");
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!mediaStream.getAudioTracks().length) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; throw new Error("No audio track was shared. For Zoom/Google Meet choose the meeting tab and enable Share tab audio."); }
    } else {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
  } catch (error) {
    if (error?.name === "NotAllowedError") throw new Error("Audio permission was denied. Allow microphone/screen audio access and try again.");
    throw error;
  }
  audioChunkCount = 0; nonSilentChunkCount = 0; lastPeak = 0; beginRecording();
  audioContext = new AudioContext(); await audioContext.audioWorklet.addModule("/pcm-worklet.js"); await audioContext.resume();
  const source = audioContext.createMediaStreamSource(mediaStream); captureNode = new AudioWorkletNode(audioContext, "pcm-capture"); const silent = audioContext.createGain(); silent.gain.value = 0; source.connect(captureNode).connect(silent).connect(audioContext.destination);
  captureNode.port.onmessage = ({ data }) => {
    audioChunkCount += 1; lastPeak = peakPercent(data); if (lastPeak > 2) nonSilentChunkCount += 1;
    if (socket?.readyState === WebSocket.OPEN && room?.status === "live") socket.send(JSON.stringify({ type: "audio.append", audio: bytesToBase64(data) }));
    if (audioChunkCount === 1 || audioChunkCount % 5 === 0) renderLiveDiagnostic();
  };
  if (selectedSource() === "display") await prepareScreenRelay(mediaStream);
  renderLiveDiagnostic();
}
function stopCapture() {
  if (recorder?.state === "recording") recorder.stop(); recorder = null; captureNode?.disconnect(); captureNode = null;
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop()); mediaStream = null; audioContext?.close(); audioContext = null;
}

el.create_room.addEventListener("click", async () => {
  clearError(); el.create_room.disabled = true;
  try {
    const payload = await api("/api/rooms", { method: "POST", body: JSON.stringify({ title: el.event_title.value, scheduledAt: el.scheduled_at.value || null, sourceLanguage: el.source_language.value, targetLanguage: el.target_language.value, audiencePin: el.audience_pin.value || null, glossary: glossaryFrom(el.create_glossary) }) });
    room = payload.room; hostToken = payload.hostToken; sessionStorage.setItem(`lingua-host-token-${room.code}`, hostToken); history.replaceState(null, "", `/host?room=${room.code}`); renderRoom(room); invitation(payload.inviteUrl); connectSocket();
  } catch (error) { showError(error); } finally { el.create_room.disabled = false; }
});

el.start_room.addEventListener("click", async () => {
  clearError(); el.start_room.disabled = true; engineStatus = "Requesting audio source…"; renderLiveDiagnostic();
  try {
    await startCapture(); engineStatus = "Connecting translation engine…"; renderLiveDiagnostic();
    const payload = await api(`/api/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } }); renderRoom(payload.room); engineStatus = "Professional English interpretation connected; listening for speech"; renderLiveDiagnostic();
  } catch (error) { showError(error); engineStatus = error?.message || "Could not start interpretation"; renderLiveDiagnostic(); el.start_room.disabled = false; stopCapture(); }
});

el.monitor_audio.addEventListener("click", async () => {
  try { await monitor.enable(); el.monitor_audio.textContent = "English monitor ON"; el.monitor_audio.disabled = true; }
  catch (error) { showError(new Error(`Could not enable English monitor: ${error.message}`)); }
});

el.share_screen.addEventListener("click", async () => {
  clearError();
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing is not supported by this browser.");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (!stream.getVideoTracks().length) throw new Error("No screen/video track was shared.");
    if (screenStream && screenStream !== mediaStream) screenStream.getTracks().forEach((track) => track.stop());
    await prepareScreenRelay(stream); screenStream = stream; el.share_screen.textContent = "Screen sharing ON";
  } catch (error) { showError(error); }
});

el.end_room.addEventListener("click", async () => {
  clearError(); el.end_room.disabled = true;
  try { const payload = await api(`/api/rooms/${room.code}/end`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } }); shouldConnect = false; socket?.close(); stopCapture(); stopScreenShare(); renderRoom(payload.room); }
  catch (error) { showError(error); el.end_room.disabled = false; }
});

el.save_glossary.addEventListener("click", async () => {
  clearError(); try { const payload = await api(`/api/rooms/${room.code}`, { method: "PATCH", headers: { Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ glossary: glossaryFrom(el.room_glossary) }) }); renderRoom(payload.room); engineStatus = "Glossary updated"; renderLiveDiagnostic(); }
  catch (error) { showError(error); }
});
el.copy_link.addEventListener("click", async () => { try { await navigator.clipboard.writeText(el.invite_link.href); engineStatus = "Invite copied"; renderLiveDiagnostic(); } catch { showError(new Error("Could not copy automatically. Select the invite link instead.")); } });
el.download_transcript.addEventListener("click", async (event) => { event.preventDefault(); try { const response = await fetch(`/api/rooms/${room.code}/transcript.csv`, { headers: { Authorization: `Bearer ${hostToken}` } }); if (!response.ok) throw new Error("Transcript export failed."); downloadBlob(await response.blob(), `lingua-live-${room.code}.csv`); } catch (error) { showError(error); } });
el.download_summary.addEventListener("click", async () => { try { const response = await fetch(`/api/rooms/${room.code}/summary`, { headers: { Authorization: `Bearer ${hostToken}` } }); if (!response.ok) throw new Error("Event summary export failed."); const body = await response.json(); downloadBlob(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `lingua-live-${room.code}-summary.json`); } catch (error) { showError(error); } });
el.download_recording.addEventListener("click", () => { if (!recordingBlob) return; const extension = recordingBlob.type.includes("ogg") ? "ogg" : recordingBlob.type.includes("mp4") ? "m4a" : "webm"; downloadBlob(recordingBlob, `lingua-live-${room?.code || "event"}-source.${extension}`); });

async function restoreRoom() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase(); if (!code) return;
  hostToken = sessionStorage.getItem(`lingua-host-token-${code}`); if (!hostToken) return showError(new Error("This browser no longer has the host credential for that event. Create a new event."));
  try { const payload = await api(`/api/rooms/${code}`); renderRoom(payload.room); invitation(`${location.origin}/audience/${code}`); connectSocket(); }
  catch (error) { showError(error); }
}
restoreRoom();
