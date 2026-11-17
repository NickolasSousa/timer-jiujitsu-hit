// UI layer: wires DOM ↔ timer engine ↔ repository. No timing math lives here.

import { IntervalTimer, formatTime, normalizeConfig } from './timer.js';
import { createLocalStorageRepository } from './storage.js';
import { sounds, unlockAudio } from './sound.js';

const TICK_MS = 100; // only triggers re-render (and countdown ticks); elapsed time comes from timestamps
const COUNTDOWN_SECONDS = 5; // one tick per second at the end of each rest
const BASE_TITLE = 'Interval Timer';
const LABELS = { work: 'Atividade', alarm: 'Fim da atividade', rest: 'Descanso' };

const $ = (id) => document.getElementById(id);
const el = {
  phaseLabel: $('phase-label'),
  time: $('time'),
  cycle: $('cycle'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  total: $('total'),
  toggle: $('btn-toggle'),
  restart: $('btn-restart'),
  stop: $('btn-stop'),
  configForm: $('config-form'),
  configFieldset: $('config-fieldset'),
  configLockHint: $('config-lock-hint'),
  newPreset: $('btn-new-preset'),
  presetList: $('preset-list'),
  presetEmpty: $('preset-empty'),
  dialog: $('preset-dialog'),
  dialogTitle: $('preset-dialog-title'),
  presetForm: $('preset-form'),
  cancelPreset: $('btn-cancel-preset'),
};

const repo = createLocalStorageRepository();
const settings = repo.loadSettings();
let presets = repo.listPresets();
let selectedPresetId = settings.selectedPresetId;
let editingPresetId = null;
let lastPhaseIndex = null; // for detecting phase transitions (sounds)
let lastCountdownKey = null; // `${phaseIndex}:${second}` already ticked, so pause/resume never repeats one
let alarm = null; // { phaseIndex, stop } while the end-of-activity alarm is sounding
let tickHandle = null;
let wakeLock = null;

const timer = new IntervalTimer(settings.config);

// ---------- Form helpers (shared by config form and preset dialog) ----------

const fieldsTemplate = $('timer-fields-template');
el.configFieldset.append(fieldsTemplate.content.cloneNode(true));
$('preset-fields').append(fieldsTemplate.content.cloneNode(true));

function readTimerFields(form) {
  const num = (name) => Number(form.elements[name].value) || 0;
  return normalizeConfig({
    workSeconds: num('workMin') * 60 + num('workSec'),
    restSeconds: num('restMin') * 60 + num('restSec'),
    cycles: form.elements.cycles.value,
  });
}

function writeTimerFields(form, { workSeconds, restSeconds, cycles }) {
  const f = form.elements;
  f.workMin.value = Math.floor(workSeconds / 60);
  f.workSec.value = workSeconds % 60;
  f.restMin.value = Math.floor(restSeconds / 60);
  f.restSec.value = restSeconds % 60;
  f.cycles.value = cycles;
}

const sameConfig = (a, b) =>
  a.workSeconds === b.workSeconds && a.restSeconds === b.restSeconds && a.cycles === b.cycles;

const describeConfig = ({ workSeconds, restSeconds, cycles }) =>
  `${formatTime(workSeconds * 1000)} / ${formatTime(restSeconds * 1000)} · ${cycles}×`;

// ---------- Config ----------

function applyConfig(config, presetId = selectedPresetId) {
  if (!timer.setConfig(config)) return; // locked while a workout is in progress
  selectedPresetId = presetId;
  lastPhaseIndex = null;
  repo.saveSettings({ config: timer.config, selectedPresetId });
  render();
  renderPresets();
}

el.configForm.addEventListener('input', () => {
  const config = readTimerFields(el.configForm);
  const selected = presets.find((p) => p.id === selectedPresetId);
  applyConfig(config, selected && sameConfig(selected, config) ? selected.id : null);
});
// Write back the normalized values once the user leaves a field (e.g. 75s → 1min 15s).
el.configForm.addEventListener('change', () => writeTimerFields(el.configForm, timer.config));
el.configForm.addEventListener('submit', (e) => e.preventDefault());

// ---------- Timer controls ----------

el.toggle.addEventListener('click', () => {
  unlockAudio();
  if (timer.status !== 'paused' && timer.status !== 'running') lastPhaseIndex = -1; // fresh start → beep
  timer.toggle();
  render();
});

el.restart.addEventListener('click', () => {
  unlockAudio();
  lastPhaseIndex = -1;
  timer.restart();
  render();
});

el.stop.addEventListener('click', () => {
  timer.reset();
  lastPhaseIndex = null;
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || el.dialog.open) return;
  if (e.target.closest('input, button, textarea, select')) return;
  e.preventDefault();
  el.toggle.click();
});

// Background tabs throttle timers; re-render immediately on return (time is already correct).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    render();
    if (timer.status === 'running') requestWakeLock();
  }
});

function syncTicker() {
  const running = timer.status === 'running';
  if (running && !tickHandle) tickHandle = setInterval(render, TICK_MS);
  if (!running && tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

async function requestWakeLock() {
  // Keeps the phone screen on during the workout, where supported.
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* not critical */
  }
}

function syncWakeLock() {
  if (timer.status === 'running') requestWakeLock();
  else if (wakeLock) wakeLock.release().catch(() => {});
}

function playTransitionSound(snap) {
  const active = snap.status === 'running' || snap.status === 'finished';
  if (active && lastPhaseIndex !== null && snap.phaseIndex !== lastPhaseIndex) {
    // Coming back from a long background stretch may skip phases: play only the current one.
    // (alarm has its own sync below; rest starts silently because the alarm just announced it)
    ({ work: sounds.work, done: sounds.finish })[snap.phase]?.();
  }
  lastPhaseIndex = active || snap.status === 'paused' ? snap.phaseIndex : null;
}

/** Alarm sounds only while running inside an alarm phase: stops on pause/stop/restart, resumes with the remaining time. */
function syncAlarm(snap) {
  const shouldPlay = snap.status === 'running' && snap.phase === 'alarm';
  if (alarm && (!shouldPlay || alarm.phaseIndex !== snap.phaseIndex)) {
    alarm.stop();
    alarm = null;
  }
  if (shouldPlay && !alarm) alarm = { phaseIndex: snap.phaseIndex, stop: sounds.alarm(snap.remainingMs / 1000) };
}

function playCountdown(snap) {
  if (snap.status !== 'running' || snap.phase !== 'rest') return;
  const second = Math.ceil(snap.remainingMs / 1000);
  const key = `${snap.phaseIndex}:${second}`;
  if (second <= COUNTDOWN_SECONDS && key !== lastCountdownKey) {
    lastCountdownKey = key;
    sounds.tick();
  }
}

// ---------- Rendering ----------

function render() {
  const snap = timer.snapshot();
  const { status, cycles } = snap;
  playTransitionSound(snap);
  syncAlarm(snap);
  playCountdown(snap);

  let label, time, cycleText, totalText;
  if (status === 'idle') {
    label = 'Pronto';
    time = formatTime(timer.config.workSeconds * 1000);
    cycleText = cycles === 1 ? '1 ciclo' : `${cycles} ciclos`;
    totalText = `Total ${formatTime(snap.totalMs)}`;
  } else if (status === 'finished') {
    label = 'Treino concluído';
    time = '00:00';
    cycleText = `${cycles} de ${cycles} ciclos`;
    totalText = `Total ${formatTime(snap.totalMs)}`;
  } else {
    label = LABELS[snap.phase] + (status === 'paused' ? ' · pausado' : '');
    time = snap.phase === 'alarm' ? '00:00' : formatTime(snap.remainingMs);
    cycleText =
      snap.phase === 'rest'
        ? `Próximo: ciclo ${snap.cycle + 1} de ${cycles}`
        : `Ciclo ${snap.cycle} de ${cycles}`;
    totalText = `Restante ${formatTime(snap.totalRemainingMs)}`;
  }

  document.body.dataset.status = status;
  document.body.dataset.phase = status === 'idle' ? 'idle' : snap.phase;
  el.phaseLabel.textContent = label;
  el.time.textContent = time;
  el.cycle.textContent = cycleText;
  el.total.textContent = totalText;

  const percent = Math.round(snap.progress * 1000) / 10;
  el.progressBar.style.width = `${percent}%`;
  el.progress.setAttribute('aria-valuenow', String(Math.round(percent)));

  el.toggle.textContent = { idle: 'Iniciar', running: 'Pausar', paused: 'Continuar', finished: 'Iniciar novamente' }[status];
  el.restart.disabled = status === 'idle';
  el.stop.disabled = status === 'idle';

  const locked = status === 'running' || status === 'paused';
  el.configFieldset.disabled = locked;
  el.configLockHint.hidden = !locked;
  el.presetList.querySelectorAll('.preset-select').forEach((b) => (b.disabled = locked));

  document.title = status === 'idle' ? BASE_TITLE : `${time} · ${label} — ${BASE_TITLE}`;

  syncTicker();
  syncWakeLock();
}

// ---------- Presets ----------

function renderPresets() {
  const locked = timer.status === 'running' || timer.status === 'paused';
  el.presetList.replaceChildren(
    ...presets.map((preset) => {
      const selected = preset.id === selectedPresetId;
      const li = document.createElement('li');
      li.className = 'preset';
      li.toggleAttribute('data-selected', selected);

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'preset-select';
      select.disabled = locked;
      select.setAttribute('aria-pressed', String(selected));
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = preset.name; // textContent: user input is never parsed as HTML
      const meta = document.createElement('span');
      meta.className = 'preset-meta';
      meta.textContent = describeConfig(preset);
      select.append(name, meta);
      select.addEventListener('click', () => {
        applyConfig(preset, preset.id);
        writeTimerFields(el.configForm, timer.config);
      });

      const edit = actionButton('Editar', `Editar ${preset.name}`, () => openPresetDialog(preset));
      const remove = actionButton('Excluir', `Excluir ${preset.name}`, () => deletePreset(preset));
      remove.classList.add('btn-danger');

      li.append(select, edit, remove);
      return li;
    }),
  );
  el.presetEmpty.hidden = presets.length > 0;
}

function actionButton(text, ariaLabel, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small btn-ghost';
  button.textContent = text;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function deletePreset(preset) {
  if (!confirm(`Excluir a predefinição "${preset.name}"?`)) return;
  if (!repo.deletePreset(preset.id)) return alert('Não foi possível excluir a predefinição.');
  presets = repo.listPresets();
  if (selectedPresetId === preset.id) {
    selectedPresetId = null;
    repo.saveSettings({ config: timer.config, selectedPresetId });
  }
  renderPresets();
}

// New presets start from the current timer config, so "Nova" doubles as "save current".
function openPresetDialog(preset = null) {
  editingPresetId = preset?.id ?? null;
  el.dialogTitle.textContent = preset ? 'Editar predefinição' : 'Nova predefinição';
  el.presetForm.elements.name.value = preset?.name ?? '';
  writeTimerFields(el.presetForm, preset ?? timer.config);
  el.dialog.showModal();
  el.presetForm.elements.name.focus();
}

el.newPreset.addEventListener('click', () => openPresetDialog());
el.cancelPreset.addEventListener('click', () => el.dialog.close());

el.presetForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nameInput = el.presetForm.elements.name;
  nameInput.setCustomValidity(nameInput.value.trim() ? '' : 'Informe um nome.');
  if (!nameInput.reportValidity()) return;

  const saved = repo.savePreset({ id: editingPresetId, name: nameInput.value, ...readTimerFields(el.presetForm) });
  if (!saved) return alert('Não foi possível salvar a predefinição.');
  presets = repo.listPresets();
  el.dialog.close();

  // Editing the active preset (or creating a new one) loads it into the timer, if not mid-workout.
  if (!editingPresetId || editingPresetId === selectedPresetId) {
    applyConfig(saved, saved.id);
    writeTimerFields(el.configForm, timer.config);
  }
  renderPresets();
});
el.presetForm.elements.name.addEventListener('input', (e) => e.target.setCustomValidity(''));

// ---------- Boot ----------

writeTimerFields(el.configForm, timer.config);
renderPresets();
render();
