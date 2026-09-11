# Meeting-platform integrations

Lingua Live currently supports a universal, provider-independent workflow: the Host opens the meeting or webinar in a supported browser, selects **Browser tab / system audio**, then shares the tab/window audio with Lingua Live. This works without giving Lingua Live access to the meeting provider account.

## Capability endpoint

`GET /api/integrations` returns public capability metadata only. It never returns provider credentials or secrets.

Current capability states:

- Browser tab / system audio — available now through browser capture APIs where the browser/OS exposes an audio track.
- Zoom — integration adapter slot reserved; official provider credentials/setup required for a bot/app integration.
- Microsoft Teams — integration adapter slot reserved; official provider credentials/setup required.
- Google Meet — integration adapter slot reserved; official provider credentials/setup required.
- Webex — integration adapter slot reserved; official provider credentials/setup required.

## Adapter contract

`src/integrations.js` provides a registry. A provider adapter must implement:

```js
{
  async start(context) {},
  async stop(context) {}
}
```

Adapters must use the provider's official/public APIs and comply with provider permission, recording, disclosure, and meeting-participant requirements. They must not scrape private interfaces or imitate proprietary Interprefy internals.

## Why provider bots are not faked

A real meeting bot generally needs a registered provider application, credentials, scopes/permissions, tenant or account approval, and provider-specific media/session handling. Lingua Live reports those integrations as `requires-provider-setup` until the corresponding official credentials and configuration are supplied. The browser-capture workflow remains available in the meantime.
