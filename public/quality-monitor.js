export class RealtimeQualityMonitor {
  constructor({ now = () => performance.now(), windowMs = 30000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.reset();
  }

  reset() {
    this.sourceEvents = [];
    this.sourceStarted = new Map();
    this.sourceCompleted = new Map();
    this.translationStarted = new Set();
    this.translationLags = [];
    this.translationCompleted = 0;
    this.audioChunks = 0;
    this.sentInputChunks = 0;
    this.capturedInputChunks = 0;
    this.nonSilentChunks = 0;
    this.sessionStartedAt = this.now();
  }

  recordInputSent() {
    this.sentInputChunks += 1;
  }

  recordCaptureTotals(captured = 0, nonSilent = 0) {
    this.capturedInputChunks = Math.max(this.capturedInputChunks, Number(captured) || 0);
    this.nonSilentChunks = Math.max(this.nonSilentChunks, Number(nonSilent) || 0);
  }

  recordSourceDelta(itemId = "current") {
    const at = this.now();
    if (!this.sourceStarted.has(itemId)) this.sourceStarted.set(itemId, at);
  }

  recordSourceDone(itemId = "current", transcript = "") {
    const at = this.now();
    if (!this.sourceStarted.has(itemId)) this.sourceStarted.set(itemId, at);
    this.sourceCompleted.set(itemId, at);
    const words = String(transcript).trim().split(/\s+/).filter(Boolean).length;
    if (words) this.sourceEvents.push({ at, words });
    this.trim(at);
  }

  recordTranslationDelta(itemId = "current") {
    if (this.translationStarted.has(itemId)) return;
    this.translationStarted.add(itemId);
    const at = this.now();
    const sourceAt = this.sourceStarted.get(itemId) ?? this.sourceCompleted.get(itemId) ?? this.latestSourceTimestamp();
    if (sourceAt != null && at >= sourceAt) {
      this.translationLags.push({ at, lagMs: at - sourceAt });
      if (this.translationLags.length > 100) this.translationLags.shift();
    }
  }

  recordTranslationDone() {
    this.translationCompleted += 1;
  }

  recordAudioChunk() {
    this.audioChunks += 1;
  }

  latestSourceTimestamp() {
    let latest = null;
    for (const value of this.sourceStarted.values()) if (latest == null || value > latest) latest = value;
    return latest;
  }

  trim(now = this.now()) {
    const cutoff = now - this.windowMs;
    this.sourceEvents = this.sourceEvents.filter((event) => event.at >= cutoff);
    this.translationLags = this.translationLags.filter((event) => event.at >= cutoff);
  }

  snapshot({ playbackBufferSeconds = 0 } = {}) {
    const now = this.now();
    this.trim(now);
    const words = this.sourceEvents.reduce((sum, event) => sum + event.words, 0);
    const oldest = this.sourceEvents[0]?.at;
    const spanMinutes = oldest == null ? 0 : Math.max((now - oldest) / 60000, 1 / 60);
    const wpm = spanMinutes ? Math.round(words / spanMinutes) : 0;
    const lags = this.translationLags.map((event) => event.lagMs);
    const latestLagMs = lags.at(-1) ?? null;
    const averageLagMs = lags.length ? Math.round(lags.reduce((sum, value) => sum + value, 0) / lags.length) : null;
    const maxLagMs = lags.length ? Math.max(...lags) : null;
    const inputDrops = Math.max(0, this.capturedInputChunks - this.sentInputChunks);
    const dropRate = this.capturedInputChunks ? inputDrops / this.capturedInputChunks : 0;
    const pendingTranslations = Math.max(0, this.sourceCompleted.size - this.translationCompleted);

    let health = "warming-up";
    if (this.sentInputChunks > 20 && (latestLagMs != null || this.audioChunks > 0)) {
      const severe = dropRate > 0.02 || (averageLagMs ?? 0) > 5000 || playbackBufferSeconds > 5 || pendingTranslations > 3;
      const warning = dropRate > 0 || (averageLagMs ?? 0) > 2500 || playbackBufferSeconds > 2.5 || pendingTranslations > 1;
      health = severe ? "critical" : warning ? "warning" : "healthy";
    }

    const pace = wpm >= 210 ? "very-fast" : wpm >= 180 ? "fast" : wpm >= 150 ? "brisk" : wpm ? "normal" : "waiting";
    return {
      wpm,
      pace,
      latestLagMs,
      averageLagMs,
      maxLagMs,
      playbackBufferSeconds: Math.max(0, Number(playbackBufferSeconds) || 0),
      inputChunks: this.sentInputChunks,
      capturedInputChunks: this.capturedInputChunks,
      inputDrops,
      dropRate,
      nonSilentChunks: this.nonSilentChunks,
      audioChunks: this.audioChunks,
      pendingTranslations,
      health,
      elapsedSeconds: Math.round((now - this.sessionStartedAt) / 1000),
    };
  }
}

export function qualityLabel(snapshot) {
  if (snapshot.health === "healthy") return "HEALTHY";
  if (snapshot.health === "warning") return "WATCH";
  if (snapshot.health === "critical") return "BACKLOG";
  return "WARMING UP";
}
