# Milestone 3 acceptance checklist

- [x] Event metadata and quick-start host flow
- [x] Configurable language pair architecture; IT → EN default
- [x] Microphone capture
- [x] Browser tab/system audio capture with unsupported/no-audio errors
- [x] Host source + translated transcript panes
- [x] Audience translated captions/audio/volume/reconnect UI
- [x] Optional audience PIN admission tokens
- [x] Transcript/event storage abstraction
- [x] Timestamped CSV transcript export
- [x] Live glossary updates
- [x] Security headers, rate limiting, request-size limits
- [x] Typed error paths and secret isolation
- [x] Added automated PIN/transcript/event tests
- [x] GitHub Actions CI for tests/audit/syntax
- [x] README and production architecture documentation

Known limitation: the repository does not yet include a full Playwright/Selenium browser automation stack. Critical browser flows are covered by deterministic HTTP/WebSocket tests plus manual multi-browser verification; adding a browser runner is tracked for the next hardening milestone.
