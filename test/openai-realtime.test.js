import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionUpdate, translationInstructions } from "../src/openai-realtime.js";

test("Realtime session requests 24 kHz audio output and server VAD responses", () => {
  const event = sessionUpdate("gpt-realtime", ["Sutera = Sutera"]);
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
