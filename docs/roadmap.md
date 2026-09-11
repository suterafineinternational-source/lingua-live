# Lingua Live roadmap

## Milestone 3 — Production-ready event experience
- Host dashboard and event creation flow.
- Scheduled and ad-hoc sessions.
- Configurable source/target language pairs.
- Browser microphone and browser-tab/system-audio capture where supported.
- Original transcript + translated transcript + translated audio.
- Per-listener controls: play/pause, volume, captions, transcript view.
- Session glossary profiles.
- Invite link, room code, QR, optional PIN.
- Transcript export and session summary metadata.
- Persistent event/session storage abstraction with a production database adapter.
- Rate limiting, security headers, request validation, observability hooks.
- End-to-end/browser tests for the main host/audience flow.

## Milestone 4 — Scale and reliability
- Redis/shared presence and pub/sub.
- Distributed room ownership/leases.
- Better audio transport (Opus/WebRTC or low-latency segmented media).
- Horizontal scaling and load tests.
- Production deployment templates, CI/CD, health checks and metrics.

## Milestone 5 — Integrations
- Supported Zoom integration.
- Supported Microsoft Teams integration.
- Supported Google Meet integration.
- Supported Webex integration.
- OBS/streaming caption output and embeddable audience player.

## Milestone 6 — Platform features
- Accounts, organizations, roles and event history.
- Recording with explicit host consent.
- Post-event transcript and downloadable assets.
- Billing/usage metering hooks.
- Admin controls, audit log and retention policies.

All implementation must remain clean-room and use public/official APIs.
