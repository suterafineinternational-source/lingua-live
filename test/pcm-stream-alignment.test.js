import assert from "node:assert/strict";
import { test } from "node:test";
import { reassemblePcm16Base64 } from "../src/elevenlabs-tts.js";
import { decodePcm16Le, reassemblePcm16Le } from "../public/pcm-playback.js";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

test("server preserves PCM16 sample alignment across odd ElevenLabs chunks", () => {
  const chunks = [
    [1, 2, 3],
    [4],
    [5, 6, 7, 8, 9],
    [10],
  ];
  let carry = Buffer.alloc(0);
  const emitted = [];
  for (const chunk of chunks) {
    const result = reassemblePcm16Base64(b64(chunk), carry);
    carry = result.carry;
    if (result.audio) {
      const bytes = Buffer.from(result.audio, "base64");
      assert.equal(bytes.length % 2, 0);
      emitted.push(bytes);
    }
  }
  assert.equal(carry.length, 0);
  assert.deepEqual([...Buffer.concat(emitted)], [1,2,3,4,5,6,7,8,9,10]);
});

test("browser player carries a split PCM16 sample into the next WebSocket event", () => {
  let carryByte = null;
  const first = reassemblePcm16Le(b64([0x01, 0x02, 0x03]), carryByte);
  carryByte = first.carryByte;
  assert.deepEqual([...first.bytes], [0x01, 0x02]);
  assert.equal(carryByte, 0x03);

  const second = reassemblePcm16Le(b64([0x04, 0x05, 0x06]), carryByte);
  assert.deepEqual([...second.bytes], [0x03, 0x04, 0x05, 0x06]);
  assert.equal(second.carryByte, null);
});

test("direct PCM16 decode refuses to silently drop an incomplete sample", () => {
  assert.throws(
    () => decodePcm16Le(b64([0x01]), {}),
    /middle of a 16-bit sample/,
  );
});
