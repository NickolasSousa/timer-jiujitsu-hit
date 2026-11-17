import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhases, getStateAt, formatTime, normalizeConfig, IntervalTimer, ALARM_MS } from '../src/timer.js';

const A = ALARM_MS;

const seq = (cfg) => buildPhases(cfg).map((p) => p.type).join(' ');

test('cycle sequence: alarm after every activity, rest only between cycles', () => {
  assert.equal(seq({ workSeconds: 10, restSeconds: 5, cycles: 1 }), 'work alarm');
  assert.equal(seq({ workSeconds: 10, restSeconds: 5, cycles: 2 }), 'work alarm rest work alarm');
  assert.equal(seq({ workSeconds: 10, restSeconds: 5, cycles: 4 }), 'work alarm rest work alarm rest work alarm rest work alarm');
  assert.equal(seq({ workSeconds: 10, restSeconds: 0, cycles: 3 }), 'work alarm work alarm work alarm');
  assert.equal(buildPhases({ workSeconds: 10, restSeconds: 5, cycles: 2 }, 0).map((p) => p.type).join(' '), 'work rest work');
});

test('rest does not start until the alarm has finished', () => {
  const phases = buildPhases({ workSeconds: 10, restSeconds: 5, cycles: 2 });
  let s = getStateAt(phases, 10000);
  assert.deepEqual([s.phase, s.cycle, s.remainingMs], ['alarm', 1, A]);
  s = getStateAt(phases, 10000 + A - 1);
  assert.equal(s.phase, 'alarm');
  s = getStateAt(phases, 10000 + A);
  assert.deepEqual([s.phase, s.remainingMs], ['rest', 5000]);
  assert.ok(A >= 4000 && A <= 5000);
});

test('getStateAt: boundaries and transitions (no alarm)', () => {
  const phases = buildPhases({ workSeconds: 10, restSeconds: 5, cycles: 2 }, 0); // 25s total
  let s = getStateAt(phases, 0);
  assert.deepEqual([s.phase, s.cycle, s.remainingMs, s.totalRemainingMs], ['work', 1, 10000, 25000]);
  s = getStateAt(phases, 9999);
  assert.deepEqual([s.phase, s.remainingMs], ['work', 1]);
  s = getStateAt(phases, 10000);
  assert.deepEqual([s.phase, s.cycle, s.remainingMs], ['rest', 1, 5000]);
  s = getStateAt(phases, 15000);
  assert.deepEqual([s.phase, s.cycle, s.remainingMs], ['work', 2, 10000]);
  s = getStateAt(phases, 25000);
  assert.deepEqual([s.done, s.phase, s.progress, s.cycle], [true, 'done', 1, 2]);
});

test('formatTime rounds up to whole seconds', () => {
  assert.equal(formatTime(300000), '05:00');
  assert.equal(formatTime(299001), '05:00');
  assert.equal(formatTime(1), '00:01');
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(-50), '00:00');
  assert.equal(formatTime(6000 * 1000), '100:00');
});

test('normalizeConfig clamps and repairs bad input', () => {
  assert.deepEqual(normalizeConfig({ workSeconds: 0, restSeconds: -5, cycles: 0 }), { workSeconds: 1, restSeconds: 0, cycles: 1 });
  assert.deepEqual(normalizeConfig({ workSeconds: '40', restSeconds: '20.7', cycles: '10' }), { workSeconds: 40, restSeconds: 20, cycles: 10 });
  assert.deepEqual(normalizeConfig({ workSeconds: 'x', restSeconds: null, cycles: 1e9 }), { workSeconds: 300, restSeconds: 0, cycles: 99 });
});

function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('controller: start, pause stops counting, resume continues', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 10, restSeconds: 5, cycles: 2 }, clock);
  timer.start();
  clock.advance(4000);
  assert.equal(timer.snapshot().remainingMs, 6000);

  timer.pause();
  clock.advance(60000); // long pause
  assert.equal(timer.snapshot().remainingMs, 6000);
  assert.equal(timer.status, 'paused');

  timer.start(); // resume
  clock.advance(6000 + A + 1000);
  const s = timer.snapshot();
  assert.deepEqual([s.phase, s.remainingMs], ['rest', 4000]);
});

test('controller: big jump (background tab) lands on the correct phase', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 300, restSeconds: 60, cycles: 6 }, clock);
  timer.start();
  clock.advance(((300 + 60) * 1000 + A) * 3 + 120000); // 3 full cycles + 2 min into cycle 4
  const s = timer.snapshot();
  assert.deepEqual([s.phase, s.cycle, s.remainingMs], ['work', 4, 180000]);
});

test('controller: finishes after last work phase + alarm, no trailing rest', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 10, restSeconds: 5, cycles: 3 }, clock);
  timer.start();
  clock.advance(40000 + 3 * A - 1);
  assert.deepEqual([timer.snapshot().phase, timer.snapshot().cycle], ['alarm', 3]);
  clock.advance(1);
  const s = timer.snapshot();
  assert.equal(s.status, 'finished');
  assert.equal(s.remainingMs, 0);
  clock.advance(10000);
  assert.equal(timer.snapshot().progress, 1);
});

test('controller: start is idempotent (no double timers), restart goes back to cycle 1', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 10, restSeconds: 5, cycles: 2 }, clock);
  timer.start();
  clock.advance(12000 + A);
  timer.start(); // must not reset or double-count
  assert.deepEqual([timer.snapshot().phase, timer.snapshot().remainingMs], ['rest', 3000]);

  timer.restart();
  const s = timer.snapshot();
  assert.deepEqual([s.status, s.phase, s.cycle, s.remainingMs], ['running', 'work', 1, 10000]);

  timer.pause();
  timer.restart(); // restart from paused also runs from zero
  assert.deepEqual([timer.status, timer.snapshot().remainingMs], ['running', 10000]);
});

test('controller: config locked while running/paused, reset returns to idle', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 10, restSeconds: 5, cycles: 2 }, clock);
  timer.start();
  assert.equal(timer.setConfig({ workSeconds: 99, restSeconds: 0, cycles: 1 }), false);
  timer.pause();
  assert.equal(timer.setConfig({ workSeconds: 99, restSeconds: 0, cycles: 1 }), false);
  timer.reset();
  assert.equal(timer.status, 'idle');
  assert.equal(timer.setConfig({ workSeconds: 99, restSeconds: 0, cycles: 1 }), true);
  assert.equal(timer.snapshot().remainingMs, 99000);
});

test('controller: starting again after finishing begins from zero', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 5, restSeconds: 0, cycles: 1 }, clock);
  timer.start();
  clock.advance(5000 + A);
  assert.equal(timer.snapshot().status, 'finished');
  timer.start();
  assert.deepEqual([timer.status, timer.snapshot().remainingMs], ['running', 5000]);
});

test('controller: pausing during the alarm holds it; resume finishes it before rest', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 10, restSeconds: 5, cycles: 2 }, clock);
  timer.start();
  clock.advance(10000 + 1000);
  timer.pause();
  clock.advance(60000);
  assert.deepEqual([timer.snapshot().phase, timer.snapshot().remainingMs], ['alarm', A - 1000]);
  timer.start();
  clock.advance(A - 1000);
  assert.deepEqual([timer.snapshot().phase, timer.snapshot().remainingMs], ['rest', 5000]);
});

test('controller: pausing just after the end (before any render) finishes instead of pausing', () => {
  const clock = fakeClock();
  const timer = new IntervalTimer({ workSeconds: 5, restSeconds: 0, cycles: 1 }, clock);
  timer.start();
  clock.advance(5000 + A + 50); // ended 50ms ago, snapshot() not called yet
  timer.toggle(); // user hits "Pausar"
  assert.equal(timer.status, 'finished');
  const s = timer.snapshot();
  assert.deepEqual([s.status, s.phase, s.progress], ['finished', 'done', 1]);
});
