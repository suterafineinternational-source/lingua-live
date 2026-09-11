import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLinguaServer } from "../src/app.js";
import { createFakeRealtimeFactory, createRoom, listen, requestJson } from "./helpers.js";

const running = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

test("room lifecycle is host-authorized and start/end are idempotent", async () => {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory, publicBaseUrl: "https://example.test", staticMaxAge: 0 });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl, ["Sutera = Sutera"]);

  assert.match(created.room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.room.status, "created");
  assert.deepEqual(created.room.glossary, ["Sutera = Sutera"]);
  assert.equal(created.inviteUrl, `https://example.test/audience/${created.room.code}`);
  assert.ok(created.hostToken.length >= 40);

  const publicRoom = await requestJson(baseUrl, `/api/rooms/${created.room.code}`);
  assert.equal(publicRoom.response.status, 200);
  assert.equal(publicRoom.body.room.code, created.room.code);
  assert.equal("hostToken" in publicRoom.body, false);
  assert.equal("glossary" in publicRoom.body.room, false);

  const unauthorized = await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, { method: "POST" });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, "HOST_TOKEN_REQUIRED");

  const forbidden = await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error.code, "HOST_TOKEN_INVALID");

  const auth = { Authorization: `Bearer ${created.hostToken}` };
  const started = await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.room.status, "live");
  assert.equal(realtimeFactory.sessions.length, 1);

  await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, { method: "POST", headers: auth });
  assert.equal(realtimeFactory.sessions.length, 1, "a duplicate start must reuse the live session");

  const updated = await requestJson(baseUrl, `/api/rooms/${created.room.code}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ glossary: ["Comune = Municipality", "Comune = Municipality"] }),
  });
  assert.deepEqual(updated.body.room.glossary, ["Comune = Municipality"]);
  assert.deepEqual(realtimeFactory.sessions[0].glossaries, [["Comune = Municipality"]]);

  const ended = await requestJson(baseUrl, `/api/rooms/${created.room.code}/end`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(ended.body.room.status, "ended");
  assert.equal(realtimeFactory.sessions[0].closed, 1);

  await requestJson(baseUrl, `/api/rooms/${created.room.code}/end`, { method: "POST", headers: auth });
  assert.equal(realtimeFactory.sessions[0].closed, 1, "a duplicate end must not close resources twice");
});

test("missing server API key produces a structured safe error", async () => {
  const lingua = createLinguaServer({ apiKey: "", staticMaxAge: 0 });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const result = await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.hostToken}` },
  });
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.body, {
    error: {
      code: "OPENAI_API_KEY_MISSING",
      message: "Live interpretation is unavailable until OPENAI_API_KEY is configured.",
      retriable: false,
    },
  });
  assert.equal(lingua.rooms.get(created.room.code).status, "created");
  assert.equal(lingua.rooms.get(created.room.code).startPromise, null);
});

test("audience assets and public APIs never expose server secrets or host credentials", async () => {
  const secret = "test-api-secret-never-send";
  const lingua = createLinguaServer({ apiKey: secret, realtimeFactory: createFakeRealtimeFactory(), staticMaxAge: 0 });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl, ["private glossary"]);

  for (const path of [`/audience/${created.room.code}`, "/audience.js", `/api/rooms/${created.room.code}`]) {
    const response = await fetch(`${baseUrl}${path}`);
    const text = await response.text();
    assert.equal(text.includes(secret), false, `${path} exposed the API key`);
    assert.equal(text.includes(created.hostToken), false, `${path} exposed the host credential`);
  }
});
