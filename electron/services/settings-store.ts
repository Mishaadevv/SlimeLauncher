import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types.js';
import type { DatabaseService } from './database.js';

// Settings persisted in the SQLite `settings` table as key/value JSON.
// Falls back to DEFAULT_SETTINGS for any missing key.
export class SettingsStore {
  private db: DatabaseService;
  private cache: AppSettings = { ...DEFAULT_SETTINGS };

  constructor(db: DatabaseService) {
    this.db = db;
  }

  load(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const merged = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        (merged as Record<string, unknown>)[row.key] = JSON.parse(row.value);
      } catch {
        // ignore malformed
      }
    }
    // Resolve dynamic defaults that depend on the environment
    if (!merged.minecraftDirectory) {
      merged.minecraftDirectory = this.defaultMcDir();
    }
    if (!merged.downloadLocation) {
      merged.downloadLocation = this.defaultDownloadsDir();
    }
    // Always merge recording defaults so newly added fields (e.g. a second
    // hotkey) appear for installs that stored an older recording object.
    merged.recording = { ...DEFAULT_SETTINGS.recording, ...merged.recording };
    if (!merged.recording.folder) {
      merged.recording.folder = this.defaultRecordingsDir();
    }
    // Migrate old tiny Xmn128M default to new larger one for modded 1.16.5+ worlds
    // (prevents sound pool 247 + light engine NPE after 30 min on heavy modpacks).
    if (merged.jvmArguments === '-Xmn128M -XX:+UseG1GC -XX:+UnlockExperimentalVMOptions') {
      merged.jvmArguments = DEFAULT_SETTINGS.jvmArguments;
      // persist migrated value so next load is already correct
      try {
        this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jvmArguments', JSON.stringify(merged.jvmArguments));
      } catch { /* best effort */ }
    }
    this.cache = merged;
    return merged;
  }

  get(): AppSettings {
    return this.cache;
  }

  get raw() {
    return this.db;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.cache, ...patch };
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        upsert.run(key, JSON.stringify(value));
      }
    });
    this.cache = next;
    return next;
  }

  private defaultMcDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return process.platform === 'win32'
      ? `${home}\\.slimelauncher\\minecraft`
      : `${home}/.slimelauncher/minecraft`;
  }

  private defaultDownloadsDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return process.platform === 'win32'
      ? `${home}\\.slimelauncher\\downloads`
      : `${home}/.slimelauncher/downloads`;
  }

  private defaultRecordingsDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return process.platform === 'win32'
      ? `${home}\\.slimelauncher\\recordings`
      : `${home}/.slimelauncher/recordings`;
  }
}
