export function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext || null;
}

export function decodePcm16Le(base64, context, sampleRate = 24000) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const buffer = context.createBuffer(1, sampleCount, sampleRate);
  const channel = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

function isAppleMobileBrowser() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function primeOutput(context) {
  // A tiny non-zero signal is more reliable than a mathematically silent buffer
  // for unlocking the actual media route on iOS/Safari and some mobile Chromium builds.
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.frequency.value = 440;
  gain.gain.setValueAtTime(0.00001, now);
  gain.gain.exponentialRampToValueAtTime(0.000001, now + 0.03);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.035);
}

export async function unlockAudioContext(context) {
  await context.resume();
  if (context.state !== "running") throw new Error("Browser audio output is still suspended. Tap/click the audio button again.");
  primeOutput(context);
}

export class PcmQueuePlayer {
  constructor({ volume = 1, lookAhead = 0.035, maxPending = 24 } = {}) {
    this.context = null;
    this.gain = null;
    this.mediaDestination = null;
    this.audioElement = null;
    this.outputConnected = false;
    this.sinkMode = "uninitialized";
    this.nextStart = 0;
    this.enabled = false;
    this.pending = [];
    this.volume = volume;
    this.lookAhead = lookAhead;
    this.maxPending = maxPending;
    this.receivedChunks = 0;
    this.scheduledChunks = 0;
    this.lastScheduledAt = 0;
    this.resumePromise = null;
    this.stateListenerAttached = false;
    this.gestureResume = () => { if (this.enabled) void this.resumeAndDrain(); };
  }

  attachGestureResume() {
    window.addEventListener("pointerdown", this.gestureResume, { passive: true });
    window.addEventListener("touchend", this.gestureResume, { passive: true });
    window.addEventListener("keydown", this.gestureResume, { passive: true });
    window.addEventListener("pageshow", this.gestureResume, { passive: true });
  }

  detachGestureResume() {
    window.removeEventListener("pointerdown", this.gestureResume);
    window.removeEventListener("touchend", this.gestureResume);
    window.removeEventListener("keydown", this.gestureResume);
    window.removeEventListener("pageshow", this.gestureResume);
  }

  async ensureContext() {
    const Ctor = audioContextConstructor();
    if (!Ctor) throw new Error("Web Audio is not supported by this browser.");
    if (!this.context || this.context.state === "closed") {
      this.context = new Ctor({ latencyHint: "interactive" });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.mediaDestination = null;
      this.audioElement = null;
      this.outputConnected = false;
      this.sinkMode = "uninitialized";
      this.nextStart = 0;
      this.stateListenerAttached = false;
    }
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.outputConnected = false;
    }
    if (!this.stateListenerAttached) {
      this.context.addEventListener?.("statechange", () => {
        if (this.enabled && this.context?.state === "running") this.drainPending();
      });
      this.stateListenerAttached = true;
    }
    return this.context;
  }

  async ensureOutputSink() {
    if (this.outputConnected) {
      if (this.audioElement && this.audioElement.paused) {
        try { await this.audioElement.play(); } catch {}
      }
      return;
    }

    if (isAppleMobileBrowser() && this.context?.createMediaStreamDestination) {
      try {
        this.mediaDestination = this.context.createMediaStreamDestination();
        this.gain.connect(this.mediaDestination);
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.preload = "auto";
        audio.volume = 1;
        audio.srcObject = this.mediaDestination.stream;
        audio.style.display = "none";
        document.body.append(audio);
        await audio.play();
        this.audioElement = audio;
        this.outputConnected = true;
        this.sinkMode = "media-element";
        return;
      } catch {
        try { this.gain.disconnect(); } catch {}
        try { this.audioElement?.remove(); } catch {}
        this.mediaDestination = null;
        this.audioElement = null;
      }
    }

    this.gain.connect(this.context.destination);
    this.outputConnected = true;
    this.sinkMode = "webaudio";
  }

  async resumeAndDrain() {
    if (!this.enabled && !this.context) return this.snapshot();
    await this.ensureContext();
    await this.ensureOutputSink();
    if (this.context.state === "running") {
      if (this.audioElement?.paused) {
        try { await this.audioElement.play(); } catch {}
      }
      this.drainPending();
      return this.snapshot();
    }
    if (this.resumePromise) return this.resumePromise;
    this.resumePromise = (async () => {
      try {
        await this.context.resume();
        await this.ensureOutputSink();
        if (this.context.state === "running") {
          primeOutput(this.context);
          this.nextStart = Math.max(this.context.currentTime + this.lookAhead, this.nextStart);
          this.drainPending();
        }
      } finally {
        this.resumePromise = null;
      }
      return this.snapshot();
    })();
    return this.resumePromise;
  }

  async enable() {
    await this.ensureContext();
    this.enabled = true;
    this.attachGestureResume();
    await unlockAudioContext(this.context);
    await this.ensureOutputSink();
    this.nextStart = Math.max(this.context.currentTime + this.lookAhead, this.nextStart);
    this.drainPending();
    return this.snapshot();
  }

  disable() {
    this.enabled = false;
    this.pending = [];
    this.nextStart = this.context?.currentTime || 0;
    this.detachGestureResume();
    return this.snapshot();
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.gain) this.gain.gain.value = this.volume;
    return this.snapshot();
  }

  enqueue(audio, sampleRate = 24000) {
    if (!audio) return this.snapshot();
    this.receivedChunks += 1;
    if (!this.enabled || !this.context || this.context.state !== "running" || !this.gain || !this.outputConnected) {
      this.pending.push({ audio, sampleRate });
      if (this.pending.length > this.maxPending) this.pending.shift();
      if (this.enabled) void this.resumeAndDrain().catch(() => {});
      return this.snapshot();
    }
    this.play(audio, sampleRate);
    return this.snapshot();
  }

  drainPending() {
    if (!this.enabled || !this.context || this.context.state !== "running" || !this.gain || !this.outputConnected || !this.pending.length) return this.snapshot();
    const backlog = this.pending.splice(Math.max(0, this.pending.length - this.maxPending));
    this.pending = [];
    for (const item of backlog) this.play(item.audio, item.sampleRate);
    return this.snapshot();
  }

  play(audio, sampleRate = 24000) {
    if (!this.context || this.context.state !== "running" || !this.gain || !this.outputConnected) {
      this.pending.push({ audio, sampleRate });
      if (this.pending.length > this.maxPending) this.pending.shift();
      return this.snapshot();
    }
    const buffer = decodePcm16Le(audio, this.context, sampleRate);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const start = Math.max(this.context.currentTime + this.lookAhead, this.nextStart);
    source.start(start);
    this.nextStart = start + buffer.duration;
    this.scheduledChunks += 1;
    this.lastScheduledAt = Date.now();
    return this.snapshot();
  }

  reset() {
    this.pending = [];
    this.nextStart = this.context?.currentTime || 0;
    this.receivedChunks = 0;
    this.scheduledChunks = 0;
    this.lastScheduledAt = 0;
    return this.snapshot();
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.context?.state || "not-created",
      sinkMode: this.sinkMode,
      volume: this.volume,
      receivedChunks: this.receivedChunks,
      scheduledChunks: this.scheduledChunks,
      pendingChunks: this.pending.length,
      queuedSeconds: this.context ? Math.max(0, this.nextStart - this.context.currentTime) : 0,
      lastScheduledAt: this.lastScheduledAt,
    };
  }
}
