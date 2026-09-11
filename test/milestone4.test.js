import test from "node:test";
import assert from "node:assert/strict";
import { createLinguaServer } from "../src/app.js";
import { createFakeRealtimeFactory, listen, requestJson } from "./helpers.js";

async function setup() {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory, rateLimit: { limit: 1000, windowMs: 60000 } });
  const baseUrl = await listen(lingua);
  return { lingua, baseUrl, realtimeFactory };
}

test("health, readiness and prometheus metrics are exposed without secrets", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  const before = await fetch(`${baseUrl}/metrics`).then((r) => r.text());
  assert.match(before, /lingua_active_rooms 0/);
  assert.doesNotMatch(before, /OPENAI_API_KEY|hostToken|sk-/);
  await requestJson(baseUrl, "/api/rooms", { method: "POST", body: "{}" });
  const after = await fetch(`${baseUrl}/metrics`).then((r) => r.text());
  assert.match(after, /lingua_rooms_created_total 1/);
  assert.match(after, /lingua_active_rooms 1/);
});

test("completed translation captions are available as WebVTT", async (t) => {
  const { lingua, baseUrl, realtimeFactory } = await setup();
  t.after(() => lingua.close());
  const created = await requestJson(baseUrl, "/api/rooms", { method: "POST", body: "{}" });
  const { room, hostToken } = created.body;
  await requestJson(baseUrl, `/api/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } });
  realtimeFactory.sessions[0].emit({ type: "transcript.done", itemId: "vtt-1", transcript: "Good evening everyone" });
  const response = await fetch(`${baseUrl}/api/rooms/${room.code}/captions.vtt`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /^WEBVTT/);
  assert.match(text, /Good evening everyone/);
});

test("embed and OBS caption surfaces are served", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  assert.equal((await fetch(`${baseUrl}/embed.html?room=ABC123`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/captions.html?room=ABC123`)).status, 200);
});
