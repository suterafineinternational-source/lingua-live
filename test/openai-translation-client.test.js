import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTranslationClientSecretRequest,
  createTranslationClientSecret,
} from "../src/openai-translation-client.js";

test("builds a dedicated translation client-secret request for Italian to English", () => {
  const request = buildTranslationClientSecretRequest({
    apiKey: "test-key",
    sourceLanguage: "it-IT",
    targetLanguage: "en-US",
    sourceType: "microphone",
  });

  assert.equal(request.url, "https://api.openai.com/v1/realtime/translations/client_secrets");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(request.init.body);
  assert.equal(body.session.model, "gpt-realtime-translate");
  assert.deepEqual(body.session.audio.input.transcription, {
    model: "gpt-realtime-whisper",
    language: "it",
  });
  assert.deepEqual(body.session.audio.input.noise_reduction, { type: "near_field" });
  assert.equal(body.session.audio.output.language, "en");
});

test("browser-tab translation disables microphone noise reduction", () => {
  const request = buildTranslationClientSecretRequest({
    apiKey: "test-key",
    sourceLanguage: "it",
    targetLanguage: "en",
    sourceType: "display",
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.session.audio.input.noise_reduction, null);
});

test("extracts only the short-lived client credential from OpenAI", async () => {
  let seenAuthorization;
  const result = await createTranslationClientSecret({
    apiKey: "server-only-key",
    sourceLanguage: "it",
    targetLanguage: "en",
    fetchImpl: async (_url, init) => {
      seenAuthorization = init.headers.Authorization;
      return new Response(JSON.stringify({
        value: "ephemeral-client-secret",
        expires_at: 123456789,
        session: { id: "not-forwarded" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(seenAuthorization, "Bearer server-only-key");
  assert.deepEqual(result, {
    clientSecret: "ephemeral-client-secret",
    expiresAt: 123456789,
    model: "gpt-realtime-translate",
    sourceLanguage: "it",
    targetLanguage: "en",
  });
  assert.equal(JSON.stringify(result).includes("server-only-key"), false);
});

test("requires the server OpenAI credential", () => {
  assert.throws(
    () => buildTranslationClientSecretRequest({ targetLanguage: "en" }),
    (error) => error?.code === "OPENAI_API_KEY_MISSING",
  );
});
