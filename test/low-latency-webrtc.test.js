import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLinguaServer } from "../src/app.js";
import {
  connectWebSocket,
  createFakeRealtimeFactory,
  createRoom,
  delay,
  listen,
  requestJson,
} from "./helpers.js";

const running = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

test("mints a host-only ephemeral credential and starts the room in WebRTC mode", async () => {
  const calls = [];
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({
    realtimeFactory,
    translationClientSecretFactory: async (params) => {
      calls.push(params);
      return {
        clientSecret: "short-lived-secret",
        expiresAt: 999,
        model: "gpt-realtime-translate",
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
      };
    },
  });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const auth = { Authorization: `Bearer ${created.hostToken}` };

  const denied = await requestJson(baseUrl, `/api/rooms/${created.room.code}/webrtc-session`, {
    method: "POST",
    body: JSON.stringify({ sourceType: "display" }),
  });
  assert.equal(denied.response.status, 401);

  const session = await requestJson(baseUrl, `/api/rooms/${created.room.code}/webrtc-session`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ sourceType: "display" }),
  });
  assert.equal(session.response.status, 200);
  assert.equal(session.body.clientSecret, "short-lived-secret");
  assert.equal(JSON.stringify(session.body).includes(created.hostToken), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceLanguage, "it");
  assert.equal(calls[0].targetLanguage, "en");
  assert.equal(calls[0].sourceType, "display");

  const started = await requestJson(baseUrl, `/api/rooms/${created.room.code}/start-webrtc`, {
    method: "POST",
    headers: auth,
    body: "{}",
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.transport, "webrtc");
  assert.equal(lingua.rooms.get(created.room.code).transport, "webrtc");
  assert.equal(lingua.rooms.get(created.room.code).status, "live");
  assert.equal(realtimeFactory.sessions.length, 0, "browser WebRTC mode must not open the server translation socket");
});

test("relays WebRTC transcripts and translated PCM to host and audience without re-translating source audio", async () => {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({
    realtimeFactory,
    translationClientSecretFactory: async () => ({
      clientSecret: "short-lived-secret",
      expiresAt: 999,
      model: "gpt-realtime-translate",
      sourceLanguage: "it",
      targetLanguage: "en",
    }),
  });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const auth = { Authorization: `Bearer ${created.hostToken}` };

  const host = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "host",
    clientId: "hostwebrtc01",
    token: created.hostToken,
  });
  const audience = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "audience",
    clientId: "audiencewebrtc01",
  });
  await Promise.all([
    host.waitFor((event) => event.type === "session.ready"),
    audience.waitFor((event) => event.type === "session.ready"),
  ]);

  await requestJson(baseUrl, `/api/rooms/${created.room.code}/start-webrtc`, {
    method: "POST",
    headers: auth,
    body: "{}",
  });
  await host.waitFor((event) => event.type === "room.status" && event.room.status === "live");

  host.send(JSON.stringify({
    type: "translation.event",
    event: { type: "source_transcript.done", itemId: "item-1", transcript: "Buonasera a tutti." },
  }));
  assert.equal((await host.waitFor((event) => event.type === "source_transcript.done")).transcript, "Buonasera a tutti.");
  await delay(20);
  assert.equal(audience.messages.some((event) => event.type === "source_transcript.done"), false, "source transcript remains host-only");

  host.send(JSON.stringify({
    type: "translation.event",
    event: { type: "transcript.delta", itemId: "item-1", responseId: "response-1", delta: "Good evening" },
  }));
  host.send(JSON.stringify({
    type: "translation.audio",
    audio: "AAECAw==",
    sampleRate: 24000,
  }));
  host.send(JSON.stringify({
    type: "translation.event",
    event: { type: "transcript.done", itemId: "item-1", responseId: "response-1", transcript: "Good evening, everyone." },
  }));

  for (const client of [host, audience]) {
    assert.equal((await client.waitFor((event) => event.type === "transcript.delta")).delta, "Good evening");
    assert.equal((await client.waitFor((event) => event.type === "audio.delta")).audio, "AAECAw==");
    assert.equal((await client.waitFor((event) => event.type === "transcript.done")).transcript, "Good evening, everyone.");
  }

  host.send(JSON.stringify({ type: "audio.append", audio: "AAEC" }));
  await delay(20);
  assert.equal(realtimeFactory.sessions.length, 0, "source PCM must be ignored by server translation while direct WebRTC is active");

  const rows = lingua.rooms.transcriptView(lingua.rooms.get(created.room.code));
  assert.equal(rows.some((row) => row.source === "Buonasera a tutti."), true);
  assert.equal(rows.some((row) => row.translation === "Good evening, everyone."), true);
});

test("rejects malformed translated media from a host", async () => {
  const lingua = createLinguaServer({
    realtimeFactory: createFakeRealtimeFactory(),
    translationClientSecretFactory: async () => ({ clientSecret: "x", model: "gpt-realtime-translate", sourceLanguage: "it", targetLanguage: "en" }),
  });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const auth = { Authorization: `Bearer ${created.hostToken}` };
  const host = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "host",
    clientId: "hostwebrtc02",
    token: created.hostToken,
  });
  await host.waitFor((event) => event.type === "session.ready");
  await requestJson(baseUrl, `/api/rooms/${created.room.code}/start-webrtc`, { method: "POST", headers: auth, body: "{}" });

  host.send(JSON.stringify({ type: "translation.audio", audio: "not-base64!!" }));
  const invalidAudio = await host.waitFor((event) => event.type === "client.error" && event.error?.code === "INVALID_TRANSLATED_AUDIO");
  assert.equal(invalidAudio.error.code, "INVALID_TRANSLATED_AUDIO");

  host.send(JSON.stringify({ type: "translation.event", event: { type: "admin.override", transcript: "bad" } }));
  const invalidEvent = await host.waitFor((event) => event.type === "client.error" && event.error?.code === "INVALID_TRANSLATION_EVENT");
  assert.equal(invalidEvent.error.code, "INVALID_TRANSLATION_EVENT");
});
