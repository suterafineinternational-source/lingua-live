import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";
import { createNaturalVoiceChain, NATURAL_VOICE_LABEL, scheduleNaturalPcm } from "/natural-voice.js?v=20260915-1";

const el = Object.fromEntries([
  "create-panel","room-panel","create-glossary","room-glossary","create-room","start-room","end-room","save-glossary","copy-link","room-code","room-status","invite-link","qr-code","listener-count","service-status","error","event-title","scheduled-at","audience-pin","source-language","target-language","event-summary","source-transcript","translated-transcript","download-transcript","record-source","download-recording","download-summary","monitor-audio","monitor-status","share-screen","listener-statuses","host-screen-preview","screen-share-status","record-live","download-live-recording","live-recording-status"
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]));

let room, hostToken, socket, reconnectTimer, mediaStream, audioContext, captureNode;
let sourceRecorder, sourceRecordingChunks = [], sourceRecordingBlob;
let reconnectAttempt = 0;
let shouldConnect = false;
let sourceCurrent = "", targetCurrent = "";
let audioChunkCount = 0, nonSilentChunkCount = 0, lastPeak = 0;
let engineStatus = "Host connected. Ready to start.";
let screenStream, screenVideo, screenCanvas, screenTimer;
let screenFramesSent = 0;
const listenerStatuses = new Map();

class PcmMonitor {
  constructor() {
    this.context = null;
    this.voice = null;
    this.nextStart = 0;
    this.enabled = false;
    this.pending = [];
    this.receivedChunks = 0;
    this.scheduledChunks = 0;
  }
  status(text) { if (el.monitor_status) setText(el.monitor_status, text); }
  async enable() {
    if (!window.AudioContext) throw new Error("Web Audio is not supported by this browser.");
    this.context ||= new AudioContext();
    if (!this.voice) this.voice = createNaturalVoiceChain(this.context, this.context.destination, { volume: 1 });
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("Browser audio output is still suspended. Click the button again and allow audio playback.");
    this.enabled = true;
    this.nextStart = Math.max(this.nextStart, this.context.currentTime + 0.055);
    const backlog = this.pending.splice(Math.max(0, this.pending.length - 10));
    this.pending = [];
    for (const chunk of backlog) this.play(chunk);
    this.status(`${NATURAL_VOICE_LABEL} · monitor ON · ${this.receivedChunks} translated chunks received · ${this.scheduledChunks} scheduled`);
  }
  disable() {
    this.enabled = false;
    this.pending = [];
    this.nextStart = this.context?.currentTime || 0;
    this.status(`English monitor OFF · ${this.receivedChunks} translated chunks received this session`);
  }
  enqueue(base64) {
    if (!base64) return;
    this.receivedChunks += 1;
    if (!this.enabled || !this.context || this.context.state !== "running" || !this.voice) {
      this.pending.push(base64);
      if (this.pending.length > 10) this.pending.shift();
      this.status(`English translation audio available · ${this.receivedChunks} chunks received · click “Monitor English audio” to hear it`);
      return;
    }
    this.play(base64);
  }
  play(base64) {
    try {
      const scheduled = scheduleNaturalPcm({ context: this.context, input: this.voice.input, base64, nextStart: this.nextStart });
      this.nextStart = scheduled.nextStart;
      this.scheduledChunks += 1;
      this.status(`${NATURAL_VOICE_LABEL} · monitor ON · ${this.receivedChunks} chunks received · ${this.scheduledChunks} played/scheduled`);
    } catch (error) {
      this.status(`English monitor error: ${error.message}`);
      showError(new Error(`Could not play translated English audio: ${error.message}`));
    }
  }
  reset() {
    this.pending = [];
    this.nextStart = this.context?.currentTime || 0;
    this.receivedChunks = 0;
    this.scheduledChunks = 0;
    this.status("English monitor OFF.");
  }
}
const monitor = new PcmMonitor();

function preferredVideoMimeType() {
  if (!window.MediaRecorder) return "";
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((type) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type)) || "";
}

class LiveProgramRecorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.blob = null;
    this.context = null;
    this.destination = null;
    this.voice = null;
    this.nextStart = 0;
    this.stream = null;
    this.mimeType = "";
    this.stopResolve = null;
  }
  get active() { return this.recorder?.state === "recording" || this.recorder?.state === "paused"; }
  status(text) { if (el.live_recording_status) setText(el.live_recording_status, text); }
  async start(videoStream) {
    if (!window.MediaRecorder) throw new Error("Video recording is not supported by this browser.");
    const videoTrack = videoStream?.getVideoTracks?.()[0];
    if (!videoTrack || videoTrack.readyState === "ended") throw new Error("A live screen/video track is required before recording can start.");
    if (!window.AudioContext) throw new Error("Web Audio is required to record the translated English audio.");

    this.chunks = [];
    this.blob = null;
    this.mimeType = preferredVideoMimeType();
    if (el.download_live_recording) el.download_live_recording.classList.add("hidden");

    this.context = new AudioContext();
    this.destination = this.context.createMediaStreamDestination();
    this.voice = createNaturalVoiceChain(this.context, this.destination, { volume: 1 });
    await this.context.resume();
    this.nextStart = this.context.currentTime + 0.055;

    const recordedVideoTrack = videoTrack.clone();
    const programAudioTracks = this.destination.stream.getAudioTracks();
    this.stream = new MediaStream([recordedVideoTrack, ...programAudioTracks]);
    const options = this.mimeType ? { mimeType: this.mimeType, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 128_000 } : undefined;
    this.recorder = new MediaRecorder(this.stream, options);
    this.recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) this.chunks.push(event.data); });
    this.recorder.addEventListener("error", (event) => {
      const message = event.error?.message || "Live recording failed.";
      this.status(`Recording error: ${message}`);
      showError(new Error(message));
    });
    this.recorder.addEventListener("stop", () => this.finalize(), { once: true });
    recordedVideoTrack.addEventListener("ended", () => { if (this.active) void stopLiveProgramRecording(); }, { once: true });
    this.recorder.start(1000);
    this.status("RECORDING LIVE · shared video + Natural Voice English audio · stored locally in this browser");
  }
  enqueue(base64) {
    if (!this.active || !this.context || this.context.state !== "running" || !this.voice || !base64) return;
    try {
      const scheduled = scheduleNaturalPcm({ context: this.context, input: this.voice.input, base64, nextStart: this.nextStart });
      this.nextStart = scheduled.nextStart;
    } catch (error) {
      this.status(`Recording audio warning: ${error.message}`);
    }
  }
  stop() {
    if (!this.active) return Promise.resolve(this.blob);
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      this.status("Finalizing live video recording…");
      this.recorder.stop();
    });
  }
  finalize() {
    if (this.chunks.length) {
      const type = this.recorder?.mimeType || this.mimeType || "video/webm";
      this.blob = new Blob(this.chunks, { type });
      if (el.download_live_recording) el.download_live_recording.classList.remove("hidden");
      this.status(`Recording ready · ${(this.blob.size / (1024 * 1024)).toFixed(1)} MB · video + translated English audio`);
    } else {
      this.status("Recording stopped, but the browser did not return media data.");
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context && this.context.state !== "closed") void this.context.close();
    this.context = null;
    this.destination = null;
    this.voice = null;
    this.nextStart = 0;
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.recorder = null;
    if (el.record_live) el.record_live.textContent = "Start live video recording";
    resolve?.(this.blob);
  }
}
const liveProgramRecorder = new LiveProgramRecorder();

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
  setText(el.event_summary, `${room.title || "Lingua Live event"} · ${room.sourceLanguage?.toUpperCase()} → ${room.targetLanguage?.toUpperCase()} · no application participant cap`);
  el.start_room.disabled = ["starting","live","ended"].includes(room.status); el.end_room.disabled = room.status === "ended"; el.save_glossary.disabled = room.status === "ended";
  if (room.glossary) el.room_glossary.value = room.glossary.join("\n");
  if (room.status === "ended") {
    shouldConnect = false;
    stopCapture();
    if (liveProgramRecorder.active) void stopLiveProgramRecording();
    stopScreenShare();
    monitor.reset();
    setText(el.service_status, "This event has ended.");
  }
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
    if (event.type === "audio.delta") { monitor.enqueue(event.audio); liveProgramRecorder.enqueue(event.audio); }
    if (event.type === "listener.status") { listenerStatuses.set(event.clientId, event); renderListenerStatuses(); }
  });
  socket.addEventListener("close", (event) => {
    if (!shouldConnect || room?.status === "ended" || event.code === 4001) return;
    stopCapture(); const delay = reconnectDelay(reconnectAttempt++); engineStatus = `Host relay disconnected. Reconnecting in ${Math.ceil(delay/1000)}s…`; renderLiveDiagnostic(); reconnectTimer = setTimeout(connectSocket, delay);
  });
  socket.addEventListener("error", () => { engineStatus = "Host relay connection interrupted"; renderLiveDiagnostic(); });
}

function bytesToBase64(buffer) { const bytes = new Uint8Array(buffer); let binary = ""; for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); }

function beginSourceRecording() {
  sourceRecordingBlob = null; sourceRecordingChunks = []; el.download_recording.classList.add("hidden");
  if (!el.record_source.checked || !mediaStream || !window.MediaRecorder) return;
  const audioOnly = new MediaStream(mediaStream.getAudioTracks()); if (!audioOnly.getAudioTracks().length) return;
  try {
    sourceRecorder = new MediaRecorder(audioOnly);
    sourceRecorder.addEventListener("dataavailable", (event) => { if (event.data?.size) sourceRecordingChunks.push(event.data); });
    sourceRecorder.addEventListener("stop", () => { if (!sourceRecordingChunks.length) return; sourceRecordingBlob = new Blob(sourceRecordingChunks, { type: sourceRecorder.mimeType || "audio/webm" }); el.download_recording.classList.remove("hidden"); });
    sourceRecorder.start(1000);
  } catch (error) { sourceRecorder = null; showError(new Error(`Local source recording could not start: ${error.message}`)); }
}

function encodedFrame(video, canvas) {
  const attempts = [
    { width: 900, quality: 0.5 },
    { width: 760, quality: 0.44 },
    { width: 640, quality: 0.38 },
  ];
  let image = "";
  for (const attempt of attempts) {
    const ratio = (video.videoHeight || 540) / (video.videoWidth || 960);
    canvas.width = attempt.width;
    canvas.height = Math.max(240, Math.round(attempt.width * ratio));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    image = canvas.toDataURL("image/jpeg", attempt.quality);
    if (image.length < 560000) break;
  }
  return image;
}

async function prepareScreenRelay(stream) {
  if (!stream?.getVideoTracks().length) throw new Error("No video track is available to share.");
  stopScreenRelayOnly();
  screenStream = stream;
  screenFramesSent = 0;
  screenVideo = document.createElement("video");
  screenVideo.muted = true;
  screenVideo.playsInline = true;
  screenVideo.srcObject = new MediaStream(stream.getVideoTracks());
  await screenVideo.play();
  screenCanvas = document.createElement("canvas");
  el.share_screen.textContent = "Stop screen sharing";

  const sendFrame = () => {
    if (!screenVideo || !screenCanvas) return;
    if (screenVideo.readyState < 2) { setText(el.screen_share_status, "Screen selected · waiting for video frames…"); return; }
    const image = encodedFrame(screenVideo, screenCanvas);
    el.host_screen_preview.src = image;
    el.host_screen_preview.classList.remove("hidden");
    if (!socket || socket.readyState !== WebSocket.OPEN) { setText(el.screen_share_status, "Screen preview ready · host relay is reconnecting…"); return; }
    if (!room || room.status !== "live") { setText(el.screen_share_status, "Screen preview ready · start interpretation to send it to the audience."); return; }
    if (!image || image.length >= 600000) { setText(el.screen_share_status, "Screen frame is still too large to relay. Try sharing a browser tab or smaller window."); return; }
    socket.send(JSON.stringify({ type: "screen.frame", image }));
    screenFramesSent += 1;
    setText(el.screen_share_status, `Screen sharing LIVE · ${screenFramesSent} frames sent to the audience · ${Math.round(image.length / 1024)} KB/frame`);
  };
  sendFrame();
  screenTimer = setInterval(sendFrame, 650);
  screenTimer.unref?.();
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (liveProgramRecorder.active) void stopLiveProgramRecording();
    stopScreenShare();
  }, { once: true });
}
function stopScreenRelayOnly() {
  clearInterval(screenTimer); screenTimer = null;
  if (screenVideo) { screenVideo.pause(); screenVideo.srcObject = null; }
  screenVideo = null; screenCanvas = null;
  el.host_screen_preview.classList.add("hidden");
}
function stopScreenShare() {
  stopScreenRelayOnly();
  if (screenStream && screenStream !== mediaStream) screenStream.getTracks().forEach((track) => track.stop());
  screenStream = null;
  screenFramesSent = 0;
  el.share_screen.textContent = "Share screen to audience";
  setText(el.screen_share_status, "Not sharing yet.");
}

async function ensureScreenForLiveRecording() {
  const current = screenStream?.getVideoTracks?.()[0];
  if (current && current.readyState !== "ended") return screenStream;
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture is not supported by this browser.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  if (!stream.getVideoTracks().length) { stream.getTracks().forEach((track) => track.stop()); throw new Error("No screen/video track was shared."); }
  await prepareScreenRelay(stream);
  return stream;
}

async function stopLiveProgramRecording() {
  const blob = await liveProgramRecorder.stop();
  if (el.record_live) el.record_live.textContent = "Start live video recording";
  return blob;
}

async function startCapture() {
  if (mediaStream) return;
  try {
    if (selectedSource() === "display") {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Browser-tab/system audio capture is not supported by this browser.");
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!mediaStream.getAudioTracks().length) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; throw new Error("No audio track was shared. For Zoom/Google Meet choose the meeting tab and enable Share tab audio."); }
    } else {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    }
  } catch (error) {
    if (error?.name === "NotAllowedError") throw new Error("Audio permission was denied. Allow microphone/screen audio access and try again.");
    throw error;
  }
  audioChunkCount = 0; nonSilentChunkCount = 0; lastPeak = 0; beginSourceRecording();
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
  if (sourceRecorder?.state === "recording") sourceRecorder.stop(); sourceRecorder = null; captureNode?.disconnect(); captureNode = null;
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
    const payload = await api(`/api/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } }); renderRoom(payload.room); engineStatus = `${NATURAL_VOICE_LABEL} · English interpretation connected; listening for speech`; renderLiveDiagnostic();
  } catch (error) { showError(error); engineStatus = error?.message || "Could not start interpretation"; renderLiveDiagnostic(); el.start_room.disabled = false; stopCapture(); }
});

el.monitor_audio.addEventListener("click", async () => {
  clearError();
  try {
    if (monitor.enabled) {
      monitor.disable();
      el.monitor_audio.textContent = "Monitor English audio";
      return;
    }
    await monitor.enable();
    el.monitor_audio.textContent = "Turn English monitor OFF";
  } catch (error) { showError(new Error(`Could not enable English monitor: ${error.message}`)); }
});

el.share_screen.addEventListener("click", async () => {
  clearError();
  try {
    if (screenStream) {
      if (liveProgramRecorder.active) await stopLiveProgramRecording();
      stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing is not supported by this browser.");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (!stream.getVideoTracks().length) { stream.getTracks().forEach((track) => track.stop()); throw new Error("No screen/video track was shared."); }
    await prepareScreenRelay(stream);
  } catch (error) { showError(error); setText(el.screen_share_status, `Screen sharing error: ${error.message}`); }
});

el.record_live?.addEventListener("click", async () => {
  clearError();
  try {
    if (liveProgramRecorder.active) {
      await stopLiveProgramRecording();
      return;
    }
    if (!room || room.status !== "live") throw new Error("Start interpretation before recording the live program.");
    const videoStream = await ensureScreenForLiveRecording();
    await liveProgramRecorder.start(videoStream);
    el.record_live.textContent = "Stop live video recording";
  } catch (error) {
    showError(new Error(`Could not start live video recording: ${error.message}`));
    liveProgramRecorder.status(`Recording unavailable: ${error.message}`);
  }
});

el.download_live_recording?.addEventListener("click", () => {
  const blob = liveProgramRecorder.blob;
  if (!blob) return;
  const extension = blob.type.includes("mp4") ? "mp4" : "webm";
  downloadBlob(blob, `lingua-live-${room?.code || "event"}-audience-program.${extension}`);
});

el.end_room.addEventListener("click", async () => {
  clearError(); el.end_room.disabled = true;
  try {
    if (liveProgramRecorder.active) await stopLiveProgramRecording();
    const payload = await api(`/api/rooms/${room.code}/end`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } }); shouldConnect = false; socket?.close(); stopCapture(); stopScreenShare(); renderRoom(payload.room);
  }
  catch (error) { showError(error); el.end_room.disabled = false; }
});

el.save_glossary.addEventListener("click", async () => {
  clearError(); try { const payload = await api(`/api/rooms/${room.code}`, { method: "PATCH", headers: { Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ glossary: glossaryFrom(el.room_glossary) }) }); renderRoom(payload.room); engineStatus = "Glossary updated"; renderLiveDiagnostic(); }
  catch (error) { showError(error); }
});
el.copy_link.addEventListener("click", async () => { try { await navigator.clipboard.writeText(el.invite_link.href); engineStatus = "Invite copied"; renderLiveDiagnostic(); } catch { showError(new Error("Could not copy automatically. Select the invite link instead.")); } });
el.download_transcript.addEventListener("click", async (event) => { event.preventDefault(); try { const response = await fetch(`/api/rooms/${room.code}/transcript.csv`, { headers: { Authorization: `Bearer ${hostToken}` } }); if (!response.ok) throw new Error("Transcript export failed."); downloadBlob(await response.blob(), `lingua-live-${room.code}.csv`); } catch (error) { showError(error); } });
el.download_summary.addEventListener("click", async () => { try { const response = await fetch(`/api/rooms/${room.code}/summary`, { headers: { Authorization: `Bearer ${hostToken}` } }); if (!response.ok) throw new Error("Event summary export failed."); const body = await response.json(); downloadBlob(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `lingua-live-${room.code}-summary.json`); } catch (error) { showError(error); } });
el.download_recording.addEventListener("click", () => { if (!sourceRecordingBlob) return; const extension = sourceRecordingBlob.type.includes("ogg") ? "ogg" : sourceRecordingBlob.type.includes("mp4") ? "m4a" : "webm"; downloadBlob(sourceRecordingBlob, `lingua-live-${room?.code || "event"}-source.${extension}`); });

async function restoreRoom() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase(); if (!code) return;
  hostToken = sessionStorage.getItem(`lingua-host-token-${code}`); if (!hostToken) return showError(new Error("This browser no longer has the host credential for that event. Create a new event."));
  try { const payload = await api(`/api/rooms/${code}`); renderRoom(payload.room); invitation(`${location.origin}/audience/${code}`); connectSocket(); }
  catch (error) { showError(error); }
}
restoreRoom();
