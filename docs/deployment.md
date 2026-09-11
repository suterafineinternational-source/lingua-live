# Production deployment

Lingua Live runs as a single Node.js service with HTTP + WebSocket upgrades. The included `Dockerfile` is suitable for container platforms that support long-lived WebSockets.

## Required configuration

- `OPENAI_API_KEY`: server-only secret with Realtime API access
- `PUBLIC_BASE_URL`: public HTTPS origin, for example `https://live.example.com`
- `PORT`: normally `3000`
- `HOST_RECONNECT_GRACE_MS`: default `30000`
- `ROOM_RETENTION_MS`: default `3600000`

Terminate TLS at the platform/load balancer and forward WebSocket upgrades. Do not log `/ws` query strings because the host WebSocket contains a short-lived host credential in its query string.

## Health and observability

- `/health` — liveness probe
- `/ready` — readiness + current room count
- `/metrics` — Prometheus text format; does not include secrets or transcript contents

Recommended alerts: upstream error rate, reconnect spikes, backpressure drops, listener count, live-room count and container memory.

## Docker

```bash
docker build -t lingua-live .
docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY \
  -e PUBLIC_BASE_URL=https://live.example.com \
  lingua-live
```

## Horizontal scaling

The current room registry is process-local. For one replica, no shared state is needed. Before running multiple active replicas:

1. Move room metadata, host credential hashes, audience admission leases and presence leases to a shared store such as Redis.
2. Use a distributed per-room lease so exactly one worker owns each OpenAI Realtime session.
3. Publish caption/audio events once per room to Redis Streams, NATS or Kafka.
4. Let WebSocket edge replicas subscribe and fan out only to their local listeners.
5. For large audiences, replace base64 PCM fan-out with encoded Opus/WebRTC or low-latency segmented media/CDN delivery.

The existing browser protocol and storage interfaces are intentionally separated so these backends can be replaced without redesigning the Host/Audience UI.

## Broadcast outputs

- Embeddable player: `/embed.html?room=ROOMCODE`
- OBS/browser-source captions: `/captions.html?room=ROOMCODE`
- SSE captions: `/api/rooms/ROOMCODE/captions.sse`
- WebVTT snapshot: `/api/rooms/ROOMCODE/captions.vtt`

For PIN-protected rooms, SSE/WebVTT require a short-lived audience admission token. The HTML browser-source flow prompts for the PIN rather than putting the PIN itself in the URL.

## Load smoke test

With a server running locally:

```bash
LISTENERS=50 BASE_URL=http://127.0.0.1:3000 node scripts/load-smoke.mjs
```

This verifies simultaneous audience WebSocket admission/presence. It is a smoke test, not a substitute for production network/load testing with translated audio enabled.
