import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStorageRepository, DEFAULT_PRESETS } from '../src/storage.js';

function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => (data[k] = String(v)),
  };
}

test('settings: defaults, then survive a "reload" (new repository on same store)', () => {
  const store = fakeStore();
  const repo = createLocalStorageRepository(store);
  assert.deepEqual(repo.loadSettings(), { config: { workSeconds: 300, restSeconds: 60, cycles: 6 }, selectedPresetId: null });

  repo.saveSettings({ config: { workSeconds: 40, restSeconds: 20, cycles: 10 }, selectedPresetId: 'hiit' });
  const reloaded = createLocalStorageRepository(store);
  assert.deepEqual(reloaded.loadSettings(), { config: { workSeconds: 40, restSeconds: 20, cycles: 10 }, selectedPresetId: 'hiit' });
});

test('corrupted or tampered data falls back safely', () => {
  const store = fakeStore({
    'interval-timer:settings:v1': '{not json',
    'interval-timer:presets:v1': JSON.stringify([null, { id: 'a', name: '  ', workSeconds: -1, cycles: 'x' }]),
  });
  const repo = createLocalStorageRepository(store);
  assert.deepEqual(repo.loadSettings().config, { workSeconds: 300, restSeconds: 60, cycles: 6 });
  assert.deepEqual(repo.listPresets(), [{ id: 'a', name: 'Sem nome', workSeconds: 1, restSeconds: 60, cycles: 6 }]);
});

test('presets: seeded examples, create, edit, delete, persisted', () => {
  const store = fakeStore();
  const repo = createLocalStorageRepository(store);
  assert.deepEqual(repo.listPresets().map((p) => p.name), DEFAULT_PRESETS.map((p) => p.name));

  const created = repo.savePreset({ name: ' Corrida ', workSeconds: 120, restSeconds: 30, cycles: 8 });
  assert.equal(created.name, 'Corrida');
  assert.ok(created.id);

  repo.savePreset({ ...created, name: 'Corrida leve', cycles: 5 });
  const reloaded = createLocalStorageRepository(store).listPresets();
  assert.equal(reloaded.length, 3);
  assert.deepEqual(reloaded.find((p) => p.id === created.id), { ...created, name: 'Corrida leve', cycles: 5 });

  repo.deletePreset('jiu-jitsu');
  repo.deletePreset('hiit');
  repo.deletePreset(created.id);
  // Deleting everything must not resurrect the seeded examples.
  assert.deepEqual(createLocalStorageRepository(store).listPresets(), []);
});

test('write failures (quota) are reported, not thrown', () => {
  const store = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const repo = createLocalStorageRepository(store);
  const errors = console.error;
  console.error = () => {};
  try {
    assert.equal(repo.savePreset({ name: 'x', workSeconds: 1, restSeconds: 0, cycles: 1 }), null);
    assert.equal(repo.saveSettings({ config: {} }), false);
  } finally {
    console.error = errors;
  }
});
