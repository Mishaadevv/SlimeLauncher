import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

export function registerDownloadHandlers(deps: HandlerDeps) {
  const { downloadManager } = deps;

  ipcMain.handle(IPC.DL_LIST, () => downloadManager.list());
  ipcMain.handle(IPC.DL_PAUSE, (_e, id: string) => { downloadManager.pause(id); return { ok: true }; });
  ipcMain.handle(IPC.DL_RESUME, (_e, id: string) => { downloadManager.resume(id); return { ok: true }; });
  ipcMain.handle(IPC.DL_CANCEL, (_e, id: string) => { downloadManager.cancel(id); return { ok: true }; });
  ipcMain.handle(IPC.DL_RETRY, (_e, id: string) => { downloadManager.retry(id); return { ok: true }; });
  ipcMain.handle(IPC.DL_CLEAR_COMPLETED, () => { downloadManager.clearCompleted(); return { ok: true }; });
}
