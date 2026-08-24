import http from 'node:http';
import https from 'node:https';
import type { DatabaseService } from './database.js';
import type { Logger } from './logger.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export interface DirectorySkin {
  username: string;
  skin: string | null;
  variant: string | null;
  cape: string | null;
}

export class SkinDirectory {
  constructor(
    private db: DatabaseService,
    private logger: Logger,
  ) {}

  private baseUrl(): string {
    try {
      const row = this.db.prepare("SELECT value FROM settings WHERE key = 'skinDirectoryUrl'").get() as { value?: string } | undefined;
      if (!row?.value) return '';
      const url = JSON.parse(row.value) as string;
      return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    } catch {
      return '';
    }
  }

  isEnabled(): boolean {
    return this.baseUrl().length > 0;
  }

  // Publishes the active account's skin/cape to the directory. Fire-and-forget
  // by callers (void publish(...)).
  async publish(nick: string, skinBase64: string | null, variant: string | null, capeBase64: string | null): Promise<void> {
    const base = this.baseUrl();
    if (!base || !nick || !skinBase64) return;
    const url = `${base}/api/skins/${encodeURIComponent(nick)}`;
    const body = JSON.stringify({ skin: skinBase64, variant: variant || 'classic', ...(capeBase64 ? { cape: capeBase64 } : {}) });
    try {
      await this.request(url, { method: 'PUT', body });
    } catch (e) {
      this.logger.debug('Skin directory publish failed', { nick, error: String(e) });
    }
  }

  // Resolves a dashless offline UUID through the remote directory, with a
  // local-fs cache (remote_skins, 24 h TTL) so repeated misses are cheap and
  // offline re-joins still work from cache.
  async lookupByUuid(uuidDashless: string): Promise<DirectorySkin | null> {
    const base = this.baseUrl();
    if (!base || !/^[0-9a-f]{32}$/i.test(uuidDashless)) return null;
    const normalized = uuidDashless.toLowerCase();

    if (this.db.isReady()) {
      try {
        const row = this.db.prepare(
          'SELECT nick, skin_data, cape_data, variant, fetched_at FROM remote_skins WHERE uuid = ?',
        ).get(normalized) as { nick: string; skin_data: string | null; cape_data: string | null; variant: string; fetched_at: number } | undefined;
        if (row) {
          const age = Date.now() - Number(row.fetched_at);
          if (age < CACHE_TTL_MS) {
            if (!row.skin_data) return null; // negative cache
            return { username: row.nick, skin: row.skin_data, variant: row.variant || 'classic', cape: row.cape_data ?? null };
          }
        }
      } catch { /* cache read failed — fall through to network */ }
    }

    const url = `${base}/api/skins/byuuid/${normalized}`;
    type RemoteEntry = { nick?: string; skin?: string; variant?: string; cape?: string | null };
    let data: RemoteEntry | null = null;
    let found = false;
    try {
      const raw = await this.request(url, { method: 'GET' });
      data = JSON.parse(raw) as RemoteEntry;
      found = !!data?.skin;
    } catch (e: unknown) {
      const msg = String(e);
      if (!msg.includes('HTTP 404')) {
        this.logger.debug('Skin directory lookup failed', { uuid: normalized, error: msg });
      }
    }

    // Persist positive or negative result so we don't hammer the server.
    if (this.db.isReady()) {
      try {
        const fetched = Date.now();
        if (found && data) {
          this.db.prepare(
            'INSERT INTO remote_skins (uuid, nick, skin_data, cape_data, variant, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET nick = excluded.nick, skin_data = excluded.skin_data, cape_data = excluded.cape_data, variant = excluded.variant, fetched_at = excluded.fetched_at',
          ).run(normalized, String(data.nick || ''), data.skin || null, data.cape ?? null, data.variant || 'classic', fetched);
        } else {
          this.db.prepare(
            'INSERT INTO remote_skins (uuid, nick, skin_data, cape_data, variant, fetched_at) VALUES (?, ?, NULL, NULL, ?, ?) ON CONFLICT(uuid) DO UPDATE SET nick = excluded.nick, fetched_at = excluded.fetched_at',
          ).run(normalized, '', 'classic', fetched);
        }
      } catch { /* cache write failed */ }
    }

    if (!found || !data?.skin) return null;
    return { username: String(data.nick || ''), skin: String(data.skin), variant: data.variant || 'classic', cape: data.cape ?? null };
  }

  // Generic HTTP(S) helper with timeout and proper draining. PUT body is JSON.
  private request(urlStr: string, opts: { method: string; body?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(
        {
          method: opts.method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers: opts.body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(opts.body), 'User-Agent': 'SlimeLauncher/1.0.0' }
            : { 'User-Agent': 'SlimeLauncher/1.0.0' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode === 200) resolve(data);
            else reject(new Error(`HTTP ${res.statusCode}`));
          });
        },
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }
}
