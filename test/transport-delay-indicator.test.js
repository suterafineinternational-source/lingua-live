import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const hostHtml = readFileSync(new URL("../public/host.html", import.meta.url), "utf8");
const transportSource = readFileSync(new URL("../public/low-latency-webrtc.js", import.meta.url), "utf8");
const qualitySource = readFileSync(new URL("../public/quality-bootstrap.js", import.meta.url), "utf8");

test("Host console exposes the live transport and English delay indicators", () => {
  assert.match(hostHtml, /id="transport-mode"/);
  assert.match(hostHtml, /TRANSPORT: WAITING/);
  assert.match(hostHtml, /id="current-english-delay"/);
  assert.match(hostHtml, /Current English delay:/);
});

test("transport indicator distinguishes WebRTC from server fallback", () => {
  assert.match(transportSource, /TRANSPORT: LOW-LATENCY WEBRTC/);
  assert.match(transportSource, /TRANSPORT: SERVER FALLBACK/);
  assert.match(transportSource, /reportTransport\("webrtc"\)/);
  assert.match(transportSource, /reportTransport\("fallback"/);
});

test("English delay combines latest translation onset with playback backlog", () => {
  assert.match(qualitySource, /snapshot\.latestLagMs \+ snapshot\.playbackBufferSeconds \* 1000/);
  assert.match(qualitySource, /Current English delay: \$\{seconds\.toFixed\(2\)\} s/);
});
