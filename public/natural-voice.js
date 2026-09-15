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

export function createNaturalVoiceChain(context, destination, { volume = 1 } = {}) {
  const input = context.createGain();
  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 55;
  highpass.Q.value = 0.6;

  const warmth = context.createBiquadFilter();
  warmth.type = "lowshelf";
  warmth.frequency.value = 180;
  warmth.gain.value = 1.4;

  const presence = context.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2600;
  presence.Q.value = 0.75;
  presence.gain.value = 0.8;

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -22;
  compressor.knee.value = 18;
  compressor.ratio.value = 2;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.18;

  const output = context.createGain();
  output.gain.value = volume;

  input.connect(highpass).connect(warmth).connect(presence).connect(compressor).connect(output).connect(destination);
  return { input, output, highpass, warmth, presence, compressor };
}

export function scheduleNaturalPcm({ context, input, base64, nextStart = 0, lookAhead = 0.055, sampleRate = 24000 }) {
  const buffer = decodePcm16Le(base64, context, sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(input);
  const start = Math.max(context.currentTime + lookAhead, nextStart);
  source.start(start);
  return { source, duration: buffer.duration, start, nextStart: start + buffer.duration };
}

export const NATURAL_VOICE_LABEL = "Natural Voice · dynamic prosody + smooth playback";
