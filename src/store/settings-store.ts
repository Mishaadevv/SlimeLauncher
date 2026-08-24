import { create } from 'zustand';
import type { AppSettings } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  languageKey: number;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  languageKey: 0,
  load: async () => {
    if (!window.slime?.settings) return;
    try {
      const settings = await window.slime.settings.get();
      if (settings) set({ settings, loaded: true });
    } catch { /* ignore */ }
  },
  update: async (patch) => {
    if (!window.slime?.settings) return;
    try {
      const next = await window.slime.settings.set(patch);
      if (next) {
        const inc = patch.language !== undefined ? 1 : 0;
        set((s) => ({ settings: next, languageKey: s.languageKey + inc }));
      }
    } catch { /* ignore */ }
  },
}));
