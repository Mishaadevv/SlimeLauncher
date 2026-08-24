import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';
import type { SettingsStore } from './settings-store.js';
import type { DownloadTask } from '../../shared/types.js';
import { IPC } from '../../shared/ipc.js';
import { BrowserWindow } from 'electron';

// Concurrent download manager with pause/resume/cancel, progress reporting
// and speed calculation. Downloads are persisted in the DB so they survive
// restarts. Uses HTTP range requests for resume support.
export class DownloadManager {
  private logger: Logger;
  private settings: SettingsStore;
  private active = new Map<string, { req?: http.ClientRequest; aborted: boolean; paused: boolean; lastBytes: number; lastTime: number }>();
  private listeners: Array<(tasks: DownloadTask[]) => void> = [];
  private progressTimer: NodeJS.Timeout | null = null;

  constructor(settings: SettingsStore, logger: Logger) {
    this.settings = settings;
    this.logger = logger;
  }

  startProgressTimer() {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => this.broadcast(), 500);
  }

  stopProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  // Resumes downloads that were interrupted by a restart (status 'downloading'
  // or 'queued' persisted in the DB). Paused tasks stay paused. Without this,
  // a task interrupted by an app quit would sit in 'downloading' forever.
  resumePending() {
    if (!this.settings.raw.isReady()) return;
    try {
      const rows = this.settings.raw.prepare("SELECT id FROM downloads WHERE status IN ('downloading', 'queued')").all() as Record<string, unknown>[];
      for (const r of rows) this.start(String(r.id));
    } catch { /* ignore db errors during shutdown */ }
  }

  subscribe(fn: (tasks: DownloadTask[]) => void) {
    this.listeners.push(fn);
  }

  private broadcast() {
    if (!this.settings.raw.isReady()) return;
    try {
      const tasks = this.list();
      for (const fn of this.listeners) fn(tasks);
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send(IPC.DL_PROGRESS, tasks);
        }
      }
    } catch {
      // ignore broadcast errors when db shutting down
    }
  }

  private rowToTask(r: Record<string, unknown>): DownloadTask {
    return {
      id: String(r.id),
      name: String(r.name),
      url: String(r.url),
      destination: String(r.destination),
      totalBytes: Number(r.total_bytes) || 0,
      downloadedBytes: Number(r.downloaded_bytes) || 0,
      speed: 0,
      status: r.status as DownloadTask['status'],
      error: r.error ? String(r.error) : null,
      category: r.category as DownloadTask['category'],
      createdAt: Number(r.created_at),
    };
  }

  list(): DownloadTask[] {
    if (!this.settings.raw.isReady()) return [];
    try {
      const rows = this.settings.raw.prepare('SELECT * FROM downloads ORDER BY created_at DESC').all() as Record<string, unknown>[];
      const tasks = rows.map((r) => this.rowToTask(r));
      // attach live speed
      for (const t of tasks) {
        const live = this.active.get(t.id);
        if (live && t.status === 'downloading') {
          t.speed = this.computeSpeed(t.id, t.downloadedBytes);
        } else {
          t.speed = 0;
        }
      }
      return tasks;
    } catch {
      return [];
    }
  }

  private computeSpeed(id: string, currentBytes: number): number {
    const live = this.active.get(id);
    if (!live) return 0;
    const now = Date.now();
    const dt = (now - live.lastTime) / 1000;
    if (dt <= 0) return 0;
    const speed = (currentBytes - live.lastBytes) / dt;
    live.lastBytes = currentBytes;
    live.lastTime = now;
    return Math.max(0, speed);
  }

  enqueue(name: string, url: string, destination: string, category: DownloadTask['category']): string {
    const id = randomUUID();
    this.settings.raw.prepare(
      'INSERT INTO downloads (id, name, url, destination, total_bytes, downloaded_bytes, status, category, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)'
    ).run(id, name, url, destination, 'queued', category, Date.now());
    this.logger.info('Download enqueued', { id, name, url });
    this.start(id);
    return id;
  }

  private start(id: string) {
    if (this.active.has(id)) return;
    const row = this.settings.raw.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return;
    const url = String(row.url);
    const dest = String(row.destination);

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Resume from the ACTUAL file size on disk, not the DB counter: writes are
    // buffered asynchronously, so `downloaded_bytes` can be ahead of what ever
    // reached the disk — resuming past the real EOF would create a hole and
    // corrupt the file.
    let existing = 0;
    try {
      existing = fs.statSync(dest).size;
    } catch { /* no file yet */ }
    if (existing > 0) {
      this.settings.raw.prepare('UPDATE downloads SET downloaded_bytes = ? WHERE id = ?').run(existing, id);
    }

    const state: { req?: http.ClientRequest; aborted: boolean; paused: boolean; lastBytes: number; lastTime: number } = { aborted: false, paused: false, lastBytes: existing, lastTime: Date.now() };
    this.active.set(id, state);

    this.setStatus(id, 'downloading');
    this.doRequest(id, url, dest, existing, 0);
  }

  // Follows redirects inline (edge.forgecdn.net -> mediafilez.forgecdn.net etc.)
  // instead of re-entering start(), which used to bail out because the task was
  // already in `active` — leaving the download stuck at 'downloading' forever
  // with no file ever written.
  private doRequest(id: string, url: string, dest: string, existing: number, redirects: number) {
    const state = this.active.get(id);
    if (!state || state.aborted) return;

    const client = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = {};
    if (existing > 0) headers['Range'] = `bytes=${existing}-`;

    // Inactivity watchdog — a stalled server must never leave the task in
    // 'downloading' forever. Destroying the request routes into fail().
    let timer: NodeJS.Timeout | null = null;
    const INACTIVITY_MS = 60000;
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        state.req?.destroy(new Error(`stalled: no data for ${INACTIVITY_MS / 1000}s`));
      }, INACTIVITY_MS);
    };
    const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
    armTimer();

    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume(); // drain the redirect body
        const loc = res.headers.location;
        if (!loc) {
          disarm();
          this.fail(id, `Redirect without location (HTTP ${res.statusCode})`);
          return;
        }
        if (redirects >= 5) {
          disarm();
          this.fail(id, 'Too many redirects');
          return;
        }
        const next = new URL(loc, url).toString();
        this.settings.raw.prepare('UPDATE downloads SET url = ? WHERE id = ?').run(next, id);
        // Disarm THIS attempt's watchdog before recursing — the timer closes
        // over shared task state and would otherwise destroy the redirected
        // request mid-flight.
        disarm();
        this.doRequest(id, next, dest, existing, redirects + 1);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        disarm();
        res.resume();
        this.fail(id, `HTTP ${res.statusCode}`);
        return;
      }

      // A server that ignores the Range header answers 200 with the FULL body;
      // a 206 whose start differs from our file is equally unusable. Appending
      // either to the partial file would corrupt it — restart from scratch.
      let offset = 0;
      if (existing > 0 && res.statusCode === 206) {
        const m = /bytes (\d+)-/.exec(String(res.headers['content-range'] || ''));
        if (m && parseInt(m[1], 10) === existing) offset = existing;
      }
      if (offset !== existing) {
        try { fs.truncateSync(dest, 0); } catch { /* ignore */ }
        this.settings.raw.prepare('UPDATE downloads SET downloaded_bytes = 0 WHERE id = ?').run(id);
      }

      const totalHeader = res.headers['content-range']
        ? parseInt(res.headers['content-range'].split('/')[1], 10)
        : parseInt(res.headers['content-length'] || '0', 10);

      if (totalHeader) {
        this.settings.raw.prepare('UPDATE downloads SET total_bytes = ? WHERE id = ?').run(totalHeader, id);
      }

      const out = fs.createWriteStream(dest, { flags: offset > 0 ? 'a' : 'w' });
      let received = offset;
      // One synchronous SQLite UPDATE per network chunk hammered the database
      // thousands of times per second on fast connections — persist at most
      // every 256 KB instead.
      let persisted = offset;
      const persist = () => {
        if (received === persisted) return;
        persisted = received;
        try {
          this.settings.raw.prepare('UPDATE downloads SET downloaded_bytes = ? WHERE id = ?').run(received, id);
        } catch { /* db shutting down */ }
      };

      armTimer();
      res.on('data', (chunk: Buffer) => {
        if (state.paused) {
          disarm();
          persist();
          res.destroy();
          out.end();
          return;
        }
        if (state.aborted) {
          disarm();
          res.destroy();
          out.end();
          try { fs.unlinkSync(dest); } catch { /* ignore */ }
          return;
        }
        armTimer();
        received += chunk.length;
        out.write(chunk);
        if (received - persisted >= 262144) persist();
      });

      res.on('end', () => {
        persist();
        out.end(() => {
          disarm();
          if (!state.aborted && !state.paused) {
            this.setStatus(id, 'completed');
            this.active.delete(id);
            this.logger.info('Download completed', { id });
          }
        });
      });

      // A dropped connection mid-body must not be mistaken for success.
      res.on('aborted', () => {
        disarm();
        if (state.paused || state.aborted) return;
        persist();
        out.end();
        this.fail(id, 'Connection aborted by the server');
      });

      res.on('error', (err) => {
        disarm();
        persist();
        out.end();
        this.fail(id, err.message);
      });
    });

    req.on('error', (err) => this.fail(id, err.message));
    // Fires on every terminal path (normal end, abort, destroy) — make sure
    // no watchdog survives the request.
    req.on('close', () => disarm());
    state.req = req;
  }

  private fail(id: string, error: string) {
    // pause()/cancel() destroy the request on purpose — their status was
    // already set and must not be overwritten with an error.
    const live = this.active.get(id);
    if (live && (live.paused || live.aborted)) return;
    try {
      this.settings.raw.prepare('UPDATE downloads SET status = ?, error = ? WHERE id = ?').run('error', error, id);
    } catch { /* db shutting down */ }
    this.active.delete(id);
    this.logger.error('Download failed', { id, error });
  }

  private setStatus(id: string, status: DownloadTask['status']) {
    this.settings.raw.prepare('UPDATE downloads SET status = ? WHERE id = ?').run(status, id);
  }

  pause(id: string) {
    const live = this.active.get(id);
    if (live) {
      live.paused = true;
      live.req?.destroy();
    }
    this.setStatus(id, 'paused');
  }

  resume(id: string) {
    this.setStatus(id, 'queued');
    this.start(id);
  }

  cancel(id: string) {
    const live = this.active.get(id);
    if (live) {
      live.aborted = true;
      live.req?.destroy();
    }
    this.setStatus(id, 'cancelled');
    this.active.delete(id);
  }

  retry(id: string) {
    // Retry means start over: drop the partial file so the disk size and the
    // reset DB counter agree (start() resumes from the file on disk).
    const row = this.settings.raw.prepare('SELECT destination FROM downloads WHERE id = ?').get(id) as { destination?: string } | undefined;
    if (row?.destination) {
      try { fs.unlinkSync(row.destination); } catch { /* ignore */ }
    }
    this.settings.raw.prepare('UPDATE downloads SET downloaded_bytes = 0, error = NULL WHERE id = ?').run(id);
    this.setStatus(id, 'queued');
    this.start(id);
  }

  clearCompleted() {
    this.settings.raw.prepare("DELETE FROM downloads WHERE status = 'completed'").run();
  }
}
