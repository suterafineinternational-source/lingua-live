import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLinguaServer } from "../src/app.js";
import { ElevenLabsRealtimeVoice } from "../src/elevenlabs-tts.js";
import { connectWebSocket, createFakeRealtimeFactory, createRoom, delay, listen, requestJson } from "./helpers.js";

const EVAN_VOICE_ID = "TWutjvRaJqAX89preB4e";
const running = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function createFakeVoiceFactory() {
  const sessions = [];
  const factory = (config) => {
    const session = {
      config,
      started: 0,
      closed: 0,
      deltas: [],
      turns: [],
      async start() {
        this.started += 1;
        config.onStatus?.({ state: "connected", provider: "elevenlabs", voiceName: "Evan", voiceId: EVAN_VOICE_ID });
      },
      sendDelta(text) { this.deltas.push(text); },
      finishTurn(text) { this.turns.push(text); },
      emitAudio(audio) { config.onAudio?.(audio, { provider: "elevenlabs", voiceName: "Evan", voiceId: EVAN_VOICE_ID, sampleRate: 24000 }); },
      close() { this.closed += 1; },
    };
    sessions.push(session);
    return session;
  };
  factory.sessions = sessions;
  return factory;
}

test("Evan is configured on the realtime ElevenLabs PCM WebSocket", () => {
  const voice = new ElevenLabsRealtimeVoice({ apiKey: "test-key", voiceId: EVAN_VOICE_ID });
  const url = new URL(voice.connectionUrl());
  assert.equal(url.hostname, "api.elevenlabs.io");
  assert.match(url.pathname, new RegExp(`/text-to-speech/${EVAN_VOICE_ID}/stream-input$`));
  assert.equal(url.searchParams.get("model_id"), "eleven_flash_v2_5");
  assert.equal(url.searchParams.get("output_format"), "pcm_24000");
  assert.equal(url.searchParams.get("language_code"), "en");
});

test("locked Evan mode suppresses the previous OpenAI audio and fans out only ElevenLabs PCM", async () => {
  const realtimeFactory = createFakeRealtimeFactory();
  const voiceFactory = createFakeVoiceFactory();
  const lingua = createLinguaServer({ realtimeFactory, voiceFactory, elevenLabsVoiceId: EVAN_VOICE_ID });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const auth = { Authorization: `Bearer ${created.hostToken}` };

  const started = await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, { method: "POST", headers: auth });
  assert.equal(started.response.status, 200);
  assert.equal(voiceFactory.sessions.length, 1);
  assert.equal(voiceFactory.sessions[0].started, 1);

  const audience = connectWebSocket(baseUrl, { room: created.room.code, role: "audience", clientId: "evanaudience01" });
  const ready = await audience.waitFor((event) => event.type === "session.ready");
  assert.equal(ready.audio.provider, "elevenlabs");
  assert.equal(ready.audio.voiceName, "Evan");
  assert.equal(ready.audio.voiceId, EVAN_VOICE_ID);

  const translation = realtimeFactory.sessions[0];
  translation.emit({ type: "transcript.delta", responseId: "r1", itemId: "i1", delta: "Good evening" });
  translation.emit({ type: "audio.delta", responseId: "r1", itemId: "i1", audio: "T0xEX1ZPSUNF", format: "pcm16", sampleRate: 24000 });
  translation.emit({ type: "transcript.done", responseId: "r1", itemId: "i1", transcript: "Good evening." });

  await audience.waitFor((event) => event.type === "transcript.done");
  await delay(20);
  assert.deepEqual(voiceFactory.sessions[0].deltas, ["Good evening"]);
  assert.deepEqual(voiceFactory.sessions[0].turns, ["Good evening."]);
  assert.equal(audience.messages.some((event) => event.type === "audio.delta" && event.audio === "T0xEX1ZPSUNF"), false, "previous OpenAI voice audio must never reach listeners");

  voiceFactory.sessions[0].emitAudio("AAECAw==");
  const audio = await audience.waitFor((event) => event.type === "audio.delta" && event.audio === "AAECAw==");
  assert.equal(audio.provider, "elevenlabs");
  assert.equal(audio.voiceName, "Evan");
  assert.equal(audio.voiceId, EVAN_VOICE_ID);
  assert.equal(audio.sampleRate, 24000);

  await requestJson(baseUrl, `/api/rooms/${created.room.code}/end`, { method: "POST", headers: auth });
  assert.equal(voiceFactory.sessions[0].closed, 1);
});
