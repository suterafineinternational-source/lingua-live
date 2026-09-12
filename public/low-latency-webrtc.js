const TRANSLATION_CALL_URL = "https://api.openai.com/v1/realtime/translations/calls";
const nativeFetch = window.fetch.bind(window);
const NativeWebSocket = window.WebSocket;
const originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);

let sourceStream = null;
let sourceType = "microphone";
let hostSocket = null;
let peerConnection = null;
let dataChannel = null;
let relayContext = null;
let relaySource = null;
let relayNode = null;
let relaySilent = null;
let directActive = false;
let connectingDirect = false;
let firstSourceAudioAt = 0;
let firstTranslatedTextAt = 0;
let firstTranslatedAudioAt = 0;

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function hostSend(payload) {
  if (hostSocket?.readyState === WebSocket.OPEN) hostSocket.send(JSON.stringify(payload));
}

function noteLatency(kind) {
  const now = performance.now();
  if (kind === "source" && !firstSourceAudioAt) firstSourceAudioAt = now;
  if (kind === "text" && !firstTranslatedTextAt) {
    firstTranslatedTextAt = now;
    if (firstSourceAudioAt) console.info(`[Lingua] WebRTC first translated text after ${Math.round(now - firstSourceAudioAt)} ms`);
  }
  if (kind === "audio" && !firstTranslatedAudioAt) {
    firstTranslatedAudioAt = now;
    if (firstSourceAudioAt) console.info(`[Lingua] WebRTC first translated audio after ${Math.round(now - firstSourceAudioAt)} ms`);
  }
}

function resetLatency() {
  firstSourceAudioAt = 0;
  firstTranslatedTextAt = 0;
  firstTranslatedAudioAt = 0;
}

function normalizeRealtimeEvent(event) {
  switch (event.type) {
    case "session.input_transcript.delta":
      return { type: "source_transcript.delta", itemId: event.item_id, delta: event.delta || event.text || "" };
    case "session.input_transcript.done":
    case "session.input_transcript.completed":
      return { type: "source_transcript.done", itemId: event.item_id, transcript: event.transcript ?? event.text ?? "" };
    case "session.output_transcript.delta":
      return { type: "transcript.delta", responseId: event.response_id ?? event.session_id, itemId: event.item_id, delta: event.delta || event.text || "" };
    case "session.output_transcript.done":
    case "session.output_transcript.completed":
      return { type: "transcript.done", responseId: event.response_id ?? event.session_id, itemId: event.item_id, transcript: event.transcript ?? event.text ?? "" };
    case "error":
      return { type: "service.error", error: { code: event.error?.code || "INTERPRETATION_SERVICE_ERROR", message: event.error?.message || "Realtime Translation reported an error.", retriable: event.error?.type === "server_error" } };
    default:
      return null;
  }
}

async function relayTranslatedTrack(stream) {
  if (!stream?.getAudioTracks().length) throw new Error("OpenAI WebRTC connected without a translated audio track.");
  noteLatency("audio");
  relayContext = new AudioContext();
  await relayContext.audioWorklet.addModule("/translated-relay-worklet.js?v=20260912-1");
  await relayContext.resume();
  relaySource = relayContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  relayNode = new AudioWorkletNode(relayContext, "translated-relay");
  relaySilent = relayContext.createGain();
  relaySilent.gain.value = 0;
  relaySource.connect(relayNode).connect(relaySilent).connect(relayContext.destination);
  relayNode.port.onmessage = ({ data }) => {
    if (!directActive) return;
    hostSend({ type: "translation.audio", audio: bytesToBase64(data), sampleRate: 24000 });
  };
}

function handleRealtimeEvent({ data }) {
  let event;
  try { event = JSON.parse(data); } catch { return; }
  if (event.type === "session.output_transcript.delta") noteLatency("text");
  const normalized = normalizeRealtimeEvent(event);
  if (normalized) hostSend({ type: "translation.event", event: normalized });
}

async function cleanupDirect() {
  directActive = false;
  connectingDirect = false;
  try { dataChannel?.close(); } catch {}
  dataChannel = null;
  try { peerConnection?.close(); } catch {}
  peerConnection = null;
  try { relayNode?.disconnect(); } catch {}
  try { relaySource?.disconnect(); } catch {}
  try { relaySilent?.disconnect(); } catch {}
  relayNode = null;
  relaySource = null;
  relaySilent = null;
  if (relayContext && relayContext.state !== "closed") {
    try { await relayContext.close(); } catch {}
  }
  relayContext = null;
}

async function requestJson(url, init) {
  const response = await nativeFetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status}).`);
  return { response, body };
}

async function connectDirectTranslation({ roomCode, authorization }) {
  if (!sourceStream?.getAudioTracks().length) throw new Error("No captured source audio is available for WebRTC translation.");
  if (!window.RTCPeerConnection) throw new Error("This browser does not support WebRTC translation.");
  connectingDirect = true;
  resetLatency();

  const audioTracks = sourceStream.getAudioTracks();
  const enabled = audioTracks.map((track) => track.enabled);
  audioTracks.forEach((track) => { track.enabled = false; });

  try {
    const { body: session } = await requestJson(`/api/rooms/${roomCode}/webrtc-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ sourceType }),
    });

    peerConnection = new RTCPeerConnection();
    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.onmessage = handleRealtimeEvent;
    dataChannel.onerror = () => hostSend({ type: "translation.event", event: { type: "service.error", error: { code: "WEBRTC_DATA_CHANNEL_ERROR", message: "The low-latency translation data channel reported an error.", retriable: true } } });

    peerConnection.ontrack = ({ streams }) => {
      const translated = streams?.[0] || new MediaStream();
      void relayTranslatedTrack(translated).catch((error) => hostSend({ type: "translation.event", event: { type: "service.error", error: { code: "TRANSLATED_AUDIO_RELAY_FAILED", message: error.message, retriable: true } } }));
    };
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection?.connectionState;
      if (directActive && ["failed", "disconnected"].includes(state)) {
        hostSend({ type: "translation.event", event: { type: "service.error", error: { code: "WEBRTC_TRANSLATION_DISCONNECTED", message: "Low-latency translation connection was interrupted.", retriable: true } } });
      }
    };

    for (const track of audioTracks) peerConnection.addTrack(track, sourceStream);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const sdpResponse = await nativeFetch(TRANSLATION_CALL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) throw new Error(answerSdp || `OpenAI WebRTC connection failed (${sdpResponse.status}).`);
    await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });

    const start = await nativeFetch(`/api/rooms/${roomCode}/start-webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({}),
    });
    if (!start.ok) {
      const body = await start.json().catch(() => ({}));
      throw new Error(body.error?.message || `Could not start low-latency room (${start.status}).`);
    }

    directActive = true;
    connectingDirect = false;
    audioTracks.forEach((track, index) => { track.enabled = enabled[index] !== false; });
    noteLatency("source");
    console.info("[Lingua] Low-latency browser WebRTC translation active");
    return start;
  } catch (error) {
    audioTracks.forEach((track, index) => { track.enabled = enabled[index] !== false; });
    await cleanupDirect();
    throw error;
  }
}

if (originalGetUserMedia) {
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await originalGetUserMedia(...args);
    sourceStream = stream;
    sourceType = "microphone";
    return stream;
  };
}

if (originalGetDisplayMedia) {
  navigator.mediaDevices.getDisplayMedia = async (...args) => {
    const stream = await originalGetDisplayMedia(...args);
    sourceStream = stream;
    sourceType = "display";
    return stream;
  };
}

class HostAwareWebSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    try {
      const parsed = new URL(String(url), location.href);
      if (parsed.pathname === "/ws" && parsed.searchParams.get("role") === "host") {
        hostSocket = this;
        this.addEventListener("close", () => {
          if (hostSocket === this) hostSocket = null;
          void cleanupDirect();
        });
      }
    } catch {}
  }
}

for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
  try { Object.defineProperty(HostAwareWebSocket, key, { value: NativeWebSocket[key] }); } catch {}
}
window.WebSocket = HostAwareWebSocket;

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  const method = String(init.method || (typeof input !== "string" ? input.method : "GET") || "GET").toUpperCase();
  const startMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/start$/i);
  const endMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/end$/i);

  if (endMatch && method === "POST") {
    await cleanupDirect();
    return nativeFetch(input, init);
  }

  if (!startMatch || method !== "POST" || connectingDirect || directActive || !window.RTCPeerConnection || !sourceStream?.getAudioTracks().length) {
    return nativeFetch(input, init);
  }

  const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
  const authorization = headers.get("Authorization") || headers.get("authorization");
  if (!authorization) return nativeFetch(input, init);

  try {
    return await connectDirectTranslation({ roomCode: startMatch[1].toUpperCase(), authorization });
  } catch (error) {
    console.warn("Low-latency WebRTC translation unavailable; falling back to server relay:", error?.message || error);
    return nativeFetch(input, init);
  }
};

window.addEventListener("beforeunload", () => { void cleanupDirect(); });
