import fs from "node:fs";
import WebSocket from "ws";

const baseUrl = process.env.BASE_URL || "https://lingua-live.onrender.com";
const pcmPath = process.env.PCM_FILE || "/tmp/lingua-fast-italian.pcm";
const requestedDurationSeconds = Number(process.env.SOAK_SECONDS || 300);
const maxOutputGapMs = Number(process.env.MAX_OUTPUT_GAP_MS || 12_000);
const chunkMs = 200;
const bytesPerChunk = 24_000 * 2 * chunkMs / 1000;
const audio = fs.readFileSync(pcmPath);
const availableSeconds = audio.length / (24_000 * 2);
const durationSeconds = Math.min(requestedDurationSeconds, Math.floor(availableSeconds));
if (durationSeconds < 30) throw new Error(`PCM fixture is too short (${availableSeconds.toFixed(1)}s).`);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function json(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || "GET"} ${url} failed ${response.status}: ${body.error?.message || JSON.stringify(body)}`);
  return body;
}

const created = await json(`${baseUrl}/api/rooms`, {
  method: "POST",
  body: JSON.stringify({ title: "Automated fast-speech soak", sourceLanguage: "it", targetLanguage: "en" }),
});
const code = created.room.code;
const token = created.hostToken;
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.searchParams.set("room", code);
wsUrl.searchParams.set("role", "host");
wsUrl.searchParams.set("clientId", `soak-${Date.now()}`);
wsUrl.searchParams.set("token", token);

const ws = new WebSocket(wsUrl);
const stats = {
  sourceDeltas: 0,
  sourceDone: 0,
  translationDeltas: 0,
  translationDone: 0,
  audioChunks: 0,
  serviceErrors: [],
  clientErrors: [],
  serviceStates: [],
  translationTimes: [],
  audioTimes: [],
};
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const readyTimer = setTimeout(() => readyReject(new Error("Host websocket did not become ready.")), 15_000);

ws.on("open", () => ws.send(JSON.stringify({ type: "client.ready" })));
ws.on("error", (error) => readyReject(error));
ws.on("message", (raw) => {
  let event;
  try { event = JSON.parse(raw.toString()); } catch { return; }
  const now = Date.now();
  if (event.type === "session.ready") { clearTimeout(readyTimer); readyResolve(); }
  if (event.type === "source_transcript.delta") stats.sourceDeltas += 1;
  if (event.type === "source_transcript.done") stats.sourceDone += 1;
  if (event.type === "transcript.delta") { stats.translationDeltas += 1; stats.translationTimes.push(now); }
  if (event.type === "transcript.done") { stats.translationDone += 1; stats.translationTimes.push(now); }
  if (event.type === "audio.delta") { stats.audioChunks += 1; stats.audioTimes.push(now); }
  if (event.type === "service.status") stats.serviceStates.push({ at: now, state: event.state, message: event.message });
  if (event.type === "service.error") stats.serviceErrors.push(event.error || event);
  if (event.type === "client.error") stats.clientErrors.push(event.error || event);
});

let ended = false;
async function cleanup() {
  if (ended) return;
  ended = true;
  try { await json(`${baseUrl}/api/rooms/${code}/end`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" }); } catch {}
  try { ws.close(); } catch {}
}

try {
  await ready;
  await json(`${baseUrl}/api/rooms/${code}/start`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  const startAt = Date.now();
  const totalChunks = Math.floor(durationSeconds * 1000 / chunkMs);

  for (let index = 0; index < totalChunks; index += 1) {
    const offset = index * bytesPerChunk;
    const chunk = audio.subarray(offset, offset + bytesPerChunk);
    if (chunk.length < bytesPerChunk) break;
    if (ws.readyState !== WebSocket.OPEN) throw new Error(`Host websocket closed during source stream at chunk ${index}.`);
    ws.send(JSON.stringify({ type: "audio.append", audio: chunk.toString("base64") }));
    const targetAt = startAt + (index + 1) * chunkMs;
    const sleepFor = targetAt - Date.now();
    if (sleepFor > 0) await sleep(sleepFor);
  }

  const sourceFinishedAt = Date.now();
  await sleep(12_000);
  const allOutputTimes = stats.translationTimes;
  const firstTranslationAt = allOutputTimes[0] || 0;
  const lastTranslationAt = allOutputTimes.at(-1) || 0;
  const firstAudioAt = stats.audioTimes[0] || 0;
  const lastAudioAt = stats.audioTimes.at(-1) || 0;
  let maxTranslationGap = 0;
  for (let index = 1; index < allOutputTimes.length; index += 1) maxTranslationGap = Math.max(maxTranslationGap, allOutputTimes[index] - allOutputTimes[index - 1]);

  const report = {
    room: code,
    durationSeconds,
    sourceAudioSeconds: Number(((sourceFinishedAt - startAt) / 1000).toFixed(1)),
    firstTranslationLatencyMs: firstTranslationAt ? firstTranslationAt - startAt : null,
    firstEvanAudioLatencyMs: firstAudioAt ? firstAudioAt - startAt : null,
    maxTranslationGapMs: maxTranslationGap,
    translationFreshnessAtEndMs: lastTranslationAt ? sourceFinishedAt - lastTranslationAt : null,
    evanFreshnessAtEndMs: lastAudioAt ? sourceFinishedAt - lastAudioAt : null,
    ...stats,
    translationTimes: undefined,
    audioTimes: undefined,
  };
  console.log(JSON.stringify(report, null, 2));

  assert(firstTranslationAt, "No translated transcript output was produced.");
  assert(firstAudioAt, "No Evan audio output was produced.");
  assert(firstTranslationAt - startAt <= 12_000, `First translation took ${firstTranslationAt - startAt}ms.`);
  assert(maxTranslationGap <= maxOutputGapMs, `Translation stalled for ${maxTranslationGap}ms during continuous fast speech.`);
  assert(lastTranslationAt >= startAt + durationSeconds * 1000 * 0.9, "Translated text stopped before the final 10% of the fast-speech run.");
  assert(lastAudioAt >= startAt + durationSeconds * 1000 * 0.9, "Evan audio stopped before the final 10% of the fast-speech run.");
  assert(stats.serviceErrors.length === 0, `Service errors occurred: ${JSON.stringify(stats.serviceErrors)}`);
  assert(stats.clientErrors.length === 0, `Client errors occurred: ${JSON.stringify(stats.clientErrors)}`);
} finally {
  await cleanup();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
