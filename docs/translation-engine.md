# Translation engine modes

Lingua Live supports two OpenAI realtime translation backends.

## Dedicated translation mode — default

```env
OPENAI_TRANSLATION_MODE=translate
OPENAI_REALTIME_MODEL=gpt-realtime-translate
```

This mode uses the purpose-built Realtime Translation WebSocket endpoint:

`/v1/realtime/translations?model=gpt-realtime-translate`

It streams 24 kHz PCM16 source audio continuously with `session.input_audio_buffer.append` and consumes `session.input_transcript.*`, `session.output_transcript.*`, and `session.output_audio.*` events. The source language is detected automatically; Lingua Live configures the listener's target output language and `gpt-realtime-whisper` input transcription.

This is the preferred mode for broadcasts, webinars, lectures, and other continuous interpretation because it is designed specifically for streaming speech-to-speech translation rather than turn-based voice-agent behavior.

### Important limitation

The dedicated translation model does not currently support custom prompts, glossary injection, pronunciation guides, or fixed voice selection. Lingua Live therefore never sends glossary entries as unsupported hidden instructions in this mode. A Host status message makes this limitation explicit when a glossary exists.

## Prompted compatibility mode

```env
OPENAI_TRANSLATION_MODE=prompted
OPENAI_PROMPTED_REALTIME_MODEL=gpt-realtime-2.1
```

Prompted mode keeps the general Realtime compatibility backend. It uses model instructions to request translation-only behavior and can inject glossary terms. It is useful when terminology control is more important than the dedicated translation model's continuous interpretation behavior.

Prompted mode is not presented as equivalent to the purpose-built translation model: it is turn/VAD based and can have different latency and behavior.

## Security

Both modes keep the standard OpenAI API key on the Node server. Host and Audience browsers never receive the standard API key.

## Engine capability metadata

`createOpenAIRealtimeFactory(...).capabilities()` exposes the selected engine mode/model and whether glossary prompting, automatic source-language detection, continuous translation, and voice selection are supported. Live `service.status` WebSocket events carry the same engine capability fields so the Host UI receives the active behavior without exposing secrets.
