// UI layer: wires DOM ↔ timer engine ↔ repository. No timing math lives here.

import { IntervalTimer, MAX_DURATION_SECONDS, formatTime, normalizeConfig } from './timer.js';
import { createLocalStorageRepository } from './storage.js';
import { isAudioSuspended, onAudioRunning, resumeAudio, scheduleWorkoutSounds, unlockAudio } from './sound.js';

const TICK_MS = 100; // only triggers re-render; elapsed time comes from timestamps, sounds from the audio clock
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
  audioHint: $('audio-hint'),
  toggle: $('btn-toggle'),
  restart: $('btn-restart'),
  stop: $('btn-stop'),
  configForm: $('config-form'),
  configFieldset: $('config-fieldset'),
  configLockHint: $('config-lock-hint'),
  configFeedback: $('config-feedback'),
  newPreset: $('btn-new-preset'),
  presetList: $('preset-list'),
  presetEmpty: $('preset-empty'),
  dialog: $('preset-dialog'),
  dialogTitle: $('preset-dialog-title'),
  presetForm: $('preset-form'),
  presetFeedback: $('preset-feedback'),
  cancelPreset: $('btn-cancel-preset'),
};

const repo = createLocalStorageRepository();
const settings = repo.loadSettings();
let presets = repo.listPresets();
let selectedPresetId = settings.selectedPresetId;
let editingPresetId = null;
let cancelSounds = null; // cancels the sounds scheduled for the running workout
let tickHandle = null;
let wakeLock = null;
let wakeLockPending = false;

const timer = new IntervalTimer(settings.config);

// ---------- Form helpers (shared by config form and preset dialog) ----------

const fieldsTemplate = $('timer-fields-template');
el.configFieldset.append(fieldsTemplate.content.cloneNode(true));
$('preset-fields').append(fieldsTemplate.content.cloneNode(true));

/** A field's value clamped to its own min/max attributes; empty or invalid counts as its min. */
function fieldValue(input) {
  const n = Math.floor(Number(input.value));
  const min = Number(input.min);
  return Number.isFinite(n) ? Math.min(Number(input.max), Math.max(min, n)) : min;
}

/** Non-negative integer typed in a field; empty, negative or invalid counts as 0. */
function typedInt(input) {
  const n = Math.floor(Number(input.value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Total seconds of the "work" or "rest" fields; seconds may exceed 59 (75 s = 1:15). */
function durationOf(form, prefix) {
  return Math.min(MAX_DURATION_SECONDS, fieldValue(form.elements[`${prefix}Min`]) * 60 + typedInt(form.elements[`${prefix}Sec`]));
}

function readTimerFields(form) {
  return normalizeConfig({
    workSeconds: durationOf(form, 'work'),
    restSeconds: durationOf(form, 'rest'),
    cycles: fieldValue(form.elements.cycles),
  });
}

const feedbackTimeouts = new WeakMap();

/** Discreet message under a form; informational ones fade after a few seconds, errors stay. */
function showFeedback(target, message, { error = false } = {}) {
  clearTimeout(feedbackTimeouts.get(target));
  target.textContent = message;
  target.classList.toggle('is-error', error);
  if (message && !error) feedbackTimeouts.set(target, setTimeout(() => (target.textContent = ''), 4000));
}

/** Flags a zero-length activity as invalid (it is never applied or saved). Returns whether it is valid. */
function checkActivity(form, feedback) {
  const valid = durationOf(form, 'work') > 0;
  for (const name of ['workMin', 'workSec']) {
    if (valid) form.elements[name].removeAttribute('aria-invalid');
    else form.elements[name].setAttribute('aria-invalid', 'true');
  }
  if (!valid) showFeedback(feedback, 'A atividade precisa ter pelo menos 1 segundo.', { error: true });
  else if (feedback.classList.contains('is-error')) showFeedback(feedback, '');
  return valid;
}

/** On leaving a field: seconds above 59 carry into that duration's minutes; other fields only clamp themselves. */
function normalizeField(form, input, feedback) {
  const prefix = /^(work|rest)Sec$/.exec(input.name)?.[1];
  if (prefix && typedInt(input) > 59) {
    const total = durationOf(form, prefix);
    form.elements[`${prefix}Min`].value = Math.floor(total / 60);
    input.value = total % 60;
    showFeedback(feedback, `Convertido para ${Math.floor(total / 60)} min ${total % 60} s.`);
  } else {
    input.value = fieldValue(input);
  }
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
  repo.saveSettings({ config: timer.config, selectedPresetId });
  render();
  renderPresets();
}

function syncConfigFields() {
  writeTimerFields(el.configForm, timer.config);
  checkActivity(el.configForm, el.configFeedback);
}

el.configForm.addEventListener('input', () => {
  // A zero-length activity is never applied: the timer keeps the last valid config.
  if (!durationOf(el.configForm, 'work')) return;
  checkActivity(el.configForm, el.configFeedback);
  const config = readTimerFields(el.configForm);
  const selected = presets.find((p) => p.id === selectedPresetId);
  applyConfig(config, selected && sameConfig(selected, config) ? selected.id : null);
});
// While typing a field may be empty; values are normalized only when leaving it, and other
// fields are never rewritten (except the minutes receiving a seconds carry-over).
el.configForm.addEventListener('change', (e) => {
  if (!e.target.matches('input')) return;
  normalizeField(el.configForm, e.target, el.configFeedback);
  checkActivity(el.configForm, el.configFeedback);
});
el.configForm.addEventListener('submit', (e) => e.preventDefault());

// ---------- Timer controls ----------

el.toggle.addEventListener('click', () => {
  unlockAudio();
  timer.toggle();
  // A "pause" that lands after the end becomes finished: let the finish chime play out.
  if (timer.status === 'running') {
    scheduleSounds();
    requestWakeLock();
  } else if (timer.status === 'paused') stopSounds();
  render();
});

el.restart.addEventListener('click', () => {
  unlockAudio();
  timer.restart();
  scheduleSounds();
  requestWakeLock();
  render();
});

el.stop.addEventListener('click', () => {
  timer.reset();
  stopSounds();
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
  if (document.visibilityState !== 'visible') return;
  render();
  if (timer.status === 'running') requestWakeLock(); // browsers release it when the tab is hidden
  // If the OS suspended audio, onAudioRunning reschedules once it runs again. Some browsers (iOS)
  // only allow that from a user gesture: then ask for a tap (the resume may never settle).
  resumeAudio().then(updateAudioHint);
  setTimeout(updateAudioHint, 1000);
});

function updateAudioHint() {
  el.audioHint.hidden = !(timer.status === 'running' && isAudioSuspended());
}

// Any interaction while the hint is shown retries the resume inside the gesture.
for (const type of ['click', 'touchend', 'keydown']) {
  document.addEventListener(type, () => el.audioHint.hidden || unlockAudio(), true);
}

// ---------- Sounds ----------

function scheduleSounds() {
  cancelSounds?.();
  cancelSounds = scheduleWorkoutSounds(timer.phases, timer.elapsedMs());
}

function stopSounds() {
  cancelSounds?.();
  cancelSounds = null;
}

// A suspended audio context froze its clock, so the old schedule is late: redo it from now.
onAudioRunning(() => {
  el.audioHint.hidden = true;
  if (timer.status === 'running') scheduleSounds();
});

function syncTicker() {
  const running = timer.status === 'running';
  if (running && !tickHandle) tickHandle = setInterval(render, TICK_MS);
  if (!running && tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

// Keeps the phone screen on during the workout, where supported.
// One request at a time; a lock that arrives after the workout stopped running is released at once.
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || wakeLockPending) return;
  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (timer.status !== 'running') {
      lock.release().catch(() => {});
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    /* not critical */
  } finally {
    wakeLockPending = false;
  }
}

// Requests happen only on start/resume/restart/return to the tab (never per render), so a
// browser that refuses the lock isn't asked again 10×/s. Release happens as soon as it stops running.
function syncWakeLock() {
  if (timer.status !== 'running' && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ---------- Rendering ----------

function render() {
  const snap = timer.snapshot();
  const { status, cycles } = snap;

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
  if (status !== 'running') el.audioHint.hidden = true;
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
        syncConfigFields();
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
  showFeedback(el.presetFeedback, '');
  checkActivity(el.presetForm, el.presetFeedback);
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
  if (!checkActivity(el.presetForm, el.presetFeedback)) return el.presetForm.elements.workMin.focus();

  const saved = repo.savePreset({ id: editingPresetId, name: nameInput.value, ...readTimerFields(el.presetForm) });
  if (!saved) return alert('Não foi possível salvar a predefinição.');
  presets = repo.listPresets();
  el.dialog.close();

  // Editing the active preset (or creating a new one) loads it into the timer, if not mid-workout.
  if (!editingPresetId || editingPresetId === selectedPresetId) {
    applyConfig(saved, saved.id);
    syncConfigFields();
  }
  renderPresets();
});
el.presetForm.elements.name.addEventListener('input', (e) => e.target.setCustomValidity(''));
el.presetForm.addEventListener('change', (e) => {
  if (e.target.type !== 'number') return;
  normalizeField(el.presetForm, e.target, el.presetFeedback);
  checkActivity(el.presetForm, el.presetFeedback);
});
el.presetForm.addEventListener('input', (e) => {
  if (e.target.type === 'number' && durationOf(el.presetForm, 'work')) checkActivity(el.presetForm, el.presetFeedback);
});

// ---------- Boot ----------

syncConfigFields();
renderPresets();
render();
