import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RoomStore } from "../src/room-store.js";

const hostHtml = readFileSync(new URL("../public/host.html", import.meta.url), "utf8");
const hostSource = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
const audienceSource = readFileSync(new URL("../public/audience.js", import.meta.url), "utf8");
const pcmPlaybackSource = readFileSync(new URL("../public/pcm-playback.js", import.meta.url), "utf8");

test("rooms have no application-level participant cap", () => {
  const store = new RoomStore();
  const { room } = store.create({ audiencePin: "2468" });
  const tokens = new Set();
  for (let i = 0; i < 500; i += 1) tokens.add(store.admitAudience(room, "2468"));
  assert.equal(tokens.size, 500);
  assert.equal(room.audienceAdmissions.size, 500);
  assert.equal(store.publicView(room).participantLimit, null);
  assert.equal(store.publicView(room).participantPolicy, "uncapped");
});

test("Host and Audience use the browser-safe PCM translation player", () => {
  assert.match(pcmPlaybackSource, /window\.AudioContext \|\| window\.webkitAudioContext/);
  assert.match(pcmPlaybackSource, /await context\.resume\(\)/);
  assert.match(pcmPlaybackSource, /one-sample silent buffer/);
  assert.match(pcmPlaybackSource, /class PcmQueuePlayer/);
  assert.match(pcmPlaybackSource, /latencyHint: "interactive"/);
  assert.match(hostSource, /PcmQueuePlayer/);
  assert.match(audienceSource, /PcmQueuePlayer/);
  assert.doesNotMatch(hostSource, /createNaturalVoiceChain/);
  assert.doesNotMatch(audienceSource, /createNaturalVoiceChain/);
});

test("Audience reports enough playback telemetry to diagnose captions-only failures", () => {
  assert.match(audienceSource, /audioContextState/);
  assert.match(audienceSource, /receivedChunks/);
  assert.match(audienceSource, /playedChunks/);
  assert.match(audienceSource, /queuedSeconds/);
  assert.match(hostSource, /context \$\{status\.audioContextState/);
});

test("Host can record the shared live video with translated English audio", () => {
  assert.match(hostHtml, /id="record-live"/);
  assert.match(hostHtml, /id="download-live-recording"/);
  assert.match(hostHtml, /id="live-recording-status"/);
  assert.match(hostSource, /class LiveProgramRecorder/);
  assert.match(hostSource, /createMediaStreamDestination/);
  assert.match(hostSource, /new MediaStream\(\[recordedVideoTrack, \.\.\.programAudioTracks\]\)/);
  assert.match(hostSource, /liveProgramRecorder\.enqueue\(event\.audio/);
  assert.match(hostSource, /new MediaRecorder\(this\.stream/);
});
