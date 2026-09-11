import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import WebSocket, { WebSocketServer } from "ws";
import { AppError, errorPayload } from "./errors.js";
import { createIntegrationRegistry } from "./integrations.js";
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

function broadcast(room, payload, { audienceOnly = false, hostOnly = false, onBackpressureDrop } = {}) {
  for (const client of room.clients.values()) {
    if (audienceOnly && client.role !== "audience") continue;
    if (hostOnly && client.role !== "host") continue;
    if ((payload.type === "audio.delta" || payload.type === "screen.frame") && client.ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
      onBackpressureDrop?.(client);
      if (!client.backpressureNotified) {
        client.backpressureNotified = true;
        sendJson(client.ws, {
          type: "service.error",
          error: {
            code: "LISTENER_TOO_SLOW",
            message: "Live media was skipped because this listener could not keep up.",
            retriable: true,
          },
        });
      }
      continue;
    }
    if (client.ws.bufferedAmount < WS_MAX_BUFFERED_BYTES / 2) client.backpressureNotified = false;
    sendJson(client.ws, payload);
  }
}

function validateClientId(value) {
  if (!value || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new AppError(400, "INVALID_CLIENT_ID", "A stable clientId of 8-80 URL-safe characters is required.");
  }
  return value;
}

function upgradeError(socket, error) {
  const status = error instanceof AppError ? error.status : 500;
  const body = JSON.stringify(errorPayload(error));
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function vttTimestamp(milliseconds) {
  const total = Math.max(0, Number(milliseconds) || 0);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const ms = Math.floor(total % 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
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
    if (bucket.count > limit) {
      return next(new AppError(429, "RATE_LIMITED", "Too many requests. Please try again shortly.", { retriable: true }));
    }
    next();
  };
}

function sseSend(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function framePolicyFor(request) {
  if (request.path === "/embed.html") return { frameOptions: null, frameAncestors: "frame-ancestors *;" };
  if (request.path.startsWith("/audience/")) return { frameOptions: "SAMEORIGIN", frameAncestors: "frame-ancestors 'self';" };
  return { frameOptions: "DENY", frameAncestors: "frame-ancestors 'none';" };
}

export function createLinguaServer(options = {}) {
  const logger = options.logger || console;
  const hostReconnectGraceMs = options.hostReconnectGraceMs ?? 30_000;
  const roomRetentionMs = options.roomRetentionMs ?? 60 * 60 * 1000;
  const rooms = options.rooms || new RoomStore({ retentionMs: roomRetentionMs });
  const storage = createStorage(options);
  const integrations = options.integrations || createIntegrationRegistry(options.integrationAdapters);
  const metrics = {
    roomsCreated: 0, roomsStarted: 0, roomsEnded: 0, websocketConnections: 0,
    transcriptEvents: 0, audioEvents: 0, upstreamErrors: 0, listenerBackpressureDrops: 0,
  };
  const realtimeFactory = options.realtimeFactory || createOpenAIRealtimeFactory({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    model: options.model ?? process.env.OPENAI_REALTIME_MODEL,
    mode: options.mode ?? process.env.OPENAI_TRANSLATION_MODE,
    promptedModel: options.promptedModel ?? process.env.OPENAI_PROMPTED_REALTIME_MODEL,
    logger,
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((request, response, next) => {
    const frame = framePolicyFor(request);
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "microphone=(self), display-capture=(self)",
      "Content-Security-Policy": `default-src 'self'; ${frame.frameAncestors} frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:`,
    });
    if (frame.frameOptions) response.set("X-Frame-Options", frame.frameOptions);
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
  app.get("/ready", (_request, response) => response.json({ ok: true, rooms: rooms.rooms.size }));
  app.get("/api/integrations", (_request, response) => response.json({ integrations: integrations.capabilities() }));
  app.get("/metrics", (_request, response) => {
    let activeRooms = 0, liveRooms = 0, listeners = 0;
    for (const room of rooms.rooms.values()) {
      if (room.status !== "ended") activeRooms += 1;
      if (room.status === "live") liveRooms += 1;
      listeners += rooms.listenerCount(room);
    }
    const lines = [
      "# HELP lingua_active_rooms Current non-ended rooms", "# TYPE lingua_active_rooms gauge", `lingua_active_rooms ${activeRooms}`,
      "# HELP lingua_live_rooms Current live rooms", "# TYPE lingua_live_rooms gauge", `lingua_live_rooms ${liveRooms}`,
      "# HELP lingua_listeners Current audience websocket listeners", "# TYPE lingua_listeners gauge", `lingua_listeners ${listeners}`,
      "# TYPE lingua_rooms_created_total counter", `lingua_rooms_created_total ${metrics.roomsCreated}`,
      "# TYPE lingua_rooms_started_total counter", `lingua_rooms_started_total ${metrics.roomsStarted}`,
      "# TYPE lingua_rooms_ended_total counter", `lingua_rooms_ended_total ${metrics.roomsEnded}`,
      "# TYPE lingua_websocket_connections_total counter", `lingua_websocket_connections_total ${metrics.websocketConnections}`,
      "# TYPE lingua_transcript_events_total counter", `lingua_transcript_events_total ${metrics.transcriptEvents}`,
      "# TYPE lingua_audio_events_total counter", `lingua_audio_events_total ${metrics.audioEvents}`,
      "# TYPE lingua_upstream_errors_total counter", `lingua_upstream_errors_total ${metrics.upstreamErrors}`,
      "# TYPE lingua_backpressure_drops_total counter", `lingua_backpressure_drops_total ${metrics.listenerBackpressureDrops}`,
      "# TYPE process_uptime_seconds gauge", `process_uptime_seconds ${process.uptime()}`,
    ];
    response.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
  });

  app.post("/api/rooms", async (request, response, next) => {
    try {
      const { room, hostToken } = rooms.create(request.body || {});
      metrics.roomsCreated += 1;
      const configuredBase = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
      const baseUrl = (configuredBase || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
      await storage.saveEvent(rooms.hostView(room));
      response.status(201).json({ room: rooms.hostView(room), hostToken, inviteUrl: `${baseUrl}/audience/${room.code}`, embedUrl: `${baseUrl}/embed.html?room=${room.code}`, captionsUrl: `${baseUrl}/captions.html?room=${room.code}` });
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code", (request, response, next) => { try { response.json({ room: rooms.publicView(rooms.get(request.params.code)) }); } catch (error) { next(error); } });
  app.post("/api/rooms/:code/admit", (request, response, next) => {
    try { const room = rooms.get(request.params.code); response.json({ admissionToken: rooms.admitAudience(room, request.body?.pin), room: rooms.publicView(room) }); }
    catch (error) { next(error); }
  });

  app.get("/api/rooms/:code/captions.sse", (request, response, next) => {
    try {
      const room = rooms.get(request.params.code); rooms.verifyAudienceAdmission(room, request.query.admission); room.sseClients ||= new Set();
      response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      response.flushHeaders?.(); room.sseClients.add(response); sseSend(response, "ready", { room: rooms.publicView(room) });
      for (const item of room.history.slice(-10)) sseSend(response, "caption", item);
      const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000); heartbeat.unref?.();
      request.on("close", () => { clearInterval(heartbeat); room.sseClients.delete(response); });
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code/captions.vtt", (request, response, next) => {
    try {
      const room = rooms.get(request.params.code); rooms.verifyAudienceAdmission(room, request.query.admission);
      const completed = room.history.filter((event) => event.type === "transcript.done" && event.transcript).slice(-50);
      const baseTime = room.startedAt || room.createdAt;
      const cues = completed.map((event, index) => { const start = Math.max(0, (event.at || baseTime + index * 3000) - baseTime); const end = start + 2800; return `${index + 1}\n${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${String(event.transcript).replaceAll("\n", " ")}\n`; });
      response.type("text/vtt").set("Cache-Control", "no-store").send(`WEBVTT\n\n${cues.join("\n")}`);
    } catch (error) { next(error); }
  });

  app.get("/api/rooms/:code/qr", async (request, response, next) => {
    try {
      const room = rooms.get(request.params.code); const configuredBase = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
      const baseUrl = (configuredBase || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
      const image = await QRCode.toBuffer(`${baseUrl}/audience/${room.code}`, { type: "png", width: 360, margin: 2, color: { dark: "#14213d", light: "#ffffffff" } });
      response.type("png").set("Cache-Control", "no-store").send(image);
    } catch (error) { next(error); }
  });

  app.patch("/api/rooms/:code", async (request, response, next) => {
    try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); rooms.updateGlossary(room, request.body?.glossary); room.realtime?.updateGlossary(room.glossary); await storage.saveEvent(rooms.hostView(room)); response.json({ room: rooms.hostView(room) }); }
    catch (error) { next(error); }
  });
  app.get("/api/rooms/:code/transcript", (request, response, next) => { try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); response.json({ rows: rooms.transcriptView(room) }); } catch (error) { next(error); } });
  app.get("/api/rooms/:code/summary", (request, response, next) => { try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); response.json(rooms.summaryView(room)); } catch (error) { next(error); } });
  app.get("/api/rooms/:code/transcript.csv", (request, response, next) => {
    try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); const rows = rooms.transcriptView(room); const csv = ["timestamp,source,translation", ...rows.map((row) => [csvEscape(row.timestamp), csvEscape(row.source), csvEscape(row.translation)].join(","))].join("\n"); response.type("text/csv").set("Content-Disposition", `attachment; filename=lingua-live-${room.code}.csv`).send(csv); }
    catch (error) { next(error); }
  });

  function emitSseCaption(room, event) {
    for (const response of room.sseClients || []) { try { sseSend(response, "caption", event); } catch { room.sseClients.delete(response); } }
  }
  function broadcastRoom(room, payload, options = {}) {
    broadcast(room, payload, { ...options, onBackpressureDrop: () => { metrics.listenerBackpressureDrops += 1; } });
  }

  async function startRoom(room) {
    if (room.status === "ended") throw new AppError(409, "ROOM_ENDED", "This room has ended.");
    if (room.status === "live") return;
    if (room.startPromise) return room.startPromise;
    room.status = "starting"; broadcastRoom(room, { type: "room.status", room: rooms.publicView(room) });
    const operation = (async () => {
      let realtime;
      try {
        realtime = realtimeFactory({
          roomCode: room.code, glossary: room.glossary, sourceLanguage: room.sourceLanguage, targetLanguage: room.targetLanguage,
          onEvent: (event) => {
            if (event.type === "source_transcript.done") {
              metrics.transcriptEvents += 1; const row = rooms.addTranscript(room, { itemId: event.itemId, source: event.transcript });
              storage.appendTranscript(room.code, row).catch((error) => logger.error("storage append failed", error?.message));
              broadcastRoom(room, event, { hostOnly: true }); return;
            }
            if (event.type === "source_transcript.delta") { broadcastRoom(room, event, { hostOnly: true }); return; }
            if (event.type === "transcript.done") {
              metrics.transcriptEvents += 1; const completedEvent = { ...event, at: rooms.now() }; rooms.addHistory(room, completedEvent);
              const row = rooms.addTranscript(room, { itemId: event.itemId, translation: event.transcript });
              storage.appendTranscript(room.code, row).catch((error) => logger.error("storage append failed", error?.message)); emitSseCaption(room, completedEvent);
            }
            if (event.type === "transcript.delta") emitSseCaption(room, event);
            if (event.type === "audio.delta") metrics.audioEvents += 1;
            if (event.type === "service.error") metrics.upstreamErrors += 1;
            // Host must also receive translated text/audio so it can monitor exactly what the audience hears.
            broadcastRoom(room, event);
          },
          onStatus: (status) => broadcastRoom(room, { type: "service.status", ...status }),
        });
        room.realtime = realtime; await realtime.start();
        if (room.status === "ended") { if (room.realtime === realtime) { realtime.close?.(); room.realtime = null; } return; }
        room.status = "live"; room.startedAt ||= rooms.now(); metrics.roomsStarted += 1; await storage.saveEvent(rooms.hostView(room)); broadcastRoom(room, { type: "room.status", room: rooms.publicView(room) });
      } catch (error) {
        metrics.upstreamErrors += 1; realtime?.close?.(); if (room.realtime === realtime) room.realtime = null; if (room.status !== "ended") room.status = "created"; broadcastRoom(room, { type: "room.status", room: rooms.publicView(room) }); throw error;
      }
    })();
    room.startPromise = operation; operation.finally(() => { if (room.startPromise === operation) room.startPromise = null; }).catch(() => {}); return operation;
  }

  app.post("/api/rooms/:code/start", async (request, response, next) => { try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); await startRoom(room); response.json({ room: rooms.hostView(room) }); } catch (error) { next(error); } });

  function endRoom(room) {
    if (room.status === "ended") return; room.status = "ended"; room.endedAt = rooms.now(); metrics.roomsEnded += 1; clearTimeout(room.hostGraceTimer); room.hostGraceTimer = null; room.realtime?.close?.(); room.realtime = null;
    storage.saveEvent(rooms.hostView(room)).catch((error) => logger.error("storage save failed", error?.message)); broadcastRoom(room, { type: "room.ended", room: rooms.publicView(room) });
    for (const response of room.sseClients || []) { try { sseSend(response, "ended", { room: rooms.publicView(room) }); response.end(); } catch {} }
    room.sseClients?.clear(); for (const client of room.clients.values()) client.ws.close(1000, "Room ended"); room.clients.clear();
  }
  app.post("/api/rooms/:code/end", (request, response, next) => { try { const room = rooms.get(request.params.code); rooms.authenticate(room, bearerToken(request)); endRoom(room); response.json({ room: rooms.hostView(room) }); } catch (error) { next(error); } });

  app.use((_request, _response, next) => next(new AppError(404, "NOT_FOUND", "Route not found.")));
  app.use((error, _request, response, _next) => { if (error instanceof SyntaxError && error.status === 400) error = new AppError(400, "INVALID_JSON", "The request body is not valid JSON."); const status = error instanceof AppError ? error.status : 500; if (status >= 500 && !(error instanceof AppError)) logger.error(error); response.status(status).json(errorPayload(error)); });

  const server = http.createServer(app);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 700 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url, "http://localhost"); if (url.pathname !== "/ws") throw new AppError(404, "NOT_FOUND", "WebSocket route not found.");
      const room = rooms.get(url.searchParams.get("room")); if (room.status === "ended") throw new AppError(410, "ROOM_ENDED", "This room has ended.");
      const role = url.searchParams.get("role"); if (!new Set(["host", "audience"]).has(role)) throw new AppError(400, "INVALID_ROLE", "Role must be host or audience.");
      const clientId = validateClientId(url.searchParams.get("clientId")); if (role === "host") rooms.authenticate(room, url.searchParams.get("token")); else rooms.verifyAudienceAdmission(room, url.searchParams.get("admission"));
      webSockets.handleUpgrade(request, socket, head, (ws) => webSockets.emit("connection", ws, request, { room, role, clientId }));
    } catch (error) { upgradeError(socket, error); }
  });

  webSockets.on("connection", (ws, _request, { room, role, clientId }) => {
    metrics.websocketConnections += 1; const key = `${role}:${clientId}`; const previous = room.clients.get(key); if (previous) previous.ws.close(4001, "Reconnected elsewhere");
    const client = { ws, role, clientId, backpressureNotified: false, audioEnabled: false, playedChunks: 0, volume: 1, lastPlaybackAt: null };
    room.clients.set(key, client);
    if (role === "host") { clearTimeout(room.hostGraceTimer); room.hostGraceTimer = null; }
    sendJson(ws, { type: "session.ready", role, room: role === "host" ? rooms.hostView(room) : rooms.publicView(room), history: role === "audience" ? room.history : undefined, transcript: role === "host" ? rooms.transcriptView(room) : undefined, audio: { format: "pcm16", sampleRate: 24000, channels: 1 } });
    broadcastRoom(room, { type: "presence", listenerCount: rooms.listenerCount(room) });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "ping") return sendJson(ws, { type: "pong", at: Date.now() });
        if (message.type === "client.ready") return;
        if (role === "audience") {
          if (message.type === "listener.audio_state" || message.type === "listener.playback") {
            if (typeof message.enabled === "boolean") client.audioEnabled = message.enabled;
            if (Number.isFinite(Number(message.playedChunks))) client.playedChunks = Math.max(0, Number(message.playedChunks));
            if (Number.isFinite(Number(message.volume))) client.volume = Math.max(0, Math.min(1, Number(message.volume)));
            client.lastPlaybackAt = Number(message.lastPlaybackAt) || client.lastPlaybackAt;
            broadcastRoom(room, { type: "listener.status", clientId, audioEnabled: client.audioEnabled, playedChunks: client.playedChunks, volume: client.volume, lastPlaybackAt: client.lastPlaybackAt }, { hostOnly: true });
            return;
          }
          throw new AppError(403, "FORBIDDEN_MESSAGE", "Audience connections cannot send host controls or source audio.");
        }
        if (message.type === "screen.frame") {
          if (typeof message.image !== "string" || !message.image.startsWith("data:image/jpeg;base64,") || message.image.length > 650_000) throw new AppError(400, "INVALID_SCREEN_FRAME", "Screen frame is invalid or too large.");
          broadcastRoom(room, { type: "screen.frame", image: message.image, at: Date.now() }, { audienceOnly: true }); return;
        }
        if (message.type !== "audio.append") throw new AppError(400, "UNKNOWN_MESSAGE", "Unknown host message type.");
        if (room.status !== "live" || !room.realtime) throw new AppError(409, "ROOM_NOT_LIVE", "Start interpretation before sending audio.", { retriable: true });
        room.realtime.appendAudio(message.audio);
      } catch (error) {
        if (error instanceof SyntaxError) error = new AppError(400, "INVALID_MESSAGE_JSON", "WebSocket messages must be valid JSON.");
        sendJson(ws, { type: "client.error", ...errorPayload(error) });
      }
    });

    ws.on("close", () => {
      if (room.clients.get(key) !== client) return; room.clients.delete(key);
      if (role === "audience") {
        broadcastRoom(room, { type: "presence", listenerCount: rooms.listenerCount(room) });
        broadcastRoom(room, { type: "listener.status", clientId, disconnected: true }, { hostOnly: true });
      } else if ((room.status === "live" || room.status === "starting") && !room.hostGraceTimer) {
        room.hostGraceTimer = setTimeout(() => { room.hostGraceTimer = null; const hasHost = [...room.clients.values()].some((connected) => connected.role === "host"); if (hasHost || room.status === "ended") return; room.realtime?.close?.(); room.realtime = null; room.status = "paused"; broadcastRoom(room, { type: "room.status", room: rooms.publicView(room) }); }, hostReconnectGraceMs);
        room.hostGraceTimer.unref?.();
      }
    });
  });

  const pruneInterval = setInterval(() => rooms.prune(), Math.min(roomRetentionMs, 60_000)); pruneInterval.unref?.();
  async function close() { clearInterval(pruneInterval); for (const room of rooms.rooms.values()) endRoom(room); webSockets.close(); if (!server.listening) return; await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))); }
  return { app, server, rooms, storage, integrations, metrics, startRoom, endRoom, close };
}
