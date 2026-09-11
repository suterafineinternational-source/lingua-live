import test from "node:test";
import assert from "node:assert/strict";
import { createLinguaServer } from "../src/app.js";
import { createFakeRealtimeFactory, listen, requestJson } from "./helpers.js";

async function setup() {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory, rateLimit: { limit: 1000, windowMs: 60_000 } });
  const baseUrl = await listen(lingua);
  return { lingua, baseUrl, realtimeFactory };
}

test("invalid scheduledAt returns a typed 400 error", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  const result = await requestJson(baseUrl, "/api/rooms", {
    method: "POST",
    body: JSON.stringify({ scheduledAt: "definitely-not-a-date" }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_SCHEDULE");
});

test("integration capability endpoint exposes status but no credentials", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  const response = await fetch(`${baseUrl}/api/integrations`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.integrations.some((item) => item.id === "browser-capture" && item.status === "available"));
  assert.ok(body.integrations.some((item) => item.id === "zoom" && item.requiresCredentials));
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /client_secret|api_key|access_token|sk-/i);
});

test("embed framing is public while audience is same-origin and host remains denied", async (t) => {
  const { lingua, baseUrl } = await setup();
  t.after(() => lingua.close());
  const created = await requestJson(baseUrl, "/api/rooms", { method: "POST", body: "{}" });
  const code = created.body.room.code;
  const embed = await fetch(`${baseUrl}/embed.html?room=${code}`);
  assert.equal(embed.status, 200);
  assert.equal(embed.headers.get("x-frame-options"), null);
  assert.match(embed.headers.get("content-security-policy"), /frame-ancestors \*/);
  const audience = await fetch(`${baseUrl}/audience/${code}`);
  assert.equal(audience.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(audience.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  const host = await fetch(`${baseUrl}/host`);
  assert.equal(host.headers.get("x-frame-options"), "DENY");
});

test("authenticated host can download structured event summary", async (t) => {
  const { lingua, baseUrl, realtimeFactory } = await setup();
  t.after(() => lingua.close());
  const created = await requestJson(baseUrl, "/api/rooms", { method: "POST", body: JSON.stringify({ title: "Summary demo" }) });
  const { room, hostToken } = created.body;
  await requestJson(baseUrl, `/api/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` } });
  realtimeFactory.sessions[0].emit({ type: "source_transcript.done", itemId: "sum-1", transcript: "Ciao" });
  realtimeFactory.sessions[0].emit({ type: "transcript.done", itemId: "sum-1", transcript: "Hello" });
  const response = await fetch(`${baseUrl}/api/rooms/${room.code}/summary`, { headers: { Authorization: `Bearer ${hostToken}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.event.title, "Summary demo");
  assert.equal(body.summary.transcriptRows, 1);
  assert.equal(body.transcript[0].source, "Ciao");
  assert.equal(body.transcript[0].translation, "Hello");
});
