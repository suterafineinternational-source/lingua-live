import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function loadProcessor({ outputSampleRate = 48000 } = {}) {
  const source = readFileSync(new URL("../public/pcm-output-worklet.js", import.meta.url), "utf8");
  let ProcessorClass = null;
  class FakeAudioWorkletProcessor {
    constructor() {
      this.messages = [];
      this.port = {
        onmessage: null,
        postMessage: (message) => this.messages.push(message),
      };
    }
  }
  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor(name, Processor) {
      assert.equal(name, "pcm-stream-output");
      ProcessorClass = Processor;
    },
    sampleRate: outputSampleRate,
    ArrayBuffer,
    Int16Array,
    Math,
    Number,
  });
  vm.runInContext(source, context, { filename: "pcm-output-worklet.js" });
  assert.ok(ProcessorClass, "worklet processor should register");
  return new ProcessorClass();
}

function push(processor, samples, sampleRate = 24000, maxBufferedSeconds = 3) {
  const copy = Int16Array.from(samples);
  processor.port.onmessage({
    data: {
      type: "push",
      samples: copy.buffer,
      sampleRate,
      maxBufferedSeconds,
    },
  });
}

test("hour-long logical input stays bounded to the realtime jitter ceiling", () => {
  const processor = loadProcessor();
  const oneLogicalSecondAt100Hz = new Int16Array(100);
  for (let second = 0; second < 3600; second += 1) {
    push(processor, oneLogicalSecondAt100Hz, 100, 3);
    assert.ok(processor.bufferedSamples <= 300, `buffer escaped ceiling at second ${second}`);
  }
  assert.equal(processor.bufferedSamples, 300);
  assert.ok(processor.droppedSamples > 0);
  assert.ok(processor.queue.length <= 3, "old chunks should be released instead of retained for an hour");
});

test("worklet underflow renders silence instead of repeating a stale sample", () => {
  const processor = loadProcessor();
  const channel = new Float32Array(128);
  channel.fill(0.75);
  processor.process([], [[channel]]);
  assert.deepEqual([...channel], new Array(128).fill(0));
});

test("worklet resamples 24 kHz PCM continuously into a 48 kHz AudioContext", () => {
  const processor = loadProcessor({ outputSampleRate: 48000 });
  push(processor, [0, 32767, 0, -32768, 0, 32767], 24000, 3);
  const channel = new Float32Array(8);
  processor.process([], [[channel]]);
  assert.equal(channel[0], 0);
  assert.ok(channel[1] > 0.45 && channel[1] < 0.55, "half-rate interpolation should be near 0.5");
  assert.ok(channel.some((value) => value < -0.4), "negative PCM samples should survive resampling");
});

test("browser player prefers one AudioWorkletNode and retains a bounded fallback", () => {
  const source = readFileSync(new URL("../public/pcm-playback.js", import.meta.url), "utf8");
  assert.match(source, /new AudioWorkletNode\(this\.context, "pcm-stream-output"/);
  assert.match(source, /maxBufferedSeconds = 3/);
  assert.match(source, /recoverFallbackQueue/);
  assert.match(source, /source\.onended/);
  assert.match(source, /activeSources\.delete\(source\)/);
});
