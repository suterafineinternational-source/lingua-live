import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { once } from "node:events";
import WebSocket from "ws";
import { createLinguaServer } from "../src/app.js";
import {
  connectWebSocket,
  createFakeRealtimeFactory,
  createRoom,
  delay,
  listen,
  requestJson,
} from "./helpers.js";

const running = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

test("translated captions and audio fan out to multiple listeners while audience input is denied", async () => {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const auth = { Authorization: `Bearer ${created.hostToken}` };
  await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, { method: "POST", headers: auth });

  const host = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "host",
    clientId: "hostclient01",
    token: created.hostToken,
  });
  const audienceOne = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "audience",
    clientId: "audience01",
  });
  const audienceTwo = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "audience",
    clientId: "audience02",
  });
  await Promise.all([
    host.waitFor((event) => event.type === "session.ready"),
    audienceOne.waitFor((event) => event.type === "session.ready"),
    audienceTwo.waitFor((event) => event.type === "session.ready"),
  ]);
  await audienceOne.waitFor((event) => event.type === "presence" && event.listenerCount === 2);

  const session = realtimeFactory.sessions[0];
  session.emit({ type: "transcript.delta", responseId: "response-1", itemId: "item-1", delta: "Good evening" });
  session.emit({ type: "audio.delta", responseId: "response-1", itemId: "item-1", audio: "AAECAw==", format: "pcm16", sampleRate: 24000 });
  session.emit({ type: "transcript.done", responseId: "response-1", itemId: "item-1", transcript: "Good evening." });

  for (const audience of [audienceOne, audienceTwo]) {
    assert.equal((await audience.waitFor((event) => event.type === "transcript.delta")).delta, "Good evening");
    assert.equal((await audience.waitFor((event) => event.type === "audio.delta")).audio, "AAECAw==");
    assert.equal((await audience.waitFor((event) => event.type === "transcript.done")).transcript, "Good evening.");
  }

  audienceOne.send(JSON.stringify({ type: "audio.append", audio: "forbidden" }));
  const denied = await audienceOne.waitFor((event) => event.type === "client.error");
  assert.equal(denied.error.code, "FORBIDDEN_MESSAGE");
  assert.deepEqual(session.audio, []);

  host.send(JSON.stringify({ type: "audio.append", audio: "AAEC" }));
  await delay(10);
  assert.deepEqual(session.audio, ["AAEC"]);

  host.send("not json");
  const malformed = await host.waitFor((event) => event.type === "client.error");
  assert.equal(malformed.error.code, "INVALID_MESSAGE_JSON");

  const reconnected = connectWebSocket(baseUrl, {
    room: created.room.code,
    role: "audience",
    clientId: "audience01",
  });
  const ready = await reconnected.waitFor((event) => event.type === "session.ready");
  assert.equal(ready.room.listenerCount, 2, "reconnect must replace, not duplicate, the listener");
  assert.equal(ready.history[0].transcript, "Good evening.");
  assert.equal((await once(audienceOne, "close"))[0], 4001);

  const endedEvent = reconnected.waitFor((event) => event.type === "room.ended");
  await requestJson(baseUrl, `/api/rooms/${created.room.code}/end`, { method: "POST", headers: auth });
  assert.equal((await endedEvent).room.status, "ended");
});

test("host reconnect grace reuses the session and later releases it cleanly", async () => {
  const realtimeFactory = createFakeRealtimeFactory();
  const lingua = createLinguaServer({ realtimeFactory, hostReconnectGraceMs: 40 });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const auth = { Authorization: `Bearer ${created.hostToken}` };
  await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, { method: "POST", headers: auth });

  const connection = {
    room: created.room.code,
    role: "host",
    clientId: "stablehost01",
    token: created.hostToken,
  };
  const first = connectWebSocket(baseUrl, connection);
  await first.waitFor((event) => event.type === "session.ready");
  first.close();
  await once(first, "close");
  await delay(10);

  const second = connectWebSocket(baseUrl, connection);
  await second.waitFor((event) => event.type === "session.ready");
  await delay(100);
  assert.equal(realtimeFactory.sessions.length, 1);
  assert.equal(realtimeFactory.sessions[0].closed, 0);
  assert.equal(lingua.rooms.get(created.room.code).status, "live");

  second.close();
  await once(second, "close");
  await delay(100);
  assert.equal(lingua.rooms.get(created.room.code).status, "paused");
  assert.equal(realtimeFactory.sessions[0].closed, 1);

  await requestJson(baseUrl, `/api/rooms/${created.room.code}/start`, { method: "POST", headers: auth });
  assert.equal(realtimeFactory.sessions.length, 2);
  assert.equal(lingua.rooms.get(created.room.code).status, "live");
});

test("a host WebSocket requires the separate host credential", async () => {
  const lingua = createLinguaServer({ realtimeFactory: createFakeRealtimeFactory() });
  running.push(lingua);
  const baseUrl = await listen(lingua);
  const created = await createRoom(baseUrl);
  const url = new URL("/ws", baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("room", created.room.code);
  url.searchParams.set("role", "host");
  url.searchParams.set("clientId", "hostclient01");
  url.searchParams.set("token", "wrong");

  const ws = new WebSocket(url);
  const [, response] = await once(ws, "unexpected-response");
  assert.equal(response.statusCode, 403);
  response.resume();
});
