// Timer engine: pure, DOM-free. Time is always derived from timestamps, never from counted ticks.

export const MAX_DURATION_SECONDS = 99 * 60 + 59;
export const MAX_CYCLES = 99;
export const ALARM_MS = 4500; // end-of-activity alarm; the next phase only starts after it
export const DEFAULT_CONFIG = Object.freeze({ workSeconds: 300, restSeconds: 60, cycles: 6 });

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Coerces any input (form values, stored JSON) into a valid config. */
export function normalizeConfig(raw = {}) {
  return {
    workSeconds: clampInt(raw.workSeconds, 1, MAX_DURATION_SECONDS, DEFAULT_CONFIG.workSeconds),
    restSeconds: clampInt(raw.restSeconds, 0, MAX_DURATION_SECONDS, DEFAULT_CONFIG.restSeconds),
    cycles: clampInt(raw.cycles, 1, MAX_CYCLES, DEFAULT_CONFIG.cycles),
  };
}

/** work → alarm → rest → work … → work → alarm. Rest only between cycles; a 0s rest is skipped. */
export function buildPhases({ workSeconds, restSeconds, cycles }, alarmMs = ALARM_MS) {
  const phases = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    phases.push({ type: 'work', cycle, durationMs: workSeconds * 1000 });
    if (alarmMs > 0) phases.push({ type: 'alarm', cycle, durationMs: alarmMs });
    if (cycle < cycles && restSeconds > 0) {
      phases.push({ type: 'rest', cycle, durationMs: restSeconds * 1000 });
    }
  }
  return phases;
}

export function totalDurationMs(phases) {
  return phases.reduce((sum, p) => sum + p.durationMs, 0);
}

/** Where the workout is after `elapsedMs`. */
export function getStateAt(phases, elapsedMs) {
  const totalMs = totalDurationMs(phases);
  let phaseStart = 0;
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index];
    const phaseEnd = phaseStart + phase.durationMs;
    if (elapsedMs < phaseEnd) {
      return {
        done: false,
        phaseIndex: index,
        phase: phase.type,
        cycle: phase.cycle,
        phaseDurationMs: phase.durationMs,
        remainingMs: phaseEnd - elapsedMs,
        totalRemainingMs: totalMs - elapsedMs,
        progress: totalMs ? elapsedMs / totalMs : 0,
      };
    }
    phaseStart = phaseEnd;
  }
  const last = phases[phases.length - 1];
  return {
    done: true,
    phaseIndex: phases.length,
    phase: 'done',
    cycle: last ? last.cycle : 0,
    phaseDurationMs: 0,
    remainingMs: 0,
    totalRemainingMs: 0,
    progress: 1,
  };
}

/** mm:ss, rounding up so the display reads 05:00 at start and 00:01 in the last second. */
export function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Stateful controller. Status: idle | running | paused | finished.
 * `now` is injectable for tests; performance.now() is monotonic and keeps advancing in background tabs.
 */
export class IntervalTimer {
  constructor(config = DEFAULT_CONFIG, { now = () => performance.now() } = {}) {
    this.now = now;
    this.status = 'idle';
    this.accumulatedMs = 0; // elapsed time banked before the current running stretch
    this.runningSince = 0;
    this.setConfig(config);
  }

  /** Only applies while idle/finished, so a running workout can't be changed underneath. */
  setConfig(config) {
    if (this.status === 'running' || this.status === 'paused') return false;
    this.config = normalizeConfig(config);
    this.phases = buildPhases(this.config);
    this.totalMs = totalDurationMs(this.phases);
    this.reset();
    return true;
  }

  elapsedMs() {
    const live = this.status === 'running' ? this.now() - this.runningSince : 0;
    return Math.min(this.totalMs, this.accumulatedMs + live);
  }

  /** Starts from zero (idle/finished) or resumes (paused). No-op if already running. */
  start() {
    if (this.status === 'running') return;
    if (this.status !== 'paused') this.accumulatedMs = 0;
    this.runningSince = this.now();
    this.status = 'running';
  }

  /** If the workout already ended (no render since), it becomes finished instead of paused. */
  pause() {
    if (this.status !== 'running') return;
    this.accumulatedMs = this.elapsedMs();
    this.status = this.accumulatedMs >= this.totalMs ? 'finished' : 'paused';
  }

  toggle() {
    if (this.status === 'running') this.pause();
    else this.start();
  }

  restart() {
    this.status = 'idle';
    this.start();
  }

  reset() {
    this.status = 'idle';
    this.accumulatedMs = 0;
  }

  snapshot() {
    const state = getStateAt(this.phases, this.elapsedMs());
    if (state.done && this.status === 'running') {
      this.accumulatedMs = this.totalMs;
      this.status = 'finished';
    }
    return { ...state, status: this.status, cycles: this.config.cycles, totalMs: this.totalMs };
  }
}
