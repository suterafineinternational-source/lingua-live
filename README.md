# Lingua Live

Lingua Live hosts one-way, live Italian → English interpretation rooms. A Host publishes microphone audio; any number of Audience browsers receive translated English captions and PCM audio over a room-scoped WebSocket.

## Requirements

- Node.js 20 or newer
- An OpenAI API key with access to the Realtime API
- HTTPS in production (browsers require a secure context for microphone access)

## Local setup

```bash
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, then run:

```bash
npm run dev
```

Open [http://localhost:3000/host](http://localhost:3000/host). Room creation and the UI still work without a key; starting interpretation returns a structured configuration error.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_BASE_URL` | Request origin | Canonical origin used for invite URLs and QR codes |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime model alias |
| `HOST_RECONNECT_GRACE_MS` | `30000` | Time to retain the upstream session while a host reconnects |
| `ROOM_RETENTION_MS` | `3600000` | Time to retain ended room metadata in memory |

Never put `OPENAI_API_KEY` in browser code, a query string, or a public deployment setting. It is read only by the Node server and used on its server-to-server Realtime WebSocket.

## Use

1. Open `/host`, optionally enter glossary terms, and select **Create host room**.
2. Share the invite URL or QR code. Audience members can join before the room starts and wait at `/audience/:code`.
3. Select **Start interpretation** and allow microphone access.
4. Each audience member selects **Enable translated audio** once. This user gesture is required by browser autoplay policies; captions do not require it.
5. Select **End room** when finished. The upstream session and every room socket close cleanly.

The Host tab keeps its separate host credential in `sessionStorage`, so refreshing the same tab can restore control. A room code alone grants audience access only.

## Manual multi-browser test

1. Start the server and open `/host` in browser A.
2. Create a room and open its invite URL in browser B (or an incognito window).
3. Open the same invite in browser C. Verify the host shows two listeners.
4. Enable translated audio in B and C, then start interpretation in A.
5. Speak Italian. Verify both audience windows receive incremental English captions and translated audio.
6. Refresh B. Verify its listener count does not duplicate and completed captions are restored.
7. Briefly refresh A. Verify the live session survives during the reconnect grace period. Leave A disconnected beyond the grace period and verify the room pauses and releases the upstream connection; reconnect and select Start to resume.
8. End the room in A. Verify B and C display the ended state and stop reconnecting.

## Tests

```bash
npm test
```

The test suite covers the create/start/update/end lifecycle, host authorization, missing-key errors, secret non-disclosure, multi-listener caption/audio fan-out, audience write denial, stable reconnect identity, transcript replay, host reconnect grace, and upstream resource cleanup. The OpenAI network is replaced by a deterministic fake in tests; no API key or billable request is used.

## Routes and protocol

- `GET /host` — Host UI
- `GET /audience/:code` — Audience UI
- `POST /api/rooms` — Create a room and return its one-time host credential
- `GET /api/rooms/:code` — Public, safe room status
- `PATCH /api/rooms/:code` — Host-only glossary update
- `POST /api/rooms/:code/start` — Host-only interpretation start/resume
- `POST /api/rooms/:code/end` — Host-only room shutdown
- `GET /api/rooms/:code/qr` — Invite QR image
- `GET /health` — Health check
- `GET /ws?...` — Host or audience WebSocket

API failures use `{ "error": { "code", "message", "retriable" } }`. WebSocket status, protocol, and error messages are similarly typed. Browser reconnect uses exponential backoff with jitter; the OpenAI connection uses bounded exponential backoff.

See [docs/architecture.md](docs/architecture.md) for transport, scaling, reconnect, and security tradeoffs.

## Production notes

This milestone intentionally uses an in-memory room registry for simple local startup and a single Node process. Use sticky routing for a single replicated deployment. Before running multiple independent server instances, replace the registry/publisher boundary with shared presence and pub/sub as described in the architecture document.

Terminate TLS at the app or proxy, forward WebSocket upgrades, set `PUBLIC_BASE_URL` to the public HTTPS origin, and provide `OPENAI_API_KEY` through the host's secret manager. Do not persist host tokens in logs. The current host token is SHA-256 hashed in memory and compared in constant time.
