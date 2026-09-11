# Production event milestone

## Security boundary

Host control remains protected by the independent host token. Audience PINs are never returned by public room status; successful PIN validation returns a short-lived random admission token. Standard OpenAI API keys remain server-side only. Public API calls are body-limited and rate-limited, and responses use no-store caching.

## Transcript model

Source text is accepted only from official Realtime input-audio transcription events. Translation rows come from Realtime output-audio transcript events. Rows are associated by item id when available and exported with timestamps. Missing sides remain blank.

## Storage contract

`src/storage.js` provides an async adapter contract:

- `saveEvent(event)`
- `appendTranscript(roomCode, row)`
- `getTranscript(roomCode)`

The bundled adapter is in-memory for development. A production deployment should implement the contract with Postgres, DynamoDB, SQLite/Turso, or another durable store and pass it to `createLinguaServer({ storage })`.

## Browser capture

Microphone capture uses `getUserMedia`. Tab/system capture uses `getDisplayMedia({ video: true, audio: true })` because browsers generally require a video-sharing surface to expose tab/system audio. The UI explicitly fails when the browser returns no audio track.

## Next production steps

Before broad public deployment, add durable room/presence storage, centralized rate limiting, deployment secret management, observability/metrics, and large-audience encoded audio fan-out. Meeting-platform bots and billing remain separate milestones.
