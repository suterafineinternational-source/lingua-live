# Codex operating instructions for Lingua Live

## Mission
Build Lingua Live into a production-grade, clean-room simultaneous interpretation platform inspired by publicly documented capabilities of products such as Interprefy. Do not copy proprietary source code, non-public implementation details, copyrighted UI assets, trademarks, or branding.

## Product priority
The core experience is live Italian speech translated into natural English with minimal latency, synchronized captions, and translated audio for multiple remote listeners. Architecture must remain extensible to additional source/target languages and meeting integrations.

## Working rules
1. Read this file and the active GitHub issue before coding.
2. Work on a `codex/*` branch and open a pull request against `main` when complete.
3. Do not stop at planning: implement code, tests, docs, and fixes.
4. Preserve secrets server-side. Never commit API keys, tokens, credentials, or generated `.env` files.
5. Prefer official APIs and documented event shapes.
6. Add or update automated tests for every behavior or bug fix.
7. Run `npm test`, `npm audit --audit-level=high`, and syntax/static checks before opening a PR.
8. Document manual verification for realtime/browser features that cannot be fully exercised in deterministic tests.
9. Keep host authorization separate from audience access.
10. Avoid regressions in reconnect, cleanup, fan-out, backpressure, and transcript replay.

## Definition of done for a milestone
- Acceptance criteria in the issue are implemented.
- Tests pass.
- No high-severity dependency vulnerabilities are reported.
- Browser console has no avoidable errors in the documented smoke test.
- Failure states have typed user-visible errors.
- README/docs reflect the actual system.
- PR explains design tradeoffs and any known limitations.

## Product roadmap themes
- Production-grade Host and Audience UX.
- Multi-language source/target selection and native-sounding output.
- Browser microphone, tab/system audio, uploaded/virtual audio source support where browser/security APIs permit.
- Live captions, original transcript, translated transcript, downloadable session transcript.
- Event/session dashboard, scheduling, invite links/QR, room access control.
- Custom glossaries and terminology profiles.
- Voice/output controls and per-listener audio controls.
- Recording and post-event assets with explicit host consent.
- Zoom/Google Meet/Microsoft Teams/Webex integrations using supported APIs/bots, never credential scraping.
- OBS/streaming caption output and embeddable audience player.
- Redis/shared state + scalable pub/sub/media transport for production scale.
- Authentication, persistence, audit logging, rate limits, abuse protection, observability, health metrics, and deployment automation.
- Accessibility and responsive mobile audience UI.

## Clean-room boundary
It is acceptable to reproduce publicly observable product categories and workflows. It is not acceptable to extract, decompile, scrape, or copy Interprefy proprietary source code, hidden APIs, non-public assets, or trade-secret implementation details.
