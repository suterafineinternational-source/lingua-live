# Lingua Live

Lingua Live is a clean-room realtime interpretation platform inspired by publicly documented professional interpretation workflows. A Host creates an event and streams source audio; Audience browsers receive translated captions and synthesized translated audio from a single server-owned OpenAI realtime translation session per room.

## Current feature set

- Host and Audience interfaces
- Event title, schedule, source/target language metadata
- Italian → English fully configured default, with language-pair architecture ready for additional supported pairs
- Purpose-built `gpt-realtime-translate` backend for continuous low-latency interpretation
- Optional prompted Realtime compatibility mode for custom glossary instructions
- Microphone or browser-tab/system audio capture where the browser supports `getDisplayMedia`
- Live source transcript plus translated transcript in the Host console
- Live translated captions and PCM audio for Audience listeners
- Optional 4-8 digit audience PIN with short-lived admission tokens
- Invite link and QR code
- Listener presence, reconnect/backoff, bounded audio backpressure, cleanup lifecycle
- Transcript export as timestamped CSV and post-event JSON summary
- Explicit opt-in local source recording in the Host browser
- Embed player, OBS/browser-source captions, SSE and WebVTT outputs
- Docker/Render deployment assets, health/readiness and Prometheus metrics
- Meeting-provider integration capability registry and universal browser-capture workflow
- Storage abstraction with in-memory development adapter
- Security headers, body limits, public API rate limiting and secret isolation
- Automated lifecycle/fan-out/auth/PIN/transcript/production tests and GitHub Actions CI

## Requirements

- Node.js 20+
- An OpenAI API key with Realtime Translation access
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

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_TRANSLATION_MODE` | `translate` | `translate` uses the purpose-built translation model; `prompted` enables glossary/custom terminology instructions |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-translate` | Dedicated Realtime Translation model |
| `OPENAI_PROMPTED_REALTIME_MODEL` | `gpt-realtime-2.1` | General Realtime model used only in prompted compatibility mode |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_BASE_URL` | Request origin | Public origin used for invite URLs and QR codes |
| `HOST_RECONNECT_GRACE_MS` | `30000` | Keep upstream translation alive during short host reconnects |
| `ROOM_RETENTION_MS` | `3600000` | Retain ended room metadata before pruning |

Never expose `OPENAI_API_KEY` to browser code, query strings, logs, or public environment variables. The standard API key is only used server-to-server.

## Translation engine modes

The default `translate` mode connects to OpenAI's dedicated Realtime Translation endpoint with `gpt-realtime-translate`. It continuously accepts 24 kHz PCM16 source audio, automatically detects the input language, and streams translated speech plus source/target transcripts. It is the preferred mode for webinars, broadcasts, lectures and other continuous interpretation.

The dedicated translation model does **not** currently support custom prompts, glossary injection, pronunciation guides, or fixed voice selection. Lingua Live does not pretend otherwise: glossary entries are stored but are not injected when this mode is active, and the Host receives an explicit engine-status message.

Set `OPENAI_TRANSLATION_MODE=prompted` when custom glossary instructions are required. Prompted mode uses a general Realtime model and translation-only instructions; it supports glossary injection but has different turn/latency behavior from the purpose-built continuous translation model.

See `docs/translation-engine.md` for details.

## Host flow

1. Open `/host`.
2. Enter event title, optional schedule, language pair, optional audience PIN, glossary, and choose microphone or tab/system audio.
3. Optionally enable local source recording after obtaining any required participant consent. Recording is off by default.
4. Create the event and share the invite link/QR code.
5. Start interpretation and grant the requested browser permission.
6. Monitor source transcript, translation, listener count and service/engine state.
7. Download transcript, event summary, and any explicitly enabled local source recording.
8. End the event to release the upstream session and listener sockets.

## Audience flow

1. Open `/audience/:code` from the Host invite.
2. If the event is protected, enter the audience PIN.
3. Enable translated audio once to satisfy browser autoplay policies.
4. Read live translated captions, control volume and reconnect automatically if the network drops.

## Browser audio notes

Microphone capture uses `getUserMedia`. Browser-tab/system audio uses the documented `getDisplayMedia` API and depends on browser/OS support. Some browsers expose screen sharing without an audio track; Lingua Live reports that explicitly instead of silently continuing.

## Transcripts

In dedicated translation mode, source text comes from Realtime Translation input transcript events and target text comes from Realtime Translation output transcript events. Lingua Live never fabricates source text. Export preserves blank source/translation cells when one side has not arrived yet.

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
- `GET /api/rooms/:code/summary`
- `GET /api/rooms/:code/qr`
- `GET /api/integrations`
- `GET /api/rooms/:code/captions.sse`
- `GET /api/rooms/:code/captions.vtt`
- `GET /health`
- `GET /ready`
- `GET /metrics`
- `GET /ws?...`

## Production architecture

The live room registry remains in memory for a simple single-process deployment. Event/transcript persistence is behind an async storage contract (`src/storage.js`) so a database adapter can replace the in-memory adapter without changing the room protocol. For horizontal scale, move room presence/leases to Redis or equivalent, publish caption/audio events through shared pub/sub, and move large-audience audio to an Opus/WebRTC or low-latency streaming tier.

See `docs/architecture.md`, `docs/deployment.md`, `docs/integrations.md`, `docs/translation-engine.md`, and `docs/roadmap.md` for scaling, security and future integrations.
