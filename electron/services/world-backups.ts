import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, shell } from 'electron';
import type { DatabaseService } from './database.js';
import type { SettingsStore } from './settings-store.js';
import type { Logger } from './logger.js';
import type { WorldBackup } from '../../shared/types.js';

export class WorldBackupsService {
  constructor(
    private db: DatabaseService,
    private settings: SettingsStore,
    private logger: Logger,
  ) {}

  private getFolder(): string {
    const custom = this.settings.get().worldBackupsFolder?.trim();
    if (custom) return custom;
    return path.join(app.getPath('userData'), 'world-backups');
  }

  private getKeep(): number {
    const n = Number(this.settings.get().worldBackupsKeep) || 5;
    return Math.max(1, Math.min(50, n));
  }

  isEnabled(): boolean {
    return !!this.settings.get().worldBackupsEnabled;
  }

  async createForInstance(instanceId: string, instanceName: string, instanceDir: string): Promise<WorldBackup | null> {
    if (!this.isEnabled()) return null;
    const savesDir = path.join(instanceDir, 'saves');
    if (!fs.existsSync(savesDir)) return null;
    let worlds: string[] = [];
    try {
      worlds = fs.readdirSync(savesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return null;
    }
    if (worlds.length === 0) return null;

    // Skip if no world folder was modified since last backup (avoid spamming on quick restarts).
    try {
      const last = this.db.prepare('SELECT created_at FROM world_backups WHERE instance_id = ? ORDER BY created_at DESC LIMIT 1').get(instanceId) as { created_at?: number } | undefined;
      if (last?.created_at) {
        let newestMtime = 0;
        for (const w of worlds) {
          try {
            const st = fs.statSync(path.join(savesDir, w));
            newestMtime = Math.max(newestMtime, st.mtimeMs);
          } catch {}
        }
        if (newestMtime > 0 && newestMtime < last.created_at) return null;
      }
    } catch {}

    const folder = path.join(this.getFolder(), instanceId);
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fileName = `${instanceName.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.zip`;
    const filePath = path.join(folder, fileName);

    try {
      await this.zipFolder(savesDir, filePath, worlds);
    } catch (e) {
      this.logger.warn('World backup failed', { instanceId, error: String(e) });
      try { fs.unlinkSync(filePath); } catch {}
      return null;
    }

    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}

    const id = randomUUID();
    const now = Date.now();
    try {
      this.db.prepare(
        'INSERT INTO world_backups (id, instance_id, instance_name, file_name, file_path, size_bytes, world_count, worlds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, instanceId, instanceName, fileName, filePath, size, worlds.length, JSON.stringify(worlds), now);
    } catch (e) {
      this.logger.warn('Failed to record world backup', { error: String(e) });
    }

    // Prune old backups for this instance.
    try {
      const keep = this.getKeep();
      const rows = this.db.prepare('SELECT id, file_path FROM world_backups WHERE instance_id = ? ORDER BY created_at DESC').all(instanceId) as { id: string; file_path: string }[];
      for (const r of rows.slice(keep)) {
        try { fs.unlinkSync(r.file_path); } catch {}
        try { this.db.prepare('DELETE FROM world_backups WHERE id = ?').run(r.id); } catch {}
      }
    } catch {}

    this.logger.info('World backup created', { instanceId, fileName, size, worlds: worlds.length });
    return { id, instanceId, instanceName, fileName, filePath, sizeBytes: size, worldCount: worlds.length, worlds, createdAt: now };
  }

  list(instanceId?: string): WorldBackup[] {
    try {
      const rows = instanceId
        ? (this.db.prepare('SELECT * FROM world_backups WHERE instance_id = ? ORDER BY created_at DESC').all(instanceId) as Record<string, unknown>[])
        : (this.db.prepare('SELECT * FROM world_backups ORDER BY created_at DESC').all() as Record<string, unknown>[]);
      const out: WorldBackup[] = [];
      for (const r of rows) {
        const filePath = String(r.file_path);
        if (!fs.existsSync(filePath)) {
          try { this.db.prepare('DELETE FROM world_backups WHERE id = ?').run(r.id); } catch {}
          continue;
        }
        out.push({
          id: String(r.id),
          instanceId: String(r.instance_id),
          instanceName: String(r.instance_name),
          fileName: String(r.file_name),
          filePath,
          sizeBytes: Number(r.size_bytes) || 0,
          worldCount: Number(r.world_count) || 0,
          worlds: (() => { try { return JSON.parse(String(r.worlds || '[]')); } catch { return []; } })(),
          createdAt: Number(r.created_at),
        });
      }
      return out;
    } catch (e) {
      this.logger.warn('Failed to list world backups', { error: String(e) });
      return [];
    }
  }

  delete(id: string): boolean {
    try {
      const row = this.db.prepare('SELECT file_path FROM world_backups WHERE id = ?').get(id) as { file_path?: string } | undefined;
      if (row?.file_path) try { fs.unlinkSync(row.file_path); } catch {}
      this.db.prepare('DELETE FROM world_backups WHERE id = ?').run(id);
      return true;
    } catch (e) {
      this.logger.warn('Failed to delete world backup', { id, error: String(e) });
      return false;
    }
  }

  async restore(id: string, instanceDir: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.db.prepare('SELECT file_path FROM world_backups WHERE id = ?').get(id) as { file_path?: string } | undefined;
    if (!row?.file_path || !fs.existsSync(row.file_path)) return { ok: false, error: 'Backup file not found.' };
    const savesDir = path.join(instanceDir, 'saves');
    fs.mkdirSync(savesDir, { recursive: true });
    try {
      await this.unzipTo(row.file_path, savesDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  openFolder(instanceId?: string) {
    const base = this.getFolder();
    const folder = instanceId ? path.join(base, instanceId) : base;
    fs.mkdirSync(folder, { recursive: true });
    void shell.openPath(folder);
  }

  private async zipFolder(savesDir: string, destZip: string, worlds: string[]): Promise<void> {
    // Use archiver if available, otherwise fall back to PowerShell Compress-Archive (Windows) or zip (unix).
    try {
      const { ZipArchive } = await import('archiver');
      const output = fs.createWriteStream(destZip);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const archive = new (ZipArchive as unknown as new (opts?: unknown) => any)({ zlib: { level: 6 } });
      return await new Promise((resolve, reject) => {
        output.on('close', () => resolve());
        archive.on('error', reject);
        archive.pipe(output);
        for (const w of worlds) {
          archive.directory(path.join(savesDir, w), w);
        }
        void archive.finalize();
      });
    } catch {
      // Fallback: PowerShell on Windows, zip on unix.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      if (process.platform === 'win32') {
        const worldsArg = worlds.map((w) => `'${path.join(savesDir, w).replace(/'/g, "''")}'`).join(',');
        const ps = `Compress-Archive -Path @(${worldsArg}) -DestinationPath '${destZip.replace(/'/g, "''")}' -Force`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 120000, windowsHide: true });
      } else {
        await execFileAsync('zip', ['-r', destZip, ...worlds], { cwd: savesDir, timeout: 120000 });
      }
    }
  }

  private async unzipTo(zipPath: string, destDir: string): Promise<void> {
    try {
      const yauzl = await import('yauzl');
      // yauzl is callback-based; use it if available.
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yauzl as unknown as { open: (p: string, o: unknown, cb: (e: unknown, z: unknown) => void) => void }).open(zipPath, { lazyEntries: true }, (err: unknown, zip: unknown) => {
          if (err || !zip) return reject(err);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const z = zip as any;
          z.readEntry();
          z.on('entry', (entry: { fileName: string; isDirectory?: () => boolean }) => {
            const full = path.join(destDir, entry.fileName);
            if (entry.fileName.endsWith('/')) {
              fs.mkdirSync(full, { recursive: true });
              z.readEntry();
            } else {
              fs.mkdirSync(path.dirname(full), { recursive: true });
              z.openReadStream(entry, (e: unknown, s: unknown) => {
                if (e || !s) return reject(e);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rs = s as any;
                const ws = fs.createWriteStream(full);
                rs.pipe(ws);
                ws.on('close', () => z.readEntry());
                ws.on('error', reject);
              });
            }
          });
          z.on('end', () => resolve());
          z.on('error', reject);
        });
      });
      return;
    } catch {
      // Fallback
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      if (process.platform === 'win32') {
        const ps = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 120000, windowsHide: true });
      } else {
        await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120000 });
      }
    }
  }
}
