// Persistence layer. The app only talks to the repository interface below
// (loadSettings, saveSettings, listPresets, savePreset, deletePreset), so swapping
// localStorage for an API/database means writing another repository with the same methods.

import { DEFAULT_CONFIG, normalizeConfig } from './timer.js';

const KEYS = {
  settings: 'interval-timer:settings:v1',
  presets: 'interval-timer:presets:v1',
};

export const DEFAULT_PRESETS = Object.freeze([
  { id: 'jiu-jitsu', name: 'Jiu-Jitsu', workSeconds: 300, restSeconds: 60, cycles: 6 },
  { id: 'hiit', name: 'HIIT', workSeconds: 40, restSeconds: 20, cycles: 10 },
]);

const MAX_NAME_LENGTH = 40;

function createId() {
  // crypto.randomUUID is unavailable on plain-http LAN addresses (e.g. testing on a phone).
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function toPreset(raw) {
  const name = String(raw?.name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : createId(),
    name: name || 'Sem nome',
    ...normalizeConfig(raw),
  };
}

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function defaultStore() {
  try {
    return globalThis.localStorage ?? memoryStore();
  } catch {
    // Accessing localStorage throws when site data is blocked; keep the app usable for this session.
    return memoryStore();
  }
}

export function createLocalStorageRepository(store = defaultStore()) {
  function read(key) {
    try {
      const raw = store.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (error) {
      console.warn(`Ignoring unreadable data in "${key}"`, error);
      return null;
    }
  }

  function write(key, value) {
    try {
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`Could not save "${key}"`, error);
      return false;
    }
  }

  function listPresets() {
    const stored = read(KEYS.presets);
    // Seed examples only on first use; an empty saved list means the user deleted them.
    if (!Array.isArray(stored)) return DEFAULT_PRESETS.map((p) => ({ ...p }));
    return stored.filter((p) => p && typeof p === 'object').map(toPreset);
  }

  return {
    loadSettings() {
      const stored = read(KEYS.settings) ?? {};
      return {
        config: normalizeConfig({ ...DEFAULT_CONFIG, ...stored.config }),
        selectedPresetId: typeof stored.selectedPresetId === 'string' ? stored.selectedPresetId : null,
      };
    },

    saveSettings({ config, selectedPresetId = null }) {
      return write(KEYS.settings, { config: normalizeConfig(config), selectedPresetId });
    },

    listPresets,

    /** Creates (no id / unknown id) or updates a preset. Returns the saved preset, or null on failure. */
    savePreset(input) {
      const preset = toPreset(input);
      const presets = listPresets();
      const index = presets.findIndex((p) => p.id === preset.id);
      if (index === -1) presets.push(preset);
      else presets[index] = preset;
      return write(KEYS.presets, presets) ? preset : null;
    },

    deletePreset(id) {
      return write(KEYS.presets, listPresets().filter((p) => p.id !== id));
    },
  };
}
