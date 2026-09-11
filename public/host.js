import { api, clientId, reconnectDelay, setText, webSocketUrl } from "/shared.js";

const elements = {
  createPanel: document.querySelector("#create-panel"),
  roomPanel: document.querySelector("#room-panel"),
  createGlossary: document.querySelector("#create-glossary"),
  roomGlossary: document.querySelector("#room-glossary"),
  createRoom: document.querySelector("#create-room"),
  startRoom: document.querySelector("#start-room"),
  endRoom: document.querySelector("#end-room"),
  saveGlossary: document.querySelector("#save-glossary"),
  copyLink: document.querySelector("#copy-link"),
  roomCode: document.querySelector("#room-code"),
  roomStatus: document.querySelector("#room-status"),
  inviteLink: document.querySelector("#invite-link"),
  qrCode: document.querySelector("#qr-code"),
  listenerCount: document.querySelector("#listener-count"),
  serviceStatus: document.querySelector("#service-status"),
  error: document.querySelector("#error"),
};

let room;
let hostToken;
let socket;
let reconnectAttempt = 0;
let reconnectTimer;
let shouldConnect = false;
let mediaStream;
let audioContext;
let captureNode;

function glossaryFrom(textarea) {
  return textarea.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function showError(error) {
  elements.error.textContent = error?.message || "Something went wrong.";
  elements.error.classList.remove("hidden");
}

function clearError() {
  elements.error.classList.add("hidden");
  elements.error.textContent = "";
}

function renderRoom(nextRoom) {
  room = nextRoom;
  elements.createPanel.classList.add("hidden");
  elements.roomPanel.classList.remove("hidden");
  setText(elements.roomCode, room.code);
  setText(elements.listenerCount, String(room.listenerCount));
  setText(elements.roomStatus, room.status[0].toUpperCase() + room.status.slice(1));
  elements.roomStatus.dataset.state = room.status;
  elements.startRoom.disabled = ["starting", "live", "ended"].includes(room.status);
  elements.endRoom.disabled = room.status === "ended";
  elements.saveGlossary.disabled = room.status === "ended";
  if (room.glossary) elements.roomGlossary.value = room.glossary.join("\n");
  if (room.status === "ended") {
    shouldConnect = false;
    stopMicrophone();
    setText(elements.serviceStatus, "This room has ended.");
  }
}

function showInvitation(inviteUrl) {
  elements.inviteLink.href = inviteUrl;
  elements.inviteLink.textContent = inviteUrl;
  elements.qrCode.src = `/api/rooms/${room.code}/qr`;
}

function connectSocket() {
  if (!room || !hostToken || room.status === "ended") return;
  clearTimeout(reconnectTimer);
  shouldConnect = true;
  const url = webSocketUrl({
    room: room.code,
    role: "host",
    clientId: clientId(`lingua-host-client-${room.code}`),
    token: hostToken,
  });
  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    setText(elements.serviceStatus, room.status === "live" ? "Live microphone connected." : "Host connected. Ready to start.");
    socket.send(JSON.stringify({ type: "client.ready" }));
  });

  socket.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "session.ready" || event.type === "room.status") renderRoom(event.room);
    if (event.type === "presence") setText(elements.listenerCount, String(event.listenerCount));
    if (event.type === "service.status") setText(elements.serviceStatus, event.message);
    if (event.type === "client.error" || event.type === "service.error") showError(event.error);
    if (event.type === "room.ended") renderRoom(event.room);
  });

  socket.addEventListener("close", (event) => {
    if (!shouldConnect || room?.status === "ended" || event.code === 4001) return;
    stopMicrophone();
    const delay = reconnectDelay(reconnectAttempt++);
    setText(elements.serviceStatus, `Host connection lost. Reconnecting in ${Math.ceil(delay / 1000)}s…`);
    reconnectTimer = setTimeout(connectSocket, delay);
  });

  socket.addEventListener("error", () => setText(elements.serviceStatus, "Host connection interrupted."));
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

async function startMicrophone() {
  if (mediaStream) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("/pcm-worklet.js");
  await audioContext.resume();
  const source = audioContext.createMediaStreamSource(mediaStream);
  captureNode = new AudioWorkletNode(audioContext, "pcm-capture");
  const silent = audioContext.createGain();
  silent.gain.value = 0;
  source.connect(captureNode).connect(silent).connect(audioContext.destination);
  captureNode.port.onmessage = ({ data }) => {
    if (socket?.readyState === WebSocket.OPEN && room?.status === "live") {
      socket.send(JSON.stringify({ type: "audio.append", audio: bytesToBase64(data) }));
    }
  };
}

function stopMicrophone() {
  captureNode?.disconnect();
  captureNode = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  audioContext?.close();
  audioContext = null;
}

elements.createRoom.addEventListener("click", async () => {
  clearError();
  elements.createRoom.disabled = true;
  try {
    const payload = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ glossary: glossaryFrom(elements.createGlossary) }),
    });
    room = payload.room;
    hostToken = payload.hostToken;
    sessionStorage.setItem(`lingua-host-token-${room.code}`, hostToken);
    history.replaceState(null, "", `/host?room=${room.code}`);
    renderRoom(room);
    showInvitation(payload.inviteUrl);
    connectSocket();
  } catch (error) {
    showError(error);
  } finally {
    elements.createRoom.disabled = false;
  }
});

elements.startRoom.addEventListener("click", async () => {
  clearError();
  elements.startRoom.disabled = true;
  setText(elements.serviceStatus, "Connecting interpretation service…");
  try {
    const payload = await api(`/api/rooms/${room.code}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    renderRoom(payload.room);
    await startMicrophone();
    setText(elements.serviceStatus, "Live microphone connected.");
  } catch (error) {
    showError(error);
    setText(elements.serviceStatus, "Ready to start when the interpretation service is available.");
    elements.startRoom.disabled = false;
    stopMicrophone();
  }
});

elements.endRoom.addEventListener("click", async () => {
  clearError();
  elements.endRoom.disabled = true;
  try {
    const payload = await api(`/api/rooms/${room.code}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    shouldConnect = false;
    socket?.close();
    stopMicrophone();
    renderRoom(payload.room);
  } catch (error) {
    showError(error);
    elements.endRoom.disabled = false;
  }
});

elements.saveGlossary.addEventListener("click", async () => {
  clearError();
  try {
    const payload = await api(`/api/rooms/${room.code}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ glossary: glossaryFrom(elements.roomGlossary) }),
    });
    renderRoom(payload.room);
    setText(elements.serviceStatus, "Glossary saved for this session.");
  } catch (error) {
    showError(error);
  }
});

elements.copyLink.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.inviteLink.href);
    setText(elements.serviceStatus, "Invite link copied.");
  } catch {
    showError(new Error("Could not copy automatically. Select the invite link instead."));
  }
});

async function restoreRoom() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
  if (!code) return;
  hostToken = sessionStorage.getItem(`lingua-host-token-${code}`);
  if (!hostToken) {
    showError(new Error("This browser no longer has the host credential for that room. Create a new room."));
    return;
  }
  try {
    const payload = await api(`/api/rooms/${code}`);
    renderRoom(payload.room);
    showInvitation(`${location.origin}/audience/${code}`);
    connectSocket();
  } catch (error) {
    showError(error);
  }
}

restoreRoom();
