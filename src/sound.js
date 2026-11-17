// Workout sounds via Web Audio (no audio files needed).
// Sounds are scheduled ahead on the AudioContext clock, which keeps running in background
// tabs, instead of being triggered by UI renders (which browsers throttle in the background).

let context = null;
let onRunning = null;

/** Must be called from a user gesture (e.g. the Start click) so browsers allow playback. */
export function unlockAudio() {
  try {
    if (!context) {
      context = new (window.AudioContext || window.webkitAudioContext)();
      // A suspended context freezes its clock; whatever was scheduled must be redone on resume.
      context.addEventListener('statechange', () => context.state === 'running' && onRunning?.());
    }
    resumeAudio();
  } catch (error) {
    console.warn('Audio unavailable', error);
  }
}

/**
 * Best effort: some browsers (iOS) only allow resuming from a user gesture.
 * Resolves to true when audio is running afterwards (or was never unlocked: nothing to resume).
 */
export function resumeAudio() {
  if (!context || context.state === 'running') return Promise.resolve(true);
  return context.resume().then(() => context.state === 'running', () => false);
}

export const isAudioSuspended = () => !!context && context.state !== 'running';

/** Called whenever the audio context (re)starts running, e.g. after the OS suspended it. */
export function onAudioRunning(callback) {
  onRunning = callback;
}

const COUNTDOWN_SECONDS = 5; // one tick per second at the end of each rest

const NOTES = {
  work: [{ frequency: 880 }, { frequency: 880, offset: 0.24 }],
  tick: [{ frequency: 660, duration: 0.12 }],
  alarmHigh: [{ frequency: 988, duration: 0.1, volume: 0.12, type: 'square' }],
  alarmLow: [{ frequency: 784, duration: 0.1, volume: 0.12, type: 'square' }],
  finish: [
    { frequency: 660, duration: 0.22 },
    { frequency: 880, duration: 0.22, offset: 0.3 },
    { frequency: 1046, duration: 0.22, offset: 0.6 },
  ],
};

/**
 * Pure: every sound of the workout from `elapsedMs` on, as { atMs (relative to elapsedMs), kind }.
 * Events already in the past are left out, so rescheduling never repeats a sound.
 */
export function soundEvents(phases, elapsedMs) {
  const events = [];
  const add = (atMs, kind) => {
    if (atMs >= elapsedMs) events.push({ atMs: atMs - elapsedMs, kind });
  };
  let start = 0;
  for (const phase of phases) {
    const end = start + phase.durationMs;
    if (phase.type === 'work') add(start, 'work');
    if (phase.type === 'alarm') {
      // "Time's up": bursts of 4 fast beeps every second, alternating pitch.
      for (let second = 0; second * 1000 < phase.durationMs; second++) {
        for (let i = 0; i < 4; i++) {
          const t = second * 1000 + i * 150;
          if (t + 100 <= phase.durationMs) add(start + t, second % 2 ? 'alarmLow' : 'alarmHigh');
        }
      }
    }
    if (phase.type === 'rest') {
      for (let s = Math.min(COUNTDOWN_SECONDS, Math.floor(phase.durationMs / 1000)); s >= 1; s--) add(end - s * 1000, 'tick');
    }
    start = end;
  }
  if (phases.length) add(start, 'finish');
  return events;
}

function tone(output, at, { frequency, duration = 0.16, volume = 0.18, type = 'sine' }) {
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
  return osc;
}

/**
 * Schedules all remaining workout sounds on the audio clock. Returns a cancel function
 * (pause/stop/restart/reschedule). Nothing plays if audio was never unlocked.
 * shortcut: schedules the whole workout at once (~30 nodes per cycle); fine up to 99 cycles.
 */
export function scheduleWorkoutSounds(phases, elapsedMs) {
  if (!context) return () => {};
  const output = context.createGain(); // one node to cut everything at once
  output.connect(context.destination);
  const base = context.currentTime + 0.05;
  const oscillators = [];
  for (const { atMs, kind } of soundEvents(phases, elapsedMs)) {
    for (const note of NOTES[kind]) oscillators.push(tone(output, base + atMs / 1000 + (note.offset ?? 0), note));
  }
  return () => {
    output.disconnect();
    for (const osc of oscillators) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
    }
  };
}
