# Realtime room architecture

## Data flow

```text
Host microphone
    │ PCM16 mono, 24 kHz
    ▼
Host WebSocket ── host token ──► Node room coordinator
                                      │
                                      │ one server-side WebSocket per live room
                                      ▼
                              OpenAI Realtime API
                                      │
                         caption + PCM audio deltas
                                      ▼
                             room broadcast loop
                              ╱       │       ╲
                         Audience  Audience  Audience
```

The browser capture worklet resamples microphone input to signed little-endian PCM16 mono at 24 kHz. The server appends those base64 chunks to a single Realtime session configured for Italian input and English audio output. `response.output_audio_transcript.*` events become captions and `response.output_audio.*` events become translated audio.

This follows the official [Realtime API](https://platform.openai.com/docs/guides/realtime) and [Realtime server event](https://platform.openai.com/docs/api-reference/realtime-server-events) shapes. The model connection is server-side, so the standard API key is never sent to Host or Audience browsers.

## Fan-out choice

The server uses one translation/model stream per room, then copies each translated delta to all connected audience WebSockets. This is materially more scalable and cheaper than giving every listener an independent model session: model work and source audio ingestion remain constant as listeners join.

The implemented local transport is deliberately simple:

- JSON WebSocket messages carry caption deltas and base64 PCM chunks.
- A listener with more than 1 MiB buffered output stops receiving audio chunks until it catches up. It receives a typed `LISTENER_TOO_SLOW` notice instead of forcing unbounded memory growth for the whole room.
- Completed captions are retained in a bounded 100-event room history for reconnect replay. Audio is live-only and is not replayed.
- The Node process performs O(listener count) socket writes per output chunk. This is appropriate for small/medium rooms and preserves simple `npm start` operation.

For large rooms or horizontal scaling, keep the same browser protocol and replace only the room broadcast boundary:

1. Store lifecycle, hashed host credentials, and presence leases in Redis or another shared store.
2. Acquire a distributed per-room lease so exactly one worker owns the upstream Realtime session.
3. Publish captions and audio chunks once to a room topic (Redis Streams, NATS, or Kafka).
4. Let WebSocket edge workers subscribe to that topic and fan out only to their local listeners.
5. For very large audiences, package audio into short Opus/AAC segments and deliver it through an LL-HLS/WebRTC media tier or CDN while retaining WebSockets for captions and state.

PCM over JSON avoids codecs and Media Source complexity for this milestone, but costs roughly 768 kbit/s per listener after base64 overhead at 24 kHz mono. Opus/WebRTC is the natural next transport when bandwidth or audience size dominates.

## Lifecycle and reconnect

Rooms move through `created → starting → live → paused → live → ended`.

- Starting twice is idempotent and never creates a second upstream session.
- A stable `clientId` replaces the prior socket for that browser/role. Replacement does not increment presence.
- Browser reconnect uses exponential backoff with jitter, capped at 10 seconds.
- Upstream reconnect uses exponential backoff capped at 8 seconds and queues a bounded amount of host audio.
- A lost Host socket gets a configurable grace period. Reconnecting during the grace window reuses the same upstream session. On expiry, the room pauses and closes the upstream session to avoid leaks.
- Ending is idempotent: timers and the upstream session are closed, an ending event is broadcast, and all room sockets are closed.
- Ended rooms are retained briefly so stale invite URLs receive a clean ended state, then pruned.

## Authorization boundary

The six-character room code is an invitation capability for audience read access. Host mutation requires an independent 256-bit random token returned only by room creation. Its SHA-256 digest—not the raw token—is held by the room store, and comparisons are constant-time.

Host REST routes require `Authorization: Bearer …`. The Host WebSocket authenticates at upgrade time. Audience sockets accept only readiness and ping messages; microphone audio and all controls return `FORBIDDEN_MESSAGE`. Public room views omit the host credential and glossary, and audience assets have no configuration endpoint that returns the OpenAI key.

Production deployments must use HTTPS/WSS. Because browsers cannot add an `Authorization` header to WebSocket handshakes, the host token is sent in the WSS query during upgrade; disable query-string access logging for `/ws`, and rely on TLS. A future cookie-backed host session can remove it from the upgrade URL entirely.
