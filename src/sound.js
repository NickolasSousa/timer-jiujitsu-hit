// Short beeps and the end-of-activity alarm via Web Audio (no audio files needed).

let context = null;

/** Must be called from a user gesture (e.g. the Start click) so browsers allow playback. */
export function unlockAudio() {
  try {
    context ??= new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') context.resume();
  } catch (error) {
    console.warn('Audio unavailable', error);
  }
}

function tone(output, frequency, at, { duration = 0.16, volume = 0.18, type = 'sine' } = {}) {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  // Short fade in/out avoids clicks.
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(output);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function playBeeps(frequencies, { gap = 0.08, ...options } = {}) {
  if (!context) return;
  let at = context.currentTime + 0.02;
  for (const frequency of frequencies) {
    tone(context.destination, frequency, at, options);
    at += (options.duration ?? 0.16) + gap;
  }
}

/**
 * "Time's up" alarm: bursts of 4 fast beeps every second, alternating pitch, for `seconds`.
 * Returns a stop function (used when the workout is paused/stopped mid-alarm).
 */
function alarm(seconds) {
  if (!context) return () => {};
  const output = context.createGain(); // one node to cut the whole alarm at once
  output.connect(context.destination);
  const start = context.currentTime + 0.02;
  const end = start + seconds;
  for (let group = 0; start + group < end; group++) {
    const frequency = group % 2 ? 784 : 988;
    for (let i = 0; i < 4; i++) {
      const at = start + group + i * 0.15;
      if (at + 0.1 > end) break;
      tone(output, frequency, at, { duration: 0.1, volume: 0.12, type: 'square' });
    }
  }
  return () => output.disconnect();
}

export const sounds = {
  work: () => playBeeps([880, 880]),
  tick: () => playBeeps([660], { duration: 0.12 }),
  finish: () => playBeeps([660, 880, 1046], { duration: 0.22 }),
  alarm,
};
