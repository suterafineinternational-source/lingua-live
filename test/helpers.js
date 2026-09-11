import WebSocket from "ws";

export function createFakeRealtimeFactory() {
  const sessions = [];
  const factory = (config) => {
    const session = {
      config,
      started: 0,
      closed: 0,
      audio: [],
      glossaries: [],
      async start() {
        this.started += 1;
        config.onStatus({ state: "connected", message: "Fake service connected." });
      },
      appendAudio(chunk) {
        this.audio.push(chunk);
      },
      updateGlossary(glossary) {
        this.glossaries.push([...glossary]);
      },
      close() {
        this.closed += 1;
      },
      emit(event) {
        config.onEvent(event);
      },
    };
    sessions.push(session);
    return session;
  };
  factory.sessions = sessions;
  return factory;
}
export async function listen(lingua) {
  await new Promise((resolve) => lingua.server.listen(0, "127.0.0.1", resolve));
  const address = lingua.server.address();
  return `http://127.0.0.1:${address.port}`;
}

export async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  return { response, body };
}

export function connectWebSocket(baseUrl, params) {
  const url = new URL("/ws", baseUrl);
  url.protocol = "ws:";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  ws.waitFor = (predicate, timeoutMs = 1500) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for WebSocket message. Received: ${JSON.stringify(messages)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  ws.messages = messages;
  return ws;
}

export async function createRoom(baseUrl, glossary = []) {
  const { response, body } = await requestJson(baseUrl, "/api/rooms", {
    method: "POST",
    body: JSON.stringify({ glossary }),
  });
  if (response.status !== 201) throw new Error(`Room creation failed: ${JSON.stringify(body)}`);
  return body;
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
