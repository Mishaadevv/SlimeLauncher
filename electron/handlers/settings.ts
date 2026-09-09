import { ipcMain, app } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { AppSettings } from '../../shared/types.js';
import { getHardwareInfo } from '../services/hardware.js';

// Keep the OS autostart registration in sync with the startWithWindows setting.
function applyAutoStart(enabled: boolean) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      path: process.execPath,
    });
  }
}

export function registerSettingsHandlers(deps: HandlerDeps) {
  ipcMain.handle(IPC.SETTINGS_GET, () => deps.settingsStore.load());
  ipcMain.handle(IPC.SYSTEM_INFO, () => getHardwareInfo());
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => {
    const merged = deps.settingsStore.set(patch);
    // Sync autostart whenever it changes (and on first load if already enabled)
    if (patch.startWithWindows !== undefined) {
      applyAutoStart(patch.startWithWindows);
    } else if (merged.startWithWindows) {
      applyAutoStart(true);
    }
    // Re-register the recording hotkey when recording settings change
    if (patch.recording !== undefined) {
      deps.recorder.refreshSettings();
    }
    return merged;
  });
}
