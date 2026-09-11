import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import WebSocket, { WebSocketServer } from "ws";
import { AppError, errorPayload } from "./errors.js";
import { createOpenAIRealtimeFactory } from "./openai-realtime.js";
import { RoomStore } from "./room-store.js";
import { createStorage } from "./storage.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(moduleDirectory, "../public");
const WS_MAX_BUFFERED_BYTES = 1024 * 1024;

function bearerToken(request) {
  const value = request.get("authorization") || "";
  return value.match(/^Bearer (.+)$/i)?.[1];
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(room, payload, { audienceOnly = false, hostOnly = false } = {}) {
  for (const client of room.clients.values()) {
    if (audienceOnly && client.role !== "audience") continue;
    if (hostOnly && client.role !== "host") continue;
    if (payload.type === "audio.delta" && client.ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
      if (!client.backpressureNotified) {
        client.backpressureNotified = true;
        sendJson(client.ws, { type: "service.error", error: { code: "LISTENER_TOO_SLOW", message: "Audio was skipped because this listener could not keep up.", retriable: true } });
      }
      continue;
    }
    if (client.ws.bufferedAmount < WS_MAX_BUFFERED_BYTES / 2) client.backpressureNotified = false;
    sendJson(client.ws, payload);
  }
}

function validateClientId(value) {
  if (!value || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw new AppError(400, "INVALID_CLIENT_ID", "A stable clientId of 8-80 URL-safe characters is required.");
  return value;
}

function upgradeError(socket, error) {
  const status = error instanceof AppError ? error.status : 500;
  const body = JSON.stringify(errorPayload(error));
  socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  socket.destroy();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function createRateLimiter({ limit = 120, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  return (request, _response, next) => {
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > limit) return next(new AppError(429, "RATE_LIMITED", "Too many requests. Please try again shortly.", { retriable: true }));
    next();
  };
}

export function createLinguaServer(options = {}) {
  const logger = options.logger || console;
  const hostReconnectGraceMs = options.hostReconnectGraceMs ?? 30_000;
  const roomRetentionMs = options.roomRetentionMs ?? 60 * 60 * 1000;
  const rooms = options.rooms || new RoomStore({ retentionMs: roomRetentionMs });
  const storage = createStorage(options);
  const realtimeFactory = options.realtimeFactory || createOpenAIRealtimeFactory({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY, model: options.model ?? process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime", logger });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "microphone=(self), display-capture=(self)",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:",
    });
    next();
  });
  app.use(express.json({ limit: "700kb" }));
  app.use("/api", createRateLimiter(options.rateLimit));
  app.use("/api", (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  app.use(express.static(publicDirectory, { index: false, maxAge: options.staticMaxAge ?? "1h" }));

  app.get("/", (_request, response) => response.redirect(302, "/host"));
  app.get("/host", (_request, response) => response.sendFile(path.join(publicDirectory, "host.html")));
  app.get("/audience/:code", (_request, response) => response.sendFile(path.join(publicDirectory, "audience.html")));
  app.get("/health", (_request, response) => response.json({ ok: true }));

  app.post("/api/rooms", async (request, response, next) => {
    try {
      const { room, hostToken } = rooms.create(request.body || {});
      const configuredBase = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
      const baseUrl = (configuredBase || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
      await storage.saveEvent(rooms.hostView(room));
      response.status(201).json({ room: rooms.hostView(room), hostToken, inviteUrl: `${baseUrl}/audience/${room.code}` });
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code", (request, response, next) => {
    try { response.json({ room: rooms.publicView(rooms.get(request.params.code)) }); } catch (error) { next(error); }
  });

  app.post("/api/rooms/:code/admit", (request, response, next) => {
    try {
      const room = rooms.get(request.params.code);
      response.json({ admissionToken: rooms.admitAudience(room, request.body?.pin), room: rooms.publicView(room) });
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code/qr", async (request, response, next) => {
    try {
      const room = rooms.get(request.params.code);
      const configuredBase = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
      const baseUrl = (configuredBase || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
      const image = await QRCode.toBuffer(`${baseUrl}/audience/${room.code}`, { type: "png", width: 360, margin: 2, color: { dark: "#14213d", light: "#ffffffff" } });
      response.type("png").set("Cache-Control", "no-store").send(image);
    } catch (error) { next(error); }
  });

  app.patch("/api/rooms/:code", async (request, response, next) => {
    try {
      const room = rooms.get(request.params.code);
      rooms.authenticate(room, bearerToken(request));
      rooms.updateGlossary(room, request.body?.glossary);
      room.realtime?.updateGlossary(room.glossary);
      await storage.saveEvent(rooms.hostView(room));
      response.json({ room: rooms.hostView(room) });
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code/transcript", (request, response, next) => {
    try {
      const room = rooms.get(request.params.code);
      rooms.authenticate(room, bearerToken(request));
      response.json({ rows: rooms.transcriptView(room) });
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code/transcript.csv", (request, response, next) => {
    try {
      const room = rooms.get(request.params.code);
      rooms.authenticate(room, bearerToken(request));
      const rows = rooms.transcriptView(room);
      const csv = ["timestamp,source,translation", ...rows.map((row) => [csvEscape(row.timestamp), csvEscape(row.source), csvEscape(row.translation)].join(","))].join("\n");
      response.type("text/csv").set("Content-Disposition", `attachment; filename=lingua-live-${room.code}.csv`).send(csv);
    } catch (error) { next(error); }
  });

  async function startRoom(room) {
    if (room.status === "ended") throw new AppError(409, "ROOM_ENDED", "This room has ended.");
    if (room.status === "live") return;
    if (room.startPromise) return room.startPromise;
    room.status = "starting";
    broadcast(room, { type: "room.status", room: rooms.publicView(room) });
    const operation = (async () => {
      let realtime;
      try {
        realtime = realtimeFactory({
          roomCode: room.code,
          glossary: room.glossary,
          sourceLanguage: room.sourceLanguage,
          targetLanguage: room.targetLanguage,
          onEvent: (event) => {
            if (event.type === "source_transcript.done") {
              const row = rooms.addTranscript(room, { itemId: event.itemId, source: event.transcript });
              storage.appendTranscript(room.code, row).catch((error) => logger.error("storage append failed", error?.message));
              broadcast(room, event, { hostOnly: true });
              return;
            }
            if (event.type === "source_transcript.delta") {
              broadcast(room, event, { hostOnly: true });
              return;
            }
            if (event.type === "transcript.done") {
              rooms.addHistory(room, event);
              const row = rooms.addTranscript(room, { itemId: event.itemId, translation: event.transcript });
              storage.appendTranscript(room.code, row).catch((error) => logger.error("storage append failed", error?.message));
            }
            broadcast(room, event, { audienceOnly: event.type !== "service.error" });
          },
          onStatus: (status) => broadcast(room, { type: "service.status", ...status }),
        });
        room.realtime = realtime;
        await realtime.start();
        if (room.status === "ended") { if (room.realtime === realtime) { realtime.close?.(); room.realtime = null; } return; }
        room.status = "live";
        room.startedAt ||= rooms.now();
        await storage.saveEvent(rooms.hostView(room));
        broadcast(room, { type: "room.status", room: rooms.publicView(room) });
      } catch (error) {
        realtime?.close?.();
        if (room.realtime === realtime) room.realtime = null;
        if (room.status !== "ended") room.status = "created";
        broadcast(room, { type: "room.status", room: rooms.publicView(room) });
        throw error;
      }
    })();
    room.startPromise = operation;
    operation.finally(() => { if (room.startPromise === operation) room.startPromise = null; }).catch(() => {});
    return operation;
  }

  app.post("/api/rooms/:code/start", async (request, response, next) => {
    try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); await startRoom(room); response.json({ room: rooms.hostView(room) }); } catch (error) { next(error); }
  });

  function endRoom(room) {
    if (room.status === "ended") return;
    room.status = "ended";
    room.endedAt = rooms.now();
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    room.realtime?.close?.();
    room.realtime = null;
    storage.saveEvent(rooms.hostView(room)).catch((error) => logger.error("storage save failed", error?.message));
    broadcast(room, { type: "room.ended", room: rooms.publicView(room) });
    for (const client of room.clients.values()) client.ws.close(1000, "Room ended");
    room.clients.clear();
  }

  app.post("/api/rooms/:code/end", (request, response, next) => {
    try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); endRoom(room); response.json({ room: rooms.hostView(room) }); } catch (error) { next(error); }
  });

  app.use((_request, _response, next) => next(new AppError(404, "NOT_FOUND", "Route not found.")));
  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && error.status === 400) error = new AppError(400, "INVALID_JSON", "The request body is not valid JSON.");
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500 && !(error instanceof AppError)) logger.error(error);
    response.status(status).json(errorPayload(error));
  });

  const server = http.createServer(app);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 700 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/ws") throw new AppError(404, "NOT_FOUND", "WebSocket route not found.");
      const room = rooms.get(url.searchParams.get("room"));
      if (room.status === "ended") throw new AppError(410, "ROOM_ENDED", "This room has ended.");
      const role = url.searchParams.get("role");
      if (!new Set(["host", "audience"]).has(role)) throw new AppError(400, "INVALID_ROLE", "Role must be host or audience.");
      const clientId = validateClientId(url.searchParams.get("clientId"));
      if (role === "host") rooms.authenticate(room, url.searchParams.get("token"));
      else rooms.verifyAudienceAdmission(room, url.searchParams.get("admission"));
      webSockets.handleUpgrade(request, socket, head, (ws) => webSockets.emit("connection", ws, request, { room, role, clientId }));
    } catch (error) { upgradeError(socket, error); }
  });

  webSockets.on("connection", (ws, _request, { room, role, clientId }) => {
    const key = `${role}:${clientId}`;
    const previous = room.clients.get(key);
    if (previous) previous.ws.close(4001, "Reconnected elsewhere");
    const client = { ws, role, clientId, backpressureNotified: false };
    room.clients.set(key, client);
    if (role === "host") { clearTimeout(room.hostGraceTimer); room.hostGraceTimer = null; }

    sendJson(ws, { type: "session.ready", role, room: role === "host" ? rooms.hostView(room) : rooms.publicView(room), history: role === "audience" ? room.history : undefined, transcript: role === "host" ? rooms.transcriptView(room) : undefined, audio: { format: "pcm16", sampleRate: 24000, channels: 1 } });
    broadcast(room, { type: "presence", listenerCount: rooms.listenerCount(room) });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "ping") return sendJson(ws, { type: "pong", at: Date.now() });
        if (message.type === "client.ready") return;
        if (role !== "host") throw new AppError(403, "FORBIDDEN_MESSAGE", "Audience connections cannot send host controls or audio.");
        if (message.type !== "audio.append") throw new AppError(400, "UNKNOWN_MESSAGE", "Unknown host message type.");
        if (room.status !== "live" || !room.realtime) throw new AppError(409, "ROOM_NOT_LIVE", "Start interpretation before sending audio.", { retriable: true });
        room.realtime.appendAudio(message.audio);
      } catch (error) {
        if (error instanceof SyntaxError) error = new AppError(400, "INVALID_MESSAGE_JSON", "WebSocket messages must be valid JSON.");
        sendJson(ws, { type: "client.error", ...errorPayload(error) });
      }
    });

    ws.on("close", () => {
      if (room.clients.get(key) !== client) return;
      room.clients.delete(key);
      if (role === "audience") broadcast(room, { type: "presence", listenerCount: rooms.listenerCount(room) });
      else if ((room.status === "live" || room.status === "starting") && !room.hostGraceTimer) {
        room.hostGraceTimer = setTimeout(() => {
          room.hostGraceTimer = null;
          const hasHost = [...room.clients.values()].some((connected) => connected.role === "host");
          if (hasHost || room.status === "ended") return;
          room.realtime?.close?.();
          room.realtime = null;
          room.status = "paused";
          broadcast(room, { type: "room.status", room: rooms.publicView(room) });
        }, hostReconnectGraceMs);
        room.hostGraceTimer.unref?.();
      }
    });
  });

  const pruneInterval = setInterval(() => rooms.prune(), Math.min(roomRetentionMs, 60_000));
  pruneInterval.unref?.();

  async function close() {
    clearInterval(pruneInterval);
    for (const room of rooms.rooms.values()) endRoom(room);
    webSockets.close();
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  return { app, server, rooms, storage, startRoom, endRoom, close };
}
