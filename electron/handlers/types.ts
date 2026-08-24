import type { DatabaseService } from '../services/database.js';
import type { SettingsStore } from '../services/settings-store.js';
import type { DownloadManager } from '../services/download-manager.js';
import type { SkinServer } from '../services/skin-server.js';
import type { SkinDirectory } from '../services/skin-directory.js';
import type { PresenceService } from '../services/presence.js';
import type { RecorderService } from '../services/recorder.js';
import type { WorldBackupsService } from '../services/world-backups.js';
import type { DedicatedServerService } from '../services/dedicated-server.js';
import type { Logger } from '../services/logger.js';
import type { BrowserWindow } from 'electron';

export interface HandlerDeps {
  db: DatabaseService;
  settingsStore: SettingsStore;
  downloadManager: DownloadManager;
  skinServer: SkinServer;
  skinDirectory: SkinDirectory;
  presence: PresenceService;
  recorder: RecorderService;
  worldBackups: WorldBackupsService;
  dedicatedServers: DedicatedServerService;
  logger: Logger;
  getMainWindow: () => BrowserWindow | null;
}

export function notify(deps: HandlerDeps, n: { type: 'success' | 'error' | 'info' | 'warning'; title: string; message: string; duration?: number }) {
  const win = deps.getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('notify', {
      id: Math.random().toString(36).slice(2),
      type: n.type,
      title: n.title,
      message: n.message,
      duration: n.duration ?? 4000,
      createdAt: Date.now(),
    });
  }
}
