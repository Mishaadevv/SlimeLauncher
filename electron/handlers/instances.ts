import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { MinecraftInstance, LoaderType } from '../../shared/types.js';

function rowToInstance(r: Record<string, unknown>): MinecraftInstance {
  return {
    id: String(r.id),
    name: String(r.name),
    icon: r.icon ? String(r.icon) : null,
    mcVersion: String(r.mc_version),
    loader: String(r.loader) as LoaderType,
    loaderVersion: r.loader_version ? String(r.loader_version) : null,
    javaPath: r.java_path ? String(r.java_path) : null,
    ramMB: Number(r.ram_mb) || 4096,
    // Legacy rows store NULL here — String(null) would give the literal "null"
    // which then flew into the JVM command line as an argument.
    jvmArgs: r.jvm_args == null ? '' : String(r.jvm_args),
    createdAt: Number(r.created_at),
    lastPlayedAt: r.last_played_at ? Number(r.last_played_at) : null,
    playCount: Number(r.play_count) || 0,
  };
}

export function registerInstanceHandlers(deps: HandlerDeps) {
  const { db, settingsStore, logger } = deps;

  ipcMain.handle(IPC.INSTANCE_LIST, () => {
    const rows = db.prepare('SELECT * FROM instances ORDER BY last_played_at DESC NULLS LAST, created_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToInstance);
  });

  ipcMain.handle(IPC.INSTANCE_GET, (_e, id: string) => {
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToInstance(row) : null;
  });

  ipcMain.handle(IPC.INSTANCE_CREATE, (_e, data: Partial<MinecraftInstance>) => {
    const id = data.id || randomUUID();
    const settings = settingsStore.load();
    const inst: MinecraftInstance = {
      id,
      name: data.name || 'New Instance',
      icon: data.icon ?? null,
      mcVersion: data.mcVersion || '1.20.1',
      loader: data.loader || 'vanilla',
      loaderVersion: data.loaderVersion ?? null,
      javaPath: data.javaPath || settings.defaultJavaPath || null,
      ramMB: data.ramMB || settings.defaultRamMB,
      // `??` (not `||`) so clearing the field to '' actually sticks instead of
      // silently restoring the default.
      jvmArgs: data.jvmArgs ?? settings.jvmArguments,
      createdAt: Date.now(),
      lastPlayedAt: null,
      playCount: 0,
    };
    db.prepare(
      `INSERT INTO instances (id, name, icon, mc_version, loader, loader_version, java_path, ram_mb, jvm_args, created_at, last_played_at, play_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
    ).run(inst.id, inst.name, inst.icon, inst.mcVersion, inst.loader, inst.loaderVersion, inst.javaPath, inst.ramMB, inst.jvmArgs, inst.createdAt);

    // Create the instance folder structure
    const baseDir = path.join(settings.minecraftDirectory, inst.id);
    for (const sub of ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots']) {
      const p = path.join(baseDir, sub);
      fs.mkdirSync(p, { recursive: true });
    }
    logger.info('Instance created', { id, name: inst.name });
    return inst;
  });

  ipcMain.handle(IPC.INSTANCE_UPDATE, (_e, id: string, patch: Partial<MinecraftInstance>) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', icon: 'icon', mcVersion: 'mc_version', loader: 'loader',
      loaderVersion: 'loader_version', javaPath: 'java_path', ramMB: 'ram_mb', jvmArgs: 'jvm_args',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (map[k]) { fields.push(`${map[k]} = ?`); values.push(v); }
    }
    if (fields.length === 0) return db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    values.push(id);
    db.prepare(`UPDATE instances SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToInstance(row);
  });

  ipcMain.handle(IPC.INSTANCE_DELETE, (_e, id: string) => {
    db.prepare('DELETE FROM instances WHERE id = ?').run(id);
    const settings = settingsStore.load();
    const dir = path.join(settings.minecraftDirectory, id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    logger.info('Instance deleted', { id });
    return { ok: true };
  });

  ipcMain.handle(IPC.INSTANCE_DUPLICATE, (_e, id: string) => {
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const newId = randomUUID();
    db.prepare(
      `INSERT INTO instances (id, name, icon, mc_version, loader, loader_version, java_path, ram_mb, jvm_args, created_at, last_played_at, play_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
    ).run(newId, `${String(row.name)} (copy)`, row.icon, row.mc_version, row.loader, row.loader_version, row.java_path, row.ram_mb, row.jvm_args, Date.now());

    // Copy mods folder
    const settings = settingsStore.load();
    const srcDir = path.join(settings.minecraftDirectory, id);
    const dstDir = path.join(settings.minecraftDirectory, newId);
    if (fs.existsSync(srcDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
      for (const sub of ['mods', 'resourcepacks', 'shaderpacks']) {
        const s = path.join(srcDir, sub);
        const d = path.join(dstDir, sub);
        if (fs.existsSync(s)) {
          fs.mkdirSync(d, { recursive: true });
          fs.readdirSync(s).forEach((f) => fs.copyFileSync(path.join(s, f), path.join(d, f)));
        }
      }
    }
    const newRow = db.prepare('SELECT * FROM instances WHERE id = ?').get(newId) as Record<string, unknown> | undefined;
    if (!newRow) return null;
    return rowToInstance(newRow);
  });

  ipcMain.handle(IPC.INSTANCE_OPEN_FOLDER, (_e, id: string) => {
    const settings = settingsStore.load();
    const dir = path.join(settings.minecraftDirectory, id);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  ipcMain.handle(IPC.INSTANCE_INCREMENT_PLAY, (_e, id: string) => {
    db.prepare('UPDATE instances SET play_count = play_count + 1, last_played_at = ? WHERE id = ?').run(Date.now(), id);
    return { ok: true };
  });
}
