import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { app, shell, BrowserWindow } from 'electron';
import type { DatabaseService } from './database.js';
import type { SettingsStore } from './settings-store.js';
import type { Logger } from './logger.js';
import type { DedicatedServer, DedicatedServerState } from '../../shared/types.js';
import { IPC } from '../../shared/ipc.js';
import { findIgd, upnpAddPortMapping, upnpDeletePortMapping } from './nat.js';
import { detectJava } from '../handlers/minecraft.js';

const MC_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const LOG_MAX = 500;

interface RunningServer {
  proc: ChildProcess | null;
  state: DedicatedServerState;
  error: string | null;
  log: string[];
  igd: { controlUrl: string } | null;
  mappedPort: number | null;
}

function fetchJson(url: string, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    let timer: NodeJS.Timeout | null = null;
    let currentReq: http.ClientRequest | null = null;
    const arm = (r?: http.IncomingMessage) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { r?.destroy(); currentReq?.destroy(new Error('download timeout')); }, 120000);
    };
    const doReq = (reqUrl: string) => {
      const req = client.get(reqUrl, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doReq(res.headers.location);
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const out = fs.createWriteStream(dest);
        res.on('data', () => arm(res));
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
      currentReq = req;
      req.on('error', reject);
      req.on('close', () => { if (timer) clearTimeout(timer); });
      arm();
    };
    doReq(url);
  });
}

export class DedicatedServerService {
  private running = new Map<string, RunningServer>();

  constructor(
    private db: DatabaseService,
    private settings: SettingsStore,
    private logger: Logger,
  ) {}

  private emit(id: string, state: DedicatedServerState, error?: string | null) {
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.SERVER_STATUS_EVENT, { id, state, error: error ?? null });
      }
    } catch { /* ignore */ }
  }

  list(): DedicatedServer[] {
    try {
      const rows = this.db.prepare('SELECT * FROM dedicated_servers ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        mcVersion: String(r.mc_version),
        flavor: (String(r.flavor) === 'paper' ? 'paper' : 'vanilla') as 'vanilla' | 'paper',
        port: Number(r.port) || 25565,
        ramMb: Number(r.ram_mb) || 2048,
        motd: String(r.motd || ''),
        onlineMode: !!Number(r.online_mode),
        dir: String(r.dir),
        createdAt: Number(r.created_at),
      }));
    } catch {
      return [];
    }
  }

  getState(id: string): { state: DedicatedServerState; error: string | null; logTail: string[] } {
    const r = this.running.get(id);
    if (!r) return { state: 'stopped', error: null, logTail: [] };
    return { state: r.state, error: r.error, logTail: r.log.slice(-40) };
  }

  getLogTail(id: string): string[] {
    return this.running.get(id)?.log.slice(-100) || [];
  }

  async create(opts: { name: string; mcVersion: string; flavor: 'vanilla' | 'paper'; port: number; ramMb: number; motd: string; onlineMode: boolean }): Promise<DedicatedServer> {
    const id = randomUUID();
    const dir = path.join(app.getPath('userData'), 'servers', id);
    fs.mkdirSync(dir, { recursive: true });

    // eula.txt — accepted by the user clicking "Create server".
    fs.writeFileSync(path.join(dir, 'eula.txt'), '# Accepted via SlimeLauncher\neula=true\n', 'utf8');
    const props = [
      `server-port=${opts.port}`,
      `motd=${opts.motd.replace(/\n/g, ' ')}`,
      `online-mode=${opts.onlineMode ? 'true' : 'false'}`,
      'view-distance=8',
      'max-players=10',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'server.properties'), props + '\n', 'utf8');

    const jarPath = path.join(dir, opts.flavor === 'paper' ? 'paper.jar' : 'server.jar');
    if (opts.flavor === 'paper') {
      const builds = (await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(opts.mcVersion)}/builds`)) as {
        builds?: Array<{ build: number; downloads: { application: { name: string } } }>;
      };
      const latest = builds.builds?.[builds.builds.length - 1];
      if (!latest) throw new Error(`No Paper build for ${opts.mcVersion}.`);
      const url = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(opts.mcVersion)}/builds/${latest.build}/downloads/${latest.downloads.application.name}`;
      await downloadFile(url, jarPath);
    } else {
      const manifest = (await fetchJson(MC_MANIFEST)) as { versions: { id: string; url: string }[] };
      const meta = manifest.versions.find((v) => v.id === opts.mcVersion);
      if (!meta) throw new Error(`Minecraft ${opts.mcVersion} not found.`);
      const versionData = (await fetchJson(meta.url)) as { downloads?: { server?: { url?: string } } };
      const url = versionData.downloads?.server?.url;
      if (!url) throw new Error('No server download for this version.');
      await downloadFile(url, jarPath);
    }

    const server: DedicatedServer = {
      id,
      name: opts.name,
      mcVersion: opts.mcVersion,
      flavor: opts.flavor,
      port: opts.port,
      ramMb: opts.ramMb,
      motd: opts.motd,
      onlineMode: opts.onlineMode,
      dir,
      createdAt: Date.now(),
    };
    this.db.prepare(
      'INSERT INTO dedicated_servers (id, name, mc_version, flavor, port, ram_mb, motd, online_mode, dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(server.id, server.name, server.mcVersion, server.flavor, server.port, server.ramMb, server.motd, server.onlineMode ? 1 : 0, server.dir, server.createdAt);
    this.logger.info('Dedicated server created', { id, name: opts.name, version: opts.mcVersion, flavor: opts.flavor });
    return server;
  }

  delete(id: string): { ok: boolean; error?: string } {
    const s = this.list().find((x) => x.id === id);
    if (!s) return { ok: false, error: 'Not found.' };
    const st = this.running.get(id);
    if (st?.state === 'running' || st?.state === 'starting') return { ok: false, error: 'Stop the server first.' };
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    this.db.prepare('DELETE FROM dedicated_servers WHERE id = ?').run(id);
    return { ok: true };
  }

  openFolder(id: string) {
    const s = this.list().find((x) => x.id === id);
    if (!s) return;
    try { fs.mkdirSync(s.dir, { recursive: true }); } catch {}
    void shell.openPath(s.dir);
  }

  // Picks a Java runtime able to run the given MC major version (reuses the
  // launcher's own detection: installed runtimes, common dirs, PATH).
  private async resolveJava(mcVersion: string): Promise<string | null> {
    const clean = mcVersion.replace(/[^0-9.]/g, '');
    const parts = clean.split('.').map(Number);
    const major = parts[0] ?? 1;
    const minor = parts[1] ?? 0;
    let min = 8;
    if (major >= 26 || major >= 2 || (major === 1 && minor >= 21)) min = 21;
    else if (major === 1 && minor >= 18) min = 17;
    return detectJava(min);
  }

  async start(id: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.list().find((x) => x.id === id);
    if (!s) return { ok: false, error: 'Not found.' };
    const existing = this.running.get(id);
    if (existing && (existing.state === 'running' || existing.state === 'starting')) return { ok: true };

    const java = await this.resolveJava(s.mcVersion);
    if (!java) return { ok: false, error: 'Java not found. Set it in Settings → Minecraft → Default Java.' };

    const portFree = await this.isPortFree(s.port);
    if (!portFree) return { ok: false, error: `Port ${s.port} is already in use.` };

    const st: RunningServer = { proc: null, state: 'starting', error: null, log: [], igd: null, mappedPort: null };
    this.running.set(id, st);
    this.emit(id, 'starting');

    const args = [
      `-Xmx${s.ramMb}M`, '-Xms512M',
      '-XX:+UseG1GC',
      '-jar', s.flavor === 'paper' ? 'paper.jar' : 'server.jar',
      'nogui',
    ];

    try {
      const proc = spawn(java, args, { cwd: s.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      st.proc = proc;

      let pending = '';
      const onChunk = (chunk: Buffer) => {
        pending += chunk.toString('utf-8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trimEnd();
          if (!line) continue;
          st.log.push(line);
          if (st.log.length > LOG_MAX) st.log.shift();
          // "Done (12.3s)! For help, type help" — the vanilla/Paper ready line.
          if (/Done \(/i.test(line) && st.state !== 'running') {
            st.state = 'running';
            this.emit(id, 'running');
            void this.mapPortUpnp(s.port, st);
          }
        }
        try {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(IPC.SERVER_STATUS_EVENT, { id, state: st.state });
          }
        } catch { /* ignore */ }
      };
      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', onChunk);

      proc.on('exit', (code) => {
        if (st.igd && st.mappedPort) void upnpDeletePortMapping(st.igd, st.mappedPort, 'TCP').catch(() => {});
        st.proc = null;
        st.state = code === 0 ? 'stopped' : 'error';
        st.error = code === 0 ? null : `Exited with code ${code}`;
        this.emit(id, st.state, st.error);
      });
      proc.on('error', (err) => {
        st.state = 'error';
        st.error = String(err);
        this.emit(id, 'error', String(err));
      });

      return { ok: true };
    } catch (e) {
      st.state = 'error';
      st.error = String(e);
      this.emit(id, 'error', String(e));
      return { ok: false, error: String(e) };
    }
  }

  private async mapPortUpnp(port: number, st: RunningServer) {
    try {
      const igd = await findIgd();
      if (!igd) return;
      const ok = await upnpAddPortMapping(igd, port, port, 'TCP');
      if (ok) {
        st.igd = igd;
        st.mappedPort = port;
        st.log.push('[SlimeLauncher] Port ' + port + ' opened via UPnP');
      }
    } catch { /* router without UPnP — LAN only */ }
  }

  stop(id: string): { ok: boolean; error?: string } {
    const st = this.running.get(id);
    if (!st?.proc) return { ok: false, error: 'Not running.' };
    try { st.proc.stdin?.write('stop\n'); } catch { /* ignore */ }
    setTimeout(() => {
      if (st.proc) { try { st.proc.kill(); } catch { /* ignore */ } }
    }, 15000);
    return { ok: true };
  }

  sendCommand(id: string, cmd: string): { ok: boolean; error?: string } {
    const st = this.running.get(id);
    if (!st?.proc) return { ok: false, error: 'Not running.' };
    try {
      st.proc.stdin?.write(cmd.trim() + '\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
  }
}
