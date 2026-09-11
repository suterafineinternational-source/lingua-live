import crypto from "node:crypto";
import { AppError } from "./errors.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_HISTORY = 100;

function makeCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest();
}

function normalizeGlossary(glossary) {
  if (glossary == null || glossary === "") return [];
  const values = Array.isArray(glossary) ? glossary : String(glossary).split(/\r?\n/);
  const normalized = values.map((entry) => String(entry).trim()).filter(Boolean);
  if (normalized.length > 100) {
    throw new AppError(400, "INVALID_GLOSSARY", "A glossary can contain at most 100 entries.");
  }
  if (normalized.some((entry) => entry.length > 160)) {
    throw new AppError(400, "INVALID_GLOSSARY", "Each glossary entry must be 160 characters or fewer.");
  }
  return [...new Set(normalized)];
}

export class RoomStore {
  constructor({ now = Date.now, retentionMs = 60 * 60 * 1000 } = {}) {
    this.rooms = new Map();
    this.now = now;
    this.retentionMs = retentionMs;
  }

  create({ glossary } = {}) {
    let code;
    do code = makeCode(); while (this.rooms.has(code));

    const hostToken = crypto.randomBytes(32).toString("base64url");
    const room = {
      code,
      hostTokenHash: tokenHash(hostToken),
      glossary: normalizeGlossary(glossary),
      status: "created",
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      clients: new Map(),
      history: [],
      realtime: null,
      hostGraceTimer: null,
    };
    this.rooms.set(code, room);
    return { room, hostToken };
  }

  get(code) {
    const room = this.rooms.get(String(code || "").toUpperCase());
    if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found.");
    return room;
  }

  authenticate(room, token) {
    if (!token) throw new AppError(401, "HOST_TOKEN_REQUIRED", "A host token is required.");
    let supplied;
    try {
      supplied = tokenHash(token);
    } catch {
      throw new AppError(403, "HOST_TOKEN_INVALID", "The host token is invalid.");
    }
    if (supplied.length !== room.hostTokenHash.length || !crypto.timingSafeEqual(supplied, room.hostTokenHash)) {
      throw new AppError(403, "HOST_TOKEN_INVALID", "The host token is invalid.");
    }
  }

  updateGlossary(room, glossary) {
    if (room.status === "ended") throw new AppError(409, "ROOM_ENDED", "This room has ended.");
    room.glossary = normalizeGlossary(glossary);
    return room.glossary;
  }

  publicView(room) {
    return {
      code: room.code,
      status: room.status,
      listenerCount: this.listenerCount(room),
      createdAt: new Date(room.createdAt).toISOString(),
      startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : null,
      endedAt: room.endedAt ? new Date(room.endedAt).toISOString() : null,
    };
  }

  hostView(room) {
    return { ...this.publicView(room), glossary: [...room.glossary] };
  }

  listenerCount(room) {
    let count = 0;
    for (const client of room.clients.values()) {
      if (client.role === "audience") count += 1;
    }
    return count;
  }

  addHistory(room, event) {
    room.history.push(event);
    if (room.history.length > MAX_HISTORY) room.history.splice(0, room.history.length - MAX_HISTORY);
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    for (const [code, room] of this.rooms) {
      if (room.status === "ended" && room.endedAt < cutoff) this.rooms.delete(code);
    }
  }
}

export { normalizeGlossary };
