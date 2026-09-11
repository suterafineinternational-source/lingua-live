import crypto from "node:crypto";
import { AppError } from "./errors.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_HISTORY = 200;
const MAX_TRANSCRIPT_ROWS = 5000;

function makeCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest();
}

function hashPin(pin) {
  if (!pin) return null;
  return crypto.createHash("sha256").update(`lingua-live:${pin}`).digest("hex");
}

function normalizeGlossary(glossary) {
  if (glossary == null || glossary === "") return [];
  const values = Array.isArray(glossary) ? glossary : String(glossary).split(/\r?\n/);
  const normalized = values.map((entry) => String(entry).trim()).filter(Boolean);
  if (normalized.length > 100) throw new AppError(400, "INVALID_GLOSSARY", "A glossary can contain at most 100 entries.");
  if (normalized.some((entry) => entry.length > 160)) throw new AppError(400, "INVALID_GLOSSARY", "Each glossary entry must be 160 characters or fewer.");
  return [...new Set(normalized)];
}

function cleanText(value, max, fallback = "") {
  const text = String(value ?? fallback).trim();
  if (text.length > max) throw new AppError(400, "INVALID_EVENT_METADATA", `Text fields are limited to ${max} characters.`);
  return text;
}

function normalizeLanguage(value, fallback) {
  const candidate = cleanText(value, 40, fallback).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(candidate)) throw new AppError(400, "INVALID_LANGUAGE", "Languages must use ISO-style codes such as it, en, en-us.");
  return candidate;
}

function normalizePin(pin) {
  if (pin == null || pin === "") return null;
  const value = String(pin).trim();
  if (!/^\d{4,8}$/.test(value)) throw new AppError(400, "INVALID_AUDIENCE_PIN", "Audience PIN must contain 4-8 digits.");
  return value;
}

function normalizeScheduledAt(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(400, "INVALID_SCHEDULE", "The scheduled date/time is not valid.");
  return date.toISOString();
}

export class RoomStore {
  constructor({ now = Date.now, retentionMs = 60 * 60 * 1000 } = {}) {
    this.rooms = new Map();
    this.now = now;
    this.retentionMs = retentionMs;
  }

  create({ glossary, title, scheduledAt, sourceLanguage = "it", targetLanguage = "en", audiencePin } = {}) {
    let code;
    do code = makeCode(); while (this.rooms.has(code));

    const pin = normalizePin(audiencePin);
    const hostToken = crypto.randomBytes(32).toString("base64url");
    const room = {
      code,
      title: cleanText(title, 120, "Lingua Live event") || "Lingua Live event",
      scheduledAt: normalizeScheduledAt(scheduledAt),
      sourceLanguage: normalizeLanguage(sourceLanguage, "it"),
      targetLanguage: normalizeLanguage(targetLanguage, "en"),
      hostTokenHash: tokenHash(hostToken),
      audiencePinHash: hashPin(pin),
      audienceAdmissions: new Map(),
      glossary: normalizeGlossary(glossary),
      status: "created",
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      clients: new Map(),
      history: [],
      transcriptRows: [],
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
    const supplied = tokenHash(token);
    if (supplied.length !== room.hostTokenHash.length || !crypto.timingSafeEqual(supplied, room.hostTokenHash)) {
      throw new AppError(403, "HOST_TOKEN_INVALID", "The host token is invalid.");
    }
  }

  admitAudience(room, pin) {
    if (room.status === "ended") throw new AppError(410, "ROOM_ENDED", "This room has ended.");
    if (room.audiencePinHash) {
      const supplied = hashPin(normalizePin(pin));
      if (supplied !== room.audiencePinHash) throw new AppError(403, "AUDIENCE_PIN_INVALID", "The audience PIN is incorrect.");
    }
    const token = crypto.randomBytes(24).toString("base64url");
    this.roomAdmissionsPrune(room);
    room.audienceAdmissions.set(tokenHash(token).toString("hex"), this.now() + 30 * 60 * 1000);
    return token;
  }

  verifyAudienceAdmission(room, token) {
    if (!room.audiencePinHash) return true;
    if (!token) throw new AppError(401, "AUDIENCE_ADMISSION_REQUIRED", "Enter the audience PIN before joining.");
    this.roomAdmissionsPrune(room);
    const key = tokenHash(token).toString("hex");
    if (!room.audienceAdmissions.has(key)) throw new AppError(403, "AUDIENCE_ADMISSION_INVALID", "Audience admission has expired or is invalid.");
    return true;
  }

  roomAdmissionsPrune(room) {
    const now = this.now();
    for (const [key, expiresAt] of room.audienceAdmissions) if (expiresAt <= now) room.audienceAdmissions.delete(key);
  }

  updateGlossary(room, glossary) {
    if (room.status === "ended") throw new AppError(409, "ROOM_ENDED", "This room has ended.");
    room.glossary = normalizeGlossary(glossary);
    return room.glossary;
  }

  publicView(room) {
    return {
      code: room.code,
      title: room.title,
      scheduledAt: room.scheduledAt,
      sourceLanguage: room.sourceLanguage,
      targetLanguage: room.targetLanguage,
      pinRequired: Boolean(room.audiencePinHash),
      status: room.status,
      listenerCount: this.listenerCount(room),
      createdAt: new Date(room.createdAt).toISOString(),
      startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : null,
      endedAt: room.endedAt ? new Date(room.endedAt).toISOString() : null,
    };
  }

  hostView(room) {
    return { ...this.publicView(room), glossary: [...room.glossary], transcriptCount: room.transcriptRows.length };
  }

  listenerCount(room) {
    let count = 0;
    for (const client of room.clients.values()) if (client.role === "audience") count += 1;
    return count;
  }

  addHistory(room, event) {
    room.history.push(event);
    if (room.history.length > MAX_HISTORY) room.history.splice(0, room.history.length - MAX_HISTORY);
  }

  addTranscript(room, { itemId, source, translation, at = this.now() }) {
    let row = itemId ? room.transcriptRows.find((entry) => entry.itemId === itemId) : null;
    if (!row) {
      row = { id: crypto.randomUUID(), itemId: itemId || null, at, source: "", translation: "" };
      room.transcriptRows.push(row);
    }
    if (source != null) row.source = String(source).trim();
    if (translation != null) row.translation = String(translation).trim();
    if (room.transcriptRows.length > MAX_TRANSCRIPT_ROWS) room.transcriptRows.splice(0, room.transcriptRows.length - MAX_TRANSCRIPT_ROWS);
    return row;
  }

  transcriptView(room) {
    return room.transcriptRows.map((row) => ({ ...row, timestamp: new Date(row.at).toISOString() }));
  }

  summaryView(room) {
    const rows = this.transcriptView(room);
    return {
      event: this.hostView(room),
      summary: {
        durationMs: room.startedAt ? Math.max(0, (room.endedAt || this.now()) - room.startedAt) : 0,
        transcriptRows: rows.length,
        sourceRows: rows.filter((row) => row.source).length,
        translatedRows: rows.filter((row) => row.translation).length,
      },
      transcript: rows,
    };
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    for (const [code, room] of this.rooms) if (room.status === "ended" && room.endedAt < cutoff) this.rooms.delete(code);
  }
}

export { normalizeGlossary, normalizeScheduledAt };
