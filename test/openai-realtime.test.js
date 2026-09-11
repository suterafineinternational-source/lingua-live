import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OpenAIPromptedRealtimeSession,
  OpenAITranslationSession,
  createOpenAIRealtimeFactory,
  sessionUpdate,
  translationEngineCapabilities,
  translationInstructions,
  translationSessionUpdate,
} from "../src/openai-realtime.js";

test("Prompted Realtime session requests 24 kHz audio output and server VAD responses", () => {
  const event = sessionUpdate("gpt-realtime-2.1", ["Sutera = Sutera"]);
  assert.equal(event.type, "session.update");
  assert.deepEqual(event.session.output_modalities, ["audio"]);
  assert.deepEqual(event.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(event.session.audio.input.turn_detection.create_response, true);
  assert.deepEqual(event.session.audio.output.format, { type: "audio/pcm", rate: 24000 });
  assert.match(event.session.instructions, /Sutera = Sutera/);
});

test("translation prompt constrains output to English interpretation", () => {
  const instructions = translationInstructions([]);
  assert.match(instructions, /Translate every Italian utterance into natural English/);
  assert.match(instructions, /Respond only with the English translation/);
});

test("native Realtime Translation config only sets translation-session audio options", () => {
  const event = translationSessionUpdate("en");
  assert.equal(event.type, "session.update");
  assert.deepEqual(event.session.audio.input.transcription, { model: "gpt-realtime-whisper" });
  assert.deepEqual(event.session.audio.input.noise_reduction, { type: "near_field" });
  assert.deepEqual(event.session.audio.output, { language: "en" });
  assert.equal(event.session.instructions, undefined);
  assert.equal(event.session.output_modalities, undefined);
});

test("dedicated translation mode is the default and does not claim glossary prompting", () => {
  const capabilities = translationEngineCapabilities({ mode: "translate" });
  assert.equal(capabilities.model, "gpt-realtime-translate");
  assert.equal(capabilities.purposeBuiltTranslation, true);
  assert.equal(capabilities.continuous, true);
  assert.equal(capabilities.autoDetectSourceLanguage, true);
  assert.equal(capabilities.glossaryPromptSupported, false);
});

test("prompted compatibility mode advertises glossary prompting", () => {
  const capabilities = translationEngineCapabilities({ mode: "prompted", promptedModel: "gpt-realtime-2.1" });
  assert.equal(capabilities.model, "gpt-realtime-2.1");
  assert.equal(capabilities.glossaryPromptSupported, true);
  assert.equal(capabilities.purposeBuiltTranslation, false);
});

test("legacy generic OPENAI_REALTIME_MODEL cannot accidentally replace translate model", () => {
  const previous = process.env.OPENAI_REALTIME_MODEL;
  process.env.OPENAI_REALTIME_MODEL = "gpt-realtime";
  try {
    assert.equal(translationEngineCapabilities({ mode: "translate" }).model, "gpt-realtime-translate");
  } finally {
    if (previous == null) delete process.env.OPENAI_REALTIME_MODEL;
    else process.env.OPENAI_REALTIME_MODEL = previous;
  }
});

test("factory selects dedicated and prompted session classes deterministically", () => {
  const dedicated = createOpenAIRealtimeFactory({ apiKey: "test", mode: "translate" });
  assert.ok(dedicated({ glossary: [], sourceLanguage: "it", targetLanguage: "en" }) instanceof OpenAITranslationSession);

  const prompted = createOpenAIRealtimeFactory({ apiKey: "test", mode: "prompted" });
  assert.ok(prompted({ glossary: ["ASIN"], sourceLanguage: "it", targetLanguage: "en" }) instanceof OpenAIPromptedRealtimeSession);
});

test("native translation protocol maps input, output transcript and audio events", () => {
  const events = [];
  const session = new OpenAITranslationSession({
    apiKey: "test",
    model: "gpt-realtime-translate",
    targetLanguage: "en",
    onEvent: (event) => events.push(event),
    logger: { error() {} },
  });
  session.handleMessage(JSON.stringify({ type: "session.input_transcript.delta", item_id: "i1", delta: "Buon" }));
  session.handleMessage(JSON.stringify({ type: "session.input_transcript.done", item_id: "i1", transcript: "Buongiorno" }));
  session.handleMessage(JSON.stringify({ type: "session.output_transcript.delta", item_id: "i1", delta: "Good " }));
  session.handleMessage(JSON.stringify({ type: "session.output_transcript.done", item_id: "i1", transcript: "Good morning" }));
  session.handleMessage(JSON.stringify({ type: "session.output_audio.delta", item_id: "i1", delta: "AAAA" }));
  assert.deepEqual(events.map((event) => event.type), [
    "source_transcript.delta",
    "source_transcript.done",
    "transcript.delta",
    "transcript.done",
    "audio.delta",
  ]);
  assert.equal(events[3].transcript, "Good morning");
  assert.equal(events[4].sampleRate, 24000);
});

test("native and prompted backends use different input audio protocol events", () => {
  const nativeMessages = [];
  const native = new OpenAITranslationSession({ apiKey: "test", targetLanguage: "en" });
  native.socket = { send: (value) => nativeMessages.push(JSON.parse(value)) };
  native.sendAudio("AAAA");
  assert.equal(nativeMessages[0].type, "session.input_audio_buffer.append");

  const promptedMessages = [];
  const prompted = new OpenAIPromptedRealtimeSession({ apiKey: "test", sourceLanguage: "it", targetLanguage: "en" });
  prompted.socket = { send: (value) => promptedMessages.push(JSON.parse(value)) };
  prompted.sendAudio("AAAA");
  assert.equal(promptedMessages[0].type, "input_audio_buffer.append");
});
