/**
 * audio.js — Dual HTML5 WAV Data URI + Web Audio API synthesizer.
 * Pre-synthesizes lightweight WAV Data URIs so sound plays reliably on iOS Safari and mobile browsers.
 */

function createWavDataUri(freqs = [523.25, 659.25, 783.99], durationSec = 0.4) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new Uint8Array(44 + numSamples * 2);
  const view = new DataView(buffer.buffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  const toneDuration = durationSec / freqs.length;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const toneIdx = Math.min(Math.floor(t / toneDuration), freqs.length - 1);
    const freq = freqs[toneIdx];
    const envelope = Math.max(0, 1 - (t / durationSec));
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.35 * 32767;
    view.setInt16(44 + i * 2, sample, true);
  }

  let binary = '';
  const len = buffer.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunkSize));
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

const CHIME_WAVS = {
  complete: createWavDataUri([523.25, 659.25, 783.99], 0.45),
  discovered: createWavDataUri([440, 880], 0.3),
  connected: createWavDataUri([329.63, 493.88], 0.35),
};

export function playChime(type = 'complete') {
  const wavUri = CHIME_WAVS[type] || CHIME_WAVS.complete;
  try {
    const audio = new Audio(wavUri);
    audio.volume = 0.5;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        playWebAudioFallback(type);
      });
    }
  } catch {
    playWebAudioFallback(type);
  }
}

function playWebAudioFallback(type) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch { /* muted */ }
}
