import { ipcMain, BrowserWindow, app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

export function registerWindowHandlers(deps: HandlerDeps) {
  let isMaximized = false;

  ipcMain.on(IPC.APP_MINIMIZE, () => deps.getMainWindow()?.minimize());
  ipcMain.on(IPC.APP_MAXIMIZE, () => {
    const win = deps.getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(IPC.APP_CLOSE, () => deps.getMainWindow()?.close());
  ipcMain.on(IPC.APP_RESTART, () => {
    // app.exit() skips before-quit handlers, so stop the recording here —
    // otherwise the ffmpeg process outlived the restart and kept recording.
    try { deps.recorder.dispose(); } catch { /* best effort */ }
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle(IPC.APP_IS_MAXIMIZED, () => deps.getMainWindow()?.isMaximized() ?? false);
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());
  ipcMain.handle(IPC.APP_OPEN_LOGS, () => {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      void shell.openPath(logsDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const updateMaximized = () => {
    const win = deps.getMainWindow();
    if (!win) return;
    const next = win.isMaximized();
    if (next !== isMaximized) {
      isMaximized = next;
      win.webContents.send(IPC.APP_ON_MAXIMIZE_CHANGE, next);
    }
  };

  // Attach listeners to any window created
  const attach = () => {
    const win = deps.getMainWindow();
    if (win) {
      win.on('maximize', updateMaximized);
      win.on('unmaximize', updateMaximized);
      win.on('resize', updateMaximized);
    }
  };
  // Defer slightly so the main window exists
  setTimeout(attach, 500);
  BrowserWindow.getAllWindows().forEach((w) => {
    w.on('maximize', updateMaximized);
    w.on('unmaximize', updateMaximized);
  });
}
