# Meeting browser mode

Lingua Live can be used today with Zoom and Google Meet without provider OAuth credentials by capturing the meeting tab/window through the browser's `getDisplayMedia` API.

## Zoom / Google Meet workflow

1. Open the Zoom web client or Google Meet in Chrome.
2. Open Lingua Live Host in another tab.
3. Choose **Zoom / Google Meet (browser tab)** as the source.
4. Press **Start interpretation**.
5. When Chrome asks what to share, choose the active meeting tab and enable **Share tab audio**.
6. Lingua Live captures meeting audio for interpretation and sends a low-frame-rate visual preview of the shared meeting to the Audience room.

This browser mode does not require provider secrets and is the deployable integration path currently available in production.

## Native provider apps

A provider-native Zoom or Google Meet bot/app requires credentials, OAuth configuration, redirect URIs and provider/admin approval outside this repository. Lingua Live keeps the adapter architecture for those integrations, but they cannot be activated without those external credentials and approvals.
