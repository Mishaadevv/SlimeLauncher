import { ipcMain } from 'electron';
import path from 'node:path';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

export function registerWorldBackupsHandlers(deps: HandlerDeps) {
  const { db, settingsStore, worldBackups } = deps;

  ipcMain.handle(IPC.WORLD_BACKUPS_LIST, (_e, instanceId?: string) => {
    return worldBackups.list(instanceId);
  });

  ipcMain.handle(IPC.WORLD_BACKUPS_CREATE, async (_e, instanceId: string) => {
    const inst = db.prepare('SELECT id, name FROM instances WHERE id = ?').get(instanceId) as { id: string; name: string } | undefined;
    if (!inst) return { ok: false, error: 'Instance not found.' };
    const settings = settingsStore.load();
    const instDir = path.join(settings.minecraftDirectory, instanceId);
    const backup = await worldBackups.createForInstance(instanceId, String(inst.name), instDir);
    if (!backup) return { ok: false, error: 'No worlds to backup or backup disabled.' };
    return { ok: true, backup };
  });

  ipcMain.handle(IPC.WORLD_BACKUPS_DELETE, (_e, id: string) => {
    const ok = worldBackups.delete(String(id));
    return { ok };
  });

  ipcMain.handle(IPC.WORLD_BACKUPS_RESTORE, async (_e, id: string, instanceId: string) => {
    const settings = settingsStore.load();
    const instDir = path.join(settings.minecraftDirectory, String(instanceId));
    const res = await worldBackups.restore(String(id), instDir);
    return res;
  });

  ipcMain.handle(IPC.WORLD_BACKUPS_OPEN_FOLDER, (_e, instanceId?: string) => {
    worldBackups.openFolder(instanceId ? String(instanceId) : undefined);
    return { ok: true };
  });
}
