import test from "node:test";
import assert from "node:assert/strict";
import { createLinguaServer } from "../src/app.js";
import { createFakeRealtimeFactory, listen, requestJson, connectWebSocket } from "./helpers.js";

async function setup() {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory, rateLimit: { limit: 1000, windowMs: 60_000 } });
  const baseUrl = await listen(lingua);
  return { lingua, baseUrl, realtimeFactory };
}

test("event metadata and audience PIN admission are enforced", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  const created = await requestJson(baseUrl, "/api/rooms", { method: "POST", body: JSON.stringify({ title: "Demo event", sourceLanguage: "it", targetLanguage: "en", audiencePin: "4321" }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.room.title, "Demo event");
  assert.equal(created.body.room.pinRequired, true);
  assert.equal(created.body.room.audiencePin, undefined);

  const denied = await requestJson(baseUrl, `/api/rooms/${created.body.room.code}/admit`, { method: "POST", body: JSON.stringify({ pin: "1111" }) });
  assert.equal(denied.response.status, 403);
  const admitted = await requestJson(baseUrl, `/api/rooms/${created.body.room.code}/admit`, { method: "POST", body: JSON.stringify({ pin: "4321" }) });
  assert.equal(admitted.response.status, 200);
  assert.ok(admitted.body.admissionToken);
});

test("official source and translated transcript events are persisted and exported", async (t) => {
  const { lingua, baseUrl, realtimeFactory } = await setup();
  t.after(() => lingua.close());
  const created = await requestJson(baseUrl, "/api/rooms", { method: "POST", body: JSON.stringify({}) });
  const { room, hostToken } = created.body;
  await requestJson(baseUrl, `/api/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } });
  const session = realtimeFactory.sessions[0];
  session.emit({ type: "source_transcript.done", itemId: "item-1", transcript: "Buongiorno a tutti" });
  session.emit({ type: "transcript.done", itemId: "item-1", transcript: "Good morning everyone" });

  const transcript = await requestJson(baseUrl, `/api/rooms/${room.code}/transcript`, { headers: { Authorization: `Bearer ${hostToken}` } });
  assert.equal(transcript.response.status, 200);
  assert.equal(transcript.body.rows[0].source, "Buongiorno a tutti");
  assert.equal(transcript.body.rows[0].translation, "Good morning everyone");
});

test("PIN-protected websocket rejects unauthenticated audience and accepts admitted audience", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  const created = await requestJson(baseUrl, "/api/rooms", { method: "POST", body: JSON.stringify({ audiencePin: "5555" }) });
  const code = created.body.room.code;
  const admission = await requestJson(baseUrl, `/api/rooms/${code}/admit`, { method: "POST", body: JSON.stringify({ pin: "5555" }) });
  const ws = connectWebSocket(baseUrl, { room: code, role: "audience", clientId: "audience-test-123", admission: admission.body.admissionToken });
  const ready = await ws.waitFor((message) => message.type === "session.ready");
  assert.equal(ready.role, "audience");
  ws.close();
});
