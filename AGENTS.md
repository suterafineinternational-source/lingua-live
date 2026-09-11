# Codex instructions for Lingua Live

## Product goal
Build Lingua Live as a production-quality web application for simultaneous interpretation during live events. The core experience is: an Italian speaker talks continuously; listeners receive natural English audio and live English captions with the lowest practical latency.

## Product principles
1. Do not copy proprietary source code, branding, or assets from competitors. Reimplement comparable public functionality clean-room.
2. Protect API keys and secrets. Browser clients must never receive the standard server API key.
3. Prefer realtime streaming over batch processing.
4. Optimize for continuous speech, interruptions, reconnects, and long-running sessions.
5. Keep the UI simple enough for non-technical hosts and listeners.
6. Accessibility: keyboard navigation, readable captions, responsive UI, clear connection states.
7. Every important realtime failure must surface a human-readable status and support recovery.

## Technical direction
- Node.js 20+ and modern JavaScript/TypeScript.
- OpenAI Realtime for speech translation.
- WebRTC for low-latency media transport where suitable.
- WebSocket/SSE for room state, transcript deltas, presence, and control messages.
- Separate Host and Audience experiences.
- Introduce persistence only behind a clean repository/service abstraction.
- Keep deployment portable (local, Render/Fly/Railway/Cloud Run or similar).

## Target architecture
- `apps/web` or equivalent browser UI.
- `apps/server` or equivalent API/realtime backend.
- room service: create/join/end rooms, roles, presence, reconnect tokens.
- translation service: OpenAI session creation, language settings, glossary instructions, usage/error tracking.
- media service: host source audio ingress and translated audio fan-out.
- transcript service: original + translated segments with timestamps.
- export service: TXT/SRT/VTT and later PDF.

## Immediate next tasks after initial MVP
1. Validate the current OpenAI Realtime Translation request/response event names against current official docs and update code if needed.
2. Add automated smoke tests for `/api/health` and session validation.
3. Add a real Host/Audience split. A listener opening an invite URL must not be shown host controls.
4. Implement server-backed room creation/joining and presence.
5. Broadcast translated transcript deltas to listeners in the same room.
6. Design and implement translated audio fan-out for multiple listeners; document tradeoffs and scalability.
7. Add host-configurable glossary terms and feed them safely into the translation session.
8. Add reconnect/backoff and clear degraded/error states.
9. Add structured logging without logging secrets or raw credentials.
10. Add CI for install/test/lint.

## Definition of done for each PR
- No secrets committed.
- README updated if setup or behavior changes.
- Failure states handled in UI.
- Tests added for new backend logic where practical.
- Manual test steps included in PR body.
- Avoid breaking the minimal local `npm install && npm run dev` path until monorepo migration is complete.
