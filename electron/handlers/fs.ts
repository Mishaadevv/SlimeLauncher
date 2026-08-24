import { ipcMain, dialog } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

export function registerFsHandlers(_deps: HandlerDeps) {
  ipcMain.handle(IPC.FS_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.FS_SELECT_FILE, async (_e, filters: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Select a file',
      filters: filters || undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
