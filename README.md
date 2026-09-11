# Lingua Live

Lingua Live is a clean-room realtime interpretation platform inspired by publicly documented professional interpretation workflows. A Host creates an event and streams source audio; Audience browsers receive translated captions and synthesized translated audio from a single server-owned OpenAI Realtime session per room.

## Current feature set

- Host and Audience interfaces
- Event title, schedule, source/target language metadata
- Italian → English fully configured default, with language-pair architecture ready for additional supported pairs
- Microphone or browser-tab/system audio capture where the browser supports `getDisplayMedia`
- Live source transcript plus translated transcript in the Host console
- Live translated captions and PCM audio for Audience listeners
- Optional 4-8 digit audience PIN with short-lived admission tokens
- Invite link and QR code
- Listener presence, reconnect/backoff, bounded audio backpressure, cleanup lifecycle
- Live glossary updates
- Transcript export as timestamped CSV
- Storage abstraction with in-memory development adapter
- Security headers, body limits, public API rate limiting and secret isolation
- Automated lifecycle/fan-out/auth/PIN/transcript tests and GitHub Actions CI

## Requirements

- Node.js 20+
- An OpenAI API key with Realtime API access
- HTTPS/WSS in production for microphone/display-capture APIs

## Local setup

```bash
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, then:

```bash
npm run dev
```

Open `http://localhost:3000/host`.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_BASE_URL` | Request origin | Public origin used for invite URLs and QR codes |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime model alias |
| `HOST_RECONNECT_GRACE_MS` | `30000` | Keep upstream translation alive during short host reconnects |
| `ROOM_RETENTION_MS` | `3600000` | Retain ended room metadata before pruning |

Never expose `OPENAI_API_KEY` to browser code, query strings, logs, or public environment variables. The standard API key is only used server-to-server.

## Host flow

1. Open `/host`.
2. Enter event title, optional schedule, language pair, optional audience PIN, glossary, and choose microphone or tab/system audio.
3. Create the event and share the invite link/QR code.
4. Start interpretation and grant the requested browser permission.
5. Monitor source transcript, translation, listener count and service state.
6. Update glossary terms during the event if needed.
7. Download the timestamped CSV transcript.
8. End the event to release the upstream session and listener sockets.

## Audience flow

1. Open `/audience/:code` from the host invite.
2. If the event is protected, enter the audience PIN.
3. Enable translated audio once to satisfy browser autoplay policies.
4. Read live translated captions, control volume and reconnect automatically if the network drops.

## Browser audio notes

Microphone capture uses `getUserMedia`. Browser-tab/system audio uses the documented `getDisplayMedia` API and depends on browser/OS support. Some browsers expose screen sharing without an audio track; Lingua Live reports that explicitly instead of silently continuing.

## Transcripts

Source text comes only from official Realtime input-audio transcription events. Lingua Live never fabricates source text. Translation comes from Realtime output-audio transcript events. Export preserves blank source/translation cells when one side has not arrived yet.

## Tests and CI

```bash
npm test
npm audit --audit-level=high
```

GitHub Actions runs installation, tests, dependency audit and JavaScript syntax checks on pull requests and `main`.

## Important routes

- `GET /host`
- `GET /audience/:code`
- `POST /api/rooms`
- `GET /api/rooms/:code`
- `POST /api/rooms/:code/admit`
- `PATCH /api/rooms/:code`
- `POST /api/rooms/:code/start`
- `POST /api/rooms/:code/end`
- `GET /api/rooms/:code/transcript`
- `GET /api/rooms/:code/transcript.csv`
- `GET /api/rooms/:code/qr`
- `GET /health`
- `GET /ws?...`

## Production architecture

The live room registry remains in memory for a simple single-process deployment. Event/transcript persistence is behind an async storage contract (`src/storage.js`) so a database adapter can replace the in-memory adapter without changing the room protocol. For horizontal scale, move room presence/leases to Redis or equivalent, publish caption/audio events through shared pub/sub, and move large-audience audio to an Opus/WebRTC or low-latency streaming tier.

See `docs/architecture.md` and `docs/roadmap.md` for scaling, security and future integrations.
