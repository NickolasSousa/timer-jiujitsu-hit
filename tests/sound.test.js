import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundEvents } from '../src/sound.js';
import { buildPhases, ALARM_MS } from '../src/timer.js';

const A = ALARM_MS;
const phases = buildPhases({ workSeconds: 10, restSeconds: 8, cycles: 2 });
const total = 10000 + A + 8000 + 10000 + A;
const at = (events, kind) => events.filter((e) => e.kind === kind).map((e) => e.atMs);
const alarmCount = (events) => events.filter((e) => e.kind.startsWith('alarm')).length;

test('full workout from the start: every sound at its exact time', () => {
  const ev = soundEvents(phases, 0);
  assert.deepEqual(at(ev, 'work'), [0, 10000 + A + 8000]);
  assert.equal(alarmCount(ev), 38); // 19 beeps (~4.5s) per alarm, after each activity
  assert.equal(Math.min(...ev.filter((e) => e.kind.startsWith('alarm')).map((e) => e.atMs)), 10000);
  const restEnd = 10000 + A + 8000;
  assert.deepEqual(at(ev, 'tick'), [5, 4, 3, 2, 1].map((s) => restEnd - s * 1000)); // last 5s of rest, 1/s
  assert.deepEqual(at(ev, 'finish'), [total]);
});

test('resuming mid-alarm: only the rest of the alarm, no repeated activity beep', () => {
  const elapsed = 10000 + 2000;
  const ev = soundEvents(phases, elapsed);
  assert.equal(at(ev, 'work').length, 1); // only cycle 2's
  const firstAlarm = ev.filter((e) => e.kind.startsWith('alarm') && e.atMs < A);
  assert.equal(firstAlarm.length, 11); // 2.5s left: 4 + 4 + 3 beeps
  assert.ok(ev.every((e) => e.atMs >= 0));
});

test('resuming mid-countdown: past ticks are not repeated', () => {
  const restEnd = 10000 + A + 8000;
  const ev = soundEvents(phases, restEnd - 2500);
  assert.deepEqual(at(ev, 'tick'), [500, 1500]);
});

test('short rests tick every second; zero rest has no ticks; nothing after the end', () => {
  const short = soundEvents(buildPhases({ workSeconds: 10, restSeconds: 3, cycles: 2 }), 0);
  assert.equal(at(short, 'tick').length, 3);
  const none = soundEvents(buildPhases({ workSeconds: 10, restSeconds: 0, cycles: 2 }), 0);
  assert.equal(at(none, 'tick').length, 0);
  assert.deepEqual(soundEvents(phases, total + 1), []);
  assert.deepEqual(at(soundEvents(phases, total), 'finish'), [0]);
});

test('99 cycles at max durations stays bounded', () => {
  const big = soundEvents(buildPhases({ workSeconds: 5999, restSeconds: 5999, cycles: 99 }), 0);
  assert.equal(big.length, 99 + 99 * 19 + 98 * 5 + 1);
});

test('audio resume: reports suspension and notifies when audio runs again', async () => {
  const { unlockAudio, resumeAudio, isAudioSuspended, onAudioRunning } = await import('../src/sound.js');
  assert.equal(isAudioSuspended(), false); // never unlocked: nothing to resume
  assert.equal(await resumeAudio(), true);

  let allowResume = false; // iOS-like: resume() outside a user gesture leaves the context suspended
  class FakeContext extends EventTarget {
    constructor() { super(); this.state = 'running'; FakeContext.last = this; }
    resume() {
      if (allowResume && this.state !== 'running') {
        this.state = 'running';
        this.dispatchEvent(new Event('statechange'));
      }
      return Promise.resolve();
    }
  }
  globalThis.window = { AudioContext: FakeContext };
  let runningEvents = 0;
  onAudioRunning(() => runningEvents++);
  unlockAudio();
  assert.equal(isAudioSuspended(), false);

  FakeContext.last.state = 'suspended'; // OS suspended audio while the tab was hidden
  assert.equal(isAudioSuspended(), true);
  assert.equal(await resumeAudio(), false); // refused: the app must ask for a tap
  assert.equal(runningEvents, 0);

  allowResume = true; // the tap: resume now works
  unlockAudio();
  assert.equal(isAudioSuspended(), false);
  assert.equal(runningEvents, 1); // the app reschedules sounds and hides the hint here
  delete globalThis.window;
});
