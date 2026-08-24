import { createRequire } from 'node:module';
import type { Database as DB } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { Logger } from './logger.js';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');

// Local SQLite database. Holds accounts, instances, mods, maps, downloads,
// microsoft accounts and settings. All schema migrations run on init.
export class DatabaseService {
  private db!: DB;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  init() {
    const dataDir = path.join(app.getPath('userData'), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'slimelauncher.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.backfillSavedAccounts();
    this.logger.info('Database initialized', { path: dbPath });
  }

  // One-time backfill: every existing offline/Microsoft account becomes a
  // saved account so the multi-account page lists everything the user has.
  // Uses NOT EXISTS on user_id/ms_id (not just the generated id) so a
  // saved account created via Accounts → Add Offline (random id) does not get
  // duplicated as 'u_'||id on the next launch.
  private backfillSavedAccounts() {
    // Ensure uniqueness going forward - prevents duplicates even if backfill
    // runs again after manual DB edits or older versions.
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_accounts_user_id ON saved_accounts(user_id) WHERE user_id IS NOT NULL`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_accounts_ms_id ON saved_accounts(ms_id) WHERE ms_id IS NOT NULL`);
    } catch { /* index creation is best-effort */ }
    // De-duplicate any legacy duplicates left by older code (keep oldest row per user_id/ms_id).
    try {
      this.db.exec(`
        DELETE FROM saved_accounts WHERE id NOT IN (
          SELECT MIN(id) FROM saved_accounts WHERE user_id IS NOT NULL GROUP BY user_id
          UNION ALL
          SELECT MIN(id) FROM saved_accounts WHERE ms_id IS NOT NULL GROUP BY ms_id
          UNION ALL
          SELECT id FROM saved_accounts WHERE user_id IS NULL AND ms_id IS NULL
        );
      `);
    } catch { /* ignore */ }
    this.db.exec(`
      INSERT OR IGNORE INTO saved_accounts (id, kind, nick, user_id, ms_id, created_at)
      SELECT 'u_' || id, 'offline', username, id, NULL, created_at FROM users
      WHERE NOT EXISTS (SELECT 1 FROM saved_accounts WHERE user_id = users.id);
      INSERT OR IGNORE INTO saved_accounts (id, kind, nick, user_id, ms_id, created_at)
      SELECT 'm_' || id, 'microsoft', username, NULL, id, linked_at FROM microsoft_accounts
      WHERE NOT EXISTS (SELECT 1 FROM saved_accounts WHERE ms_id = microsoft_accounts.id);
    `);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        avatar TEXT,
        created_at INTEGER NOT NULL,
        launch_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS microsoft_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        uuid TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER NOT NULL,
        linked_at INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        mc_version TEXT NOT NULL,
        loader TEXT NOT NULL,
        loader_version TEXT,
        java_path TEXT,
        ram_mb INTEGER NOT NULL,
        jvm_args TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_played_at INTEGER,
        play_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS mods (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        slug TEXT,
        name TEXT NOT NULL,
        author TEXT,
        version TEXT,
        file_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS maps (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        name TEXT NOT NULL,
        author TEXT,
        map_type TEXT,
        file_name TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        destination TEXT NOT NULL,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        category TEXT NOT NULL DEFAULT 'minecraft',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS offline_skins (
        username TEXT PRIMARY KEY,
        skin_data TEXT,
        cape_data TEXT,
        variant TEXT NOT NULL DEFAULT 'classic',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friends (
        id TEXT PRIMARY KEY,
        nick TEXT NOT NULL UNIQUE,
        note TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_accounts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        nick TEXT NOT NULL,
        user_id TEXT,
        ms_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_accounts_user_id ON saved_accounts(user_id) WHERE user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_accounts_ms_id ON saved_accounts(ms_id) WHERE ms_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        instance_name TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        fps INTEGER NOT NULL DEFAULT 60,
        quality TEXT NOT NULL DEFAULT 'high',
        resolution TEXT NOT NULL DEFAULT 'window',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS screenshots (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        instance_name TEXT,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS world_backups (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        instance_name TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        world_count INTEGER NOT NULL DEFAULT 0,
        worlds TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dedicated_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mc_version TEXT NOT NULL,
        flavor TEXT NOT NULL DEFAULT 'vanilla',
        port INTEGER NOT NULL DEFAULT 25565,
        ram_mb INTEGER NOT NULL DEFAULT 2048,
        motd TEXT NOT NULL DEFAULT 'SlimeLauncher server',
        online_mode INTEGER NOT NULL DEFAULT 0,
        dir TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Cache for the remote skin directory (third-party servers). Mirrors the
      -- skin/cape blobs keyed by dashless offline UUID. Negative entries (no
      -- skin on the directory) are stored with skin_data IS NULL so repeated
      -- misses don't hit the network.
      CREATE TABLE IF NOT EXISTS remote_skins (
        uuid TEXT PRIMARY KEY,
        nick TEXT NOT NULL,
        skin_data TEXT,
        cape_data TEXT,
        variant TEXT NOT NULL DEFAULT 'classic',
        fetched_at INTEGER NOT NULL
      );
    `);
  }

  isReady(): boolean {
    return !!this.db;
  }

  get raw(): DB {
    return this.db;
  }

  prepare(sql: string) {
    if (!this.db) {
      throw new Error('Database is not initialized. Call db.init() first.');
    }
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
