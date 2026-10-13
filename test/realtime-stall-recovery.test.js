import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { createLinguaServer } from "../src/app.js";
import { MAX_QUEUED_AUDIO_CHUNKS, OpenAITranslationSession } from "../src/openai-realtime.js";
import { createFakeRealtimeFactory, createRoom, listen, requestJson } from "./helpers.js";

const running = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

test("a live WebRTC room can fail over to a fresh server realtime session", async () => {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const room = lingua.rooms.get(created.room.code);
  room.status = "live";
  room.transport = "webrtc";
  room.startedAt = Date.now();

  const { response, body } = await requestJson(baseUrl, `/api/rooms/${room.code}/fallback-server`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.hostToken}` },
    body: JSON.stringify({ reason: "test stall" }),
  });

  assert.equal(response.status, 200);
  assert.equal(body.recovered, true);
  assert.equal(room.transport, "server-websocket");
  assert.equal(room.status, "live");
  assert.equal(realtimeFactory.sessions.length, 1);
  assert.equal(realtimeFactory.sessions[0].started, 1);
  assert.equal(lingua.metrics.translationRecoveries, 1);
});

test("server realtime input drops stale audio instead of growing an unbounded latency queue", () => {
  const statuses = [];
  const sent = [];
  const session = new OpenAITranslationSession({
    apiKey: "test",
    targetLanguage: "en",
    onStatus: (status) => statuses.push(status),
    logger: { info() {}, error() {}, warn() {} },
  });
  session.socket = {
    readyState: 1,
    bufferedAmount: 300_000,
    send(value) { sent.push(JSON.parse(value)); },
  };

  for (let index = 0; index < 40; index += 1) session.appendAudio("AAAA");
  assert.equal(session.audioQueue.length, MAX_QUEUED_AUDIO_CHUNKS);
  assert.ok(session.droppedAudioChunks > 0);
  assert.ok(statuses.some((status) => status.state === "dropping_stale_audio"));

  session.socket.bufferedAmount = 0;
  session.appendAudio("AAAA");
  assert.equal(session.audioQueue.length, 0);
  assert.ok(sent.length > 1, "the newest realtime window should flush when upstream pressure clears");
});

test("Host loads the stall watchdog before the live controls and the watchdog uses authenticated recovery", () => {
  const entry = readFileSync(new URL("../public/host-entry.js", import.meta.url), "utf8");
  const guard = readFileSync(new URL("../public/realtime-stall-guard.js", import.meta.url), "utf8");
  assert.ok(entry.indexOf("realtime-stall-guard.js") < entry.indexOf("host.js"));
  assert.match(guard, /STALL_AFTER_MS = 4500/);
  assert.match(guard, /fallback-server/);
  assert.match(guard, /Authorization: `Bearer \$\{credentials\.token\}`/);
  assert.match(guard, /sourceIsSpeaking/);
});
