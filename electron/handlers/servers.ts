import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

export function registerServerHandlers(deps: HandlerDeps) {
  const svc = deps.dedicatedServers;

  ipcMain.handle(IPC.SERVER_LIST, () => {
    const list = svc.list();
    return list.map((s) => ({ ...s, runtime: svc.getState(s.id) }));
  });

  ipcMain.handle(IPC.SERVER_CREATE, async (_e, opts: { name: string; mcVersion: string; flavor: 'vanilla' | 'paper'; port: number; ramMb: number; motd: string; onlineMode: boolean }) => {
    try {
      const server = await svc.create({
        name: String(opts.name || 'My server'),
        mcVersion: String(opts.mcVersion),
        flavor: opts.flavor === 'paper' ? 'paper' : 'vanilla',
        port: Math.max(1024, Math.min(65535, Number(opts.port) || 25565)),
        ramMb: Math.max(512, Math.min(32768, Number(opts.ramMb) || 2048)),
        motd: String(opts.motd || 'SlimeLauncher server').slice(0, 59),
        onlineMode: !!opts.onlineMode,
      });
      return { ok: true, server };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.SERVER_START, (_e, id: string) => svc.start(String(id)));
  ipcMain.handle(IPC.SERVER_STOP, (_e, id: string) => svc.stop(String(id)));
  ipcMain.handle(IPC.SERVER_DELETE, (_e, id: string) => svc.delete(String(id)));
  ipcMain.handle(IPC.SERVER_LOG, (_e, id: string) => svc.getLogTail(String(id)));
  ipcMain.handle(IPC.SERVER_OPEN_FOLDER, (_e, id: string) => { svc.openFolder(String(id)); return { ok: true }; });
}
