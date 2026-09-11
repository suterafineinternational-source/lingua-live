import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeQualityMonitor, qualityLabel } from "../public/quality-monitor.js";

function clock() {
  let value = 0;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test("quality monitor calculates rolling speech pace and translation lag", () => {
  const time = clock();
  const monitor = new RealtimeQualityMonitor({ now: time.now, windowMs: 30000 });
  monitor.recordCaptureTotals(40, 35);
  for (let i = 0; i < 40; i += 1) monitor.recordInputSent();
  monitor.recordSourceDelta("a");
  time.advance(1000);
  monitor.recordSourceDone("a", "one two three four five six seven eight nine ten");
  time.advance(500);
  monitor.recordTranslationDelta("a");
  monitor.recordTranslationDone();
  monitor.recordAudioChunk();
  time.advance(3500);
  monitor.recordSourceDone("b", "one two three four five six seven eight nine ten");
  const snapshot = monitor.snapshot({ playbackBufferSeconds: 0.4 });
  assert.equal(snapshot.averageLagMs, 1500);
  assert.ok(snapshot.wpm > 0);
  assert.equal(snapshot.inputDrops, 0);
  assert.equal(snapshot.audioChunks, 1);
});

test("quality monitor flags relay loss and growing backlog", () => {
  const time = clock();
  const monitor = new RealtimeQualityMonitor({ now: time.now });
  monitor.recordCaptureTotals(100, 90);
  for (let i = 0; i < 95; i += 1) monitor.recordInputSent();
  monitor.recordSourceDelta("a");
  time.advance(6000);
  monitor.recordTranslationDelta("a");
  monitor.recordAudioChunk();
  const snapshot = monitor.snapshot({ playbackBufferSeconds: 6 });
  assert.equal(snapshot.inputDrops, 5);
  assert.equal(snapshot.health, "critical");
  assert.equal(qualityLabel(snapshot), "BACKLOG");
});

test("healthy stream passes thresholds", () => {
  const time = clock();
  const monitor = new RealtimeQualityMonitor({ now: time.now });
  monitor.recordCaptureTotals(50, 45);
  for (let i = 0; i < 50; i += 1) monitor.recordInputSent();
  monitor.recordSourceDelta("a");
  time.advance(900);
  monitor.recordTranslationDelta("a");
  monitor.recordTranslationDone();
  monitor.recordAudioChunk();
  const snapshot = monitor.snapshot({ playbackBufferSeconds: 0.5 });
  assert.equal(snapshot.health, "healthy");
  assert.equal(qualityLabel(snapshot), "HEALTHY");
});
