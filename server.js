import "dotenv/config";
import { createLinguaServer } from "./src/app.js";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const lingua = createLinguaServer({
  hostReconnectGraceMs: Number.parseInt(process.env.HOST_RECONNECT_GRACE_MS || "30000", 10),
  roomRetentionMs: Number.parseInt(process.env.ROOM_RETENTION_MS || "3600000", 10),
});

lingua.server.listen(port, () => {
  console.log(`Lingua Live is running at http://localhost:${port}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not configured; rooms can be created, but interpretation cannot start.");
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}; ending active rooms.`);
  await lingua.close();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
