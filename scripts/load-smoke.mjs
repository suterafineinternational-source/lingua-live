import WebSocket from "ws";

const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const listeners = Number(process.env.LISTENERS || 25);
const created = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
if (!created.ok) throw new Error(`room create failed: ${created.status}`);
const payload = await created.json();
const code = payload.room.code;
const admitted = await fetch(`${base}/api/rooms/${code}/admit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const admission = await admitted.json();
const sockets = [];
let ready = 0;
for (let index = 0; index < listeners; index += 1) {
  const url = new URL("/ws", base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", code); url.searchParams.set("role", "audience"); url.searchParams.set("clientId", `load-${index}-${Date.now()}`); url.searchParams.set("admission", admission.admissionToken);
  const ws = new WebSocket(url); sockets.push(ws);
  ws.on("message", (data) => { const event = JSON.parse(data); if (event.type === "session.ready") ready += 1; });
}
const deadline = Date.now() + 8000;
while (ready < listeners && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify({ room: code, requested: listeners, ready, success: ready === listeners }));
for (const ws of sockets) ws.close();
process.exitCode = ready === listeners ? 0 : 1;
