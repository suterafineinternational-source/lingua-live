const TARGET_SAMPLE_RATE = 24000;
const TARGET_CHUNK_MS = 200;
const TARGET_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * TARGET_CHUNK_MS / 1000;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.phase = 0;
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    while (this.phase < input.length) {
      const index = Math.floor(this.phase);
      const next = Math.min(index + 1, input.length - 1);
      const fraction = this.phase - index;
      const sample = input[index] + (input[next] - input[index]) * fraction;
      this.pending.push(Math.max(-1, Math.min(1, sample)));
      this.phase += this.ratio;
    }
    this.phase -= input.length;

    while (this.pending.length >= TARGET_CHUNK_SAMPLES) {
      const pcm = new Int16Array(TARGET_CHUNK_SAMPLES);
      for (let index = 0; index < pcm.length; index += 1) {
        const sample = this.pending[index];
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.pending.splice(0, pcm.length);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
