import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ElevenLabsRealtimeVoice, MAX_PENDING_TEXT_CHARS, TEXT_FLUSH_INTERVAL_MS } from "../src/elevenlabs-tts.js";
import { MAX_QUEUED_AUDIO_CHUNKS, MAX_UPSTREAM_BUFFERED_BYTES, OpenAITranslationSession } from "../src/openai-realtime.js";
import { delay } from "./helpers.js";

const EVAN_VOICE_ID = "TWutjvRaJqAX89preB4e";

test("capture worklet emits documented 200ms / 4800-sample translation frames", () => {
  const source = readFileSync(new URL("../public/pcm-worklet.js", import.meta.url), "utf8");
  assert.match(source, /TARGET_CHUNK_MS = 200/);
  assert.match(source, /TARGET_CHUNK_SAMPLES = TARGET_SAMPLE_RATE \* TARGET_CHUNK_MS \/ 1000/);
});

test("continuous fast transcript deltas cannot starve Evan's text websocket", async () => {
  const sent = [];
  const voice = new ElevenLabsRealtimeVoice({ apiKey: "test", voiceId: EVAN_VOICE_ID, logger: { info() {}, warn() {}, error() {} } });
  voice.shouldRun = true;
  voice.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload) { sent.push({ at: Date.now(), ...JSON.parse(payload) }); },
  };

  const startedAt = Date.now();
  for (let index = 0; index < 50; index += 1) {
    voice.sendDelta(`parola${index} `);
    await delay(10);
  }
  await delay(TEXT_FLUSH_INTERVAL_MS * 2);
  voice.close();

  const textMessages = sent.filter((message) => typeof message.text === "string" && message.text.trim());
  assert.ok(textMessages.length >= 5, `expected periodic streaming during uninterrupted deltas, got ${textMessages.length} messages`);
  assert.ok(textMessages[0].at - startedAt < 200, "first Evan text batch should be sent while the speaker is still talking");
  assert.ok(textMessages.every((message, index) => index === 0 || message.at - textMessages[index - 1].at < 200), "continuous deltas must not reset a debounce forever");
});

test("Evan holds only a bounded realtime text window during websocket backpressure", async () => {
  const statuses = [];
  const voice = new ElevenLabsRealtimeVoice({
    apiKey: "test",
    voiceId: EVAN_VOICE_ID,
    onStatus: (status) => statuses.push(status),
    logger: { info() {}, warn() {}, error() {} },
  });
  voice.shouldRun = true;
  voice.socket = { readyState: 1, bufferedAmount: 999_999, send() {} };

  for (let index = 0; index < 500; index += 1) voice.sendDelta(`translated-${index} `);
  await delay(TEXT_FLUSH_INTERVAL_MS * 2);
  const state = voice.snapshot();
  voice.close();

  assert.ok(state.pendingTextChars <= MAX_PENDING_TEXT_CHARS);
  assert.ok(state.droppedTextChars > 0);
  assert.ok(statuses.some((status) => status.state === "dropping_stale_voice_text"));
});

test("accelerated logical hour of dense source audio never grows the OpenAI queue", () => {
  const session = new OpenAITranslationSession({ apiKey: "test", targetLanguage: "en", logger: { info() {}, warn() {}, error() {} } });
  const sent = [];
  session.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(value) { sent.push(value); },
  };

  const chunksPerHourAt200ms = 60 * 60 * 5;
  for (let index = 0; index < chunksPerHourAt200ms; index += 1) {
    session.socket.bufferedAmount = index % 40 < 24 ? MAX_UPSTREAM_BUFFERED_BYTES + 1 : 0;
    session.appendAudio("AAAA");
    assert.ok(session.audioQueue.length <= MAX_QUEUED_AUDIO_CHUNKS, `queue escaped realtime bound at logical chunk ${index}`);
  }
  session.socket.bufferedAmount = 0;
  session.appendAudio("AAAA");

  assert.equal(session.audioQueue.length, 0);
  assert.ok(sent.length > 1000, "healthy windows should keep forwarding audio throughout the logical hour");
  assert.ok(session.droppedAudioChunks > 0, "stale frames should be discarded under sustained simulated pressure rather than accumulate latency");
});
