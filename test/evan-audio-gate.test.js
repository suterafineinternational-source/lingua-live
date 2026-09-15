import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const audienceHtml = readFileSync(new URL("../public/audience.html", import.meta.url), "utf8");
const audienceSource = readFileSync(new URL("../public/audience.js", import.meta.url), "utf8");

test("Audience requires a user gesture before entering so Evan audio can be unlocked", () => {
  assert.match(audienceHtml, /Join event with Evan audio/);
  assert.match(audienceHtml, /id="webinar-stage" class="webinar-stage hidden"/);
  assert.match(audienceHtml, /id="listener-bar" class="listener-bar hidden"/);
  assert.match(audienceSource, /await player\.enable\(\);[\s\S]*if \(!admissionToken\) await admit/);
  assert.match(audienceSource, /Browser autoplay policies require this to happen directly inside the user click/);
  assert.match(audienceSource, /elements\.webinarStage\.classList\.remove\("hidden"\)/);
  assert.match(audienceSource, /elements\.listenerBar\.classList\.remove\("hidden"\)/);
});

test("Audience keeps explicit Evan playback diagnostics", () => {
  assert.match(audienceSource, /Evan audio LIVE/);
  assert.match(audienceSource, /receivedChunks/);
  assert.match(audienceSource, /scheduledChunks/);
  assert.match(audienceSource, /audioContextState/);
});
