class PcmStreamOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.bufferedSamples = 0;
    this.inputSampleRate = 24000;
    this.maxBufferedSeconds = 3;
    this.phase = 0;
    this.sample0 = 0;
    this.sample1 = 0;
    this.primeSample = null;
    this.ready = false;
    this.inUnderflow = true;
    this.underflowEvents = 0;
    this.droppedSamples = 0;
    this.processCount = 0;

    this.port.onmessage = ({ data }) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "reset") {
        this.reset();
        return;
      }
      if (data.type === "push" && data.samples instanceof ArrayBuffer) {
        this.push(data.samples, data.sampleRate, data.maxBufferedSeconds);
      }
    };
  }

  reset() {
    this.queue = [];
    this.bufferedSamples = 0;
    this.phase = 0;
    this.sample0 = 0;
    this.sample1 = 0;
    this.primeSample = null;
    this.ready = false;
    this.inUnderflow = true;
    this.postStats(true);
  }

  push(buffer, sampleRateValue, maxBufferedSecondsValue) {
    const nextRate = Number(sampleRateValue) || 24000;
    if (nextRate !== this.inputSampleRate && (this.bufferedSamples || this.ready || this.primeSample !== null)) {
      this.reset();
    }
    this.inputSampleRate = nextRate;
    const nextMax = Number(maxBufferedSecondsValue);
    if (Number.isFinite(nextMax) && nextMax > 0.25) this.maxBufferedSeconds = nextMax;

    const samples = new Int16Array(buffer);
    if (!samples.length) return;
    this.queue.push({ samples, index: 0 });
    this.bufferedSamples += samples.length;
    this.trimBacklog();
  }

  trimBacklog() {
    const maxSamples = Math.max(2, Math.round(this.inputSampleRate * this.maxBufferedSeconds));
    let excess = this.bufferedSamples - maxSamples;
    if (excess <= 0) return;

    this.ready = false;
    this.primeSample = null;
    this.phase = 0;

    while (excess > 0 && this.queue.length) {
      const head = this.queue[0];
      const available = head.samples.length - head.index;
      const take = Math.min(excess, available);
      head.index += take;
      this.bufferedSamples -= take;
      this.droppedSamples += take;
      excess -= take;
      if (head.index >= head.samples.length) this.queue.shift();
    }
  }

  pullSample() {
    while (this.queue.length) {
      const head = this.queue[0];
      if (head.index < head.samples.length) {
        const value = head.samples[head.index] / 32768;
        head.index += 1;
        this.bufferedSamples = Math.max(0, this.bufferedSamples - 1);
        if (head.index >= head.samples.length) this.queue.shift();
        return value;
      }
      this.queue.shift();
    }
    return null;
  }

  prime() {
    if (this.primeSample === null) {
      const first = this.pullSample();
      if (first === null) return false;
      this.primeSample = first;
    }
    const second = this.pullSample();
    if (second === null) return false;
    this.sample0 = this.primeSample;
    this.sample1 = second;
    this.primeSample = null;
    this.phase = 0;
    this.ready = true;
    return true;
  }

  nextOutputSample() {
    if (!this.ready && !this.prime()) {
      if (!this.inUnderflow) this.underflowEvents += 1;
      this.inUnderflow = true;
      return 0;
    }

    this.inUnderflow = false;
    const value = this.sample0 + (this.sample1 - this.sample0) * this.phase;
    this.phase += this.inputSampleRate / sampleRate;

    while (this.phase >= 1) {
      const next = this.pullSample();
      if (next === null) {
        this.ready = false;
        this.primeSample = null;
        this.phase = 0;
        break;
      }
      this.sample0 = this.sample1;
      this.sample1 = next;
      this.phase -= 1;
    }

    return Math.max(-1, Math.min(1, value));
  }

  postStats(force = false) {
    if (!force && this.processCount % 100 !== 0) return;
    this.port.postMessage({
      type: "stats",
      bufferedSamples: this.bufferedSamples + (this.primeSample === null ? 0 : 1),
      inputSampleRate: this.inputSampleRate,
      queuedSeconds: this.inputSampleRate ? this.bufferedSamples / this.inputSampleRate : 0,
      droppedSamples: this.droppedSamples,
      underflowEvents: this.underflowEvents,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length || 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const value = this.nextOutputSample();
      for (let channel = 0; channel < output.length; channel += 1) output[channel][frame] = value;
    }
    this.processCount += 1;
    this.postStats();
    return true;
  }
}

registerProcessor("pcm-stream-output", PcmStreamOutputProcessor);
