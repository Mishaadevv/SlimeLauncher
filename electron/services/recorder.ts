import { app, BrowserWindow, globalShortcut, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';
import type { SettingsStore } from './settings-store.js';
import type { DatabaseService } from './database.js';
import type {
  RecordingEntry, RecordingSettings, RecordingStatus, FfmpegStatus,
  ScreenshotEntry, RecordingStats,
} from '../../shared/types.js';
import { IPC } from '../../shared/ipc.js';

// Game recording via ffmpeg. Captures the Minecraft window (gdigrab on
// Windows) while the game runs, with configurable fps/quality/resolution,
// optional audio (system loopback / microphone), a global hotkey and
// auto-start when a game launches. Recordings land in a folder chosen in the
// Recordings page and are listed in the launcher gallery.

const FFMPEG_URL_WIN = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const QUALITY_BITRATE: Record<string, string> = { low: '3000k', medium: '7000k', high: '12000k', ultra: '20000k' };
const RESOLUTION_SIZE: Record<string, string> = { '720p': '1280:720', '1080p': '1920:1080', '1440p': '2560:1440', '2160p': '3840:2160' };

const execFileAsync = promisify(execFile);

export class RecorderService {
  private logger: Logger;
  private settings: SettingsStore;
  private db: DatabaseService;
  private listeners: Array<(s: RecordingStatus) => void> = [];
  private proc: ChildProcess | null = null;
  private state: RecordingStatus = {
    state: 'idle',
    startedAt: null,
    fileName: null,
    elapsedMs: 0,
    error: null,
    install: null,
  };
  private outputPath: string | null = null;
  private gameLinked = false;
  private sessionInstance: string | null = null;
  private elapsedTimer: NodeJS.Timeout | null = null;
  private ffmpegCache: { path: string | null; checkedAt: number } = { path: null, checkedAt: 0 };
  private ffmpegInstalling = false;
  private lastStderrTail = '';

  constructor(db: DatabaseService, settings: SettingsStore, logger: Logger) {
    this.db = db;
    this.settings = settings;
    this.logger = logger;
  }

  init() {
    this.refreshSettings();
  }

  dispose() {
    this.stopRecording();
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  }

  // --- status / events ---------------------------------------------------

  subscribe(fn: (s: RecordingStatus) => void): () => void {
    this.listeners.push(fn);
    fn({ ...this.state });
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  getStatus(): RecordingStatus {
    return { ...this.state };
  }

  private emit() {
    const snap = { ...this.state };
    for (const fn of this.listeners) fn(snap);
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.REC_STATUS_EVENT, snap);
      }
    } catch { /* ignore */ }
  }

  private setState(patch: Partial<RecordingStatus>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  // --- settings / hotkey --------------------------------------------------

  refreshSettings() {
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
    const rec = this.getRecSettings();
    if (!rec.enabled) return;
    if (rec.hotkey) {
      try {
        globalShortcut.register(rec.hotkey, () => {
          if (this.state.state === 'idle') this.startRecording({}).catch(() => { });
          else this.stopRecording();
        });
        this.logger.info('Recording hotkey registered', { hotkey: rec.hotkey });
      } catch (e) {
        this.logger.warn('Failed to register recording hotkey', { hotkey: rec.hotkey, error: String(e) });
      }
    }
    if (rec.screenshotHotkey) {
      try {
        globalShortcut.register(rec.screenshotHotkey, () => {
          this.captureScreenshot({}).catch(() => { });
        });
        this.logger.info('Screenshot hotkey registered', { hotkey: rec.screenshotHotkey });
      } catch (e) {
        this.logger.warn('Failed to register screenshot hotkey', { hotkey: rec.screenshotHotkey, error: String(e) });
      }
    }
  }

  getRecSettings(): RecordingSettings {
    const rec = this.settings.get().recording || {
      enabled: false, autoStart: false, fps: 60, quality: 'high', resolution: '1080p',
      audio: 'system', hotkey: 'F8', screenshotHotkey: 'F9', folder: '',
    };
    return { ...rec, folder: rec.folder || this.defaultFolder() };
  }

  private defaultFolder(): string {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return process.platform === 'win32'
      ? `${home}\\.slimelauncher\\recordings`
      : `${home}/.slimelauncher/recordings`;
  }

  // --- ffmpeg -------------------------------------------------------------

  ffmpegStatus(): Promise<FfmpegStatus> {
    return this.findFfmpeg().then((p) => ({ available: !!p, path: p, downloading: this.ffmpegInstalling }));
  }

  // Async on purpose: the PATH fallback spawns `where`/`which`, and a
  // synchronous 5s block on the main process (this status is polled by the UI)
  // froze the whole launcher whenever ffmpeg was missing.
  async findFfmpeg(): Promise<string | null> {
    const now = Date.now();
    if (now - this.ffmpegCache.checkedAt < 5000) return this.ffmpegCache.path;
    this.ffmpegCache.checkedAt = now;

    // 1. Bundled/downloaded ffmpeg under <userData>/tools/ffmpeg
    const toolsDir = path.join(app.getPath('userData'), 'tools');
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const found = this.walkFor(exeName, toolsDir, 0);
    if (found) {
      this.ffmpegCache.path = found;
      return found;
    }

    // 2. ffmpeg on PATH
    const which = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = await execFileAsync(which, ['ffmpeg'], { timeout: 5000, windowsHide: true });
      const first = String(out).trim().split(/\r?\n/)[0];
      if (first) {
        this.ffmpegCache.path = first;
        return first;
      }
    } catch { /* not on PATH */ }
    this.ffmpegCache.path = null;
    return null;
  }

  private walkFor(exeName: string, dir: string, depth: number): string | null {
    if (depth > 4) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === exeName) return path.join(dir, entry.name);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const hit = this.walkFor(exeName, path.join(dir, entry.name), depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  async installFfmpeg(): Promise<{ ok: boolean; error?: string }> {
    if (this.ffmpegInstalling) return { ok: false, error: 'Already downloading ffmpeg.' };
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Recording requires ffmpeg. Install it manually and make sure it is on PATH.' };
    }
    if (await this.findFfmpeg()) return { ok: true };

    this.ffmpegInstalling = true;
    this.setState({ install: { progress: 0, label: 'Downloading ffmpeg…' } });
    const toolsDir = path.join(app.getPath('userData'), 'tools');
    const zipPath = path.join(toolsDir, 'ffmpeg.zip');
    fs.mkdirSync(toolsDir, { recursive: true });
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      await this.downloadFile(FFMPEG_URL_WIN, zipPath, (received, total) => {
        this.setState({
          install: {
            progress: total > 0 ? Math.round((received / total) * 100) : 0,
            label: `Downloading ffmpeg — ${Math.round((received / (1024 * 1024)))} MB`,
          },
        });
      });
      this.setState({ install: { progress: 100, label: 'Extracting ffmpeg…' } });
      await this.extractZip(zipPath, toolsDir);
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      // Force a fresh scan — the cache may still hold the pre-install miss.
      this.ffmpegCache = { path: null, checkedAt: 0 };
      const found = this.findFfmpeg();
      if (!found) {
        this.logger.error('ffmpeg extracted but binary not found', { toolsDir });
        return { ok: false, error: 'ffmpeg was downloaded but the binary could not be found. Try again.' };
      }
      this.logger.info('ffmpeg installed', { path: found });
      return { ok: true };
    } catch (e) {
      this.logger.error('ffmpeg install failed', { error: String(e) });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.ffmpegInstalling = false;
      this.setState({ install: null });
    }
  }

  private downloadFile(
    url: string,
    dest: string,
    onProgress?: (received: number, total: number) => void,
    inactivityMs = 60000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { fs.unlinkSync(dest); } catch { /* ignore */ }
          reject(new Error(`Download timed out after ${Math.round(inactivityMs / 1000)}s of no activity.`));
        }, inactivityMs);
      };
      const doRequest = (reqUrl: string) => {
        const client = reqUrl.startsWith('https') ? https : http;
        const req = client.get(reqUrl, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doRequest(res.headers.location);
          }
          if (res.statusCode && res.statusCode >= 400) {
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode} downloading ffmpeg.`)); }
            return;
          }
          const out = fs.createWriteStream(dest);
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            armTimer();
            received += chunk.length;
            if (onProgress && total > 0) onProgress(received, total);
          });
          out.on('error', (err) => {
            if (!settled) { settled = true; clearTimeout(timer); reject(err); }
          });
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            });
          });
        });
        req.on('error', (err) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        });
        req.on('close', () => clearTimeout(timer));
      };
      armTimer();
      doRequest(url);
    });
  }

  private extractZip(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `Add-Type -Assembly System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')`],
        { timeout: 300000, windowsHide: true },
        (err) => (err ? reject(new Error(`Failed to extract ffmpeg: ${err.message}`)) : resolve()),
      );
    });
  }

  // --- recording ----------------------------------------------------------

  async startRecording(opts: { gameLinked?: boolean; instanceName?: string } = {}): Promise<{ ok: boolean; error?: string }> {
    if (this.state.state !== 'idle') return { ok: false, error: 'Already recording.' };
    const rec = this.getRecSettings();
    if (!rec.enabled && !opts.gameLinked) {
      return { ok: false, error: 'Recording is disabled. Enable it in the Recordings page.' };
    }

    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) {
      this.setState({ error: 'ffmpeg is not installed. Install it to record gameplay.' });
      return { ok: false, error: 'ffmpeg is not installed. Install it to record gameplay.' };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Recording is only supported on Windows for now.' };
    }

    const folder = rec.folder || this.defaultFolder();
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fileName = opts.instanceName
      ? `SlimeLauncher_${opts.instanceName.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.mp4`
      : `SlimeLauncher_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.mp4`;
    this.outputPath = path.join(folder, fileName);
    this.sessionInstance = opts.instanceName || null;

    // Claim the recording state BEFORE the slow discovery steps below. Window
    // and audio-device lookup take seconds; without claiming first, a double
    // hotkey press started TWO ffmpeg processes and orphaned the first one.
    this.gameLinked = !!opts.gameLinked;
    this.lastStderrTail = '';
    this.setState({ state: 'recording', startedAt: Date.now(), fileName, error: null, elapsedMs: 0 });

    // Find the Minecraft window title so gdigrab captures only the game
    // (falls back to the whole desktop when the window can't be found).
    const title = await this.findMcWindowTitle();

    // Resolve real DirectShow audio device names — "virtual-audio-capturer"
    // etc. are not guaranteed to exist on the user's machine.
    const audioDevices = await this.resolveAudioDevices(ffmpeg, rec);

    const args = this.buildArgs(fileName, title, rec, audioDevices);
    this.logger.info('Starting recording', { fileName, title, ffmpeg, audioDevices });

    try {
      this.proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      this.outputPath = null;
      this.gameLinked = false;
      this.setState({ state: 'idle', startedAt: null, fileName: null, error: String(e) });
      return { ok: false, error: `Failed to start ffmpeg: ${String(e)}` };
    }

    let stderrBuf = '';
    this.proc.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf-8');
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
    });

    this.proc.on('error', (err) => {
      this.logger.error('ffmpeg process error', { error: String(err) });
      this.finalize(1, `Failed to start ffmpeg: ${err.message}`);
    });

    this.proc.on('close', (code) => {
      this.proc = null;
      this.finalize(code ?? 1, stderrBuf);
    });

    // The game can take a while to reach a visible window; gdigrab errors
    // (e.g. "window not found") arrive on stderr asynchronously. Keep the
    // process alive briefly and only fail if it exits by itself.
    this.startElapsedTimer();
    return { ok: true };
  }

  private buildArgs(
    fileName: string,
    title: string | null,
    rec: RecordingSettings,
    audio: { system: string | null; mic: string | null },
  ): string[] {
    const fps = [30, 60, 120].includes(rec.fps) ? rec.fps : 60;
    const bitrate = QUALITY_BITRATE[rec.quality] || '12000k';
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-rtbufsize', '256M',
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-i', title ? `title=${this.escapeGdigrabTitle(title)}` : 'desktop',
    ];

    if (audio.system) {
      args.push('-f', 'dshow', '-i', `audio=${audio.system}`);
    }
    if (audio.mic) {
      args.push('-f', 'dshow', '-i', `audio=${audio.mic}`);
    }

    const scale = rec.resolution !== 'window' ? RESOLUTION_SIZE[rec.resolution] : null;
    if (scale) {
      args.push('-vf', `scale=${scale}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
    }

    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-movflags', '+faststart');

    const hasAudioIn = audio.system !== null || audio.mic !== null;
    if (rec.audio === 'both' && audio.system && audio.mic) {
      args.push('-filter_complex', '[1:a][2:a]amix=inputs=2:duration=first[aout]', '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    } else if ((rec.audio === 'both' || rec.audio === 'system' || rec.audio === 'mic') && hasAudioIn) {
      args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-an');
    }

    args.push(this.outputPath as string);
    return args;
  }

  // Resolves the actual DirectShow audio device names for the selected audio
  // mode. Uses the user-selected device when one is configured, otherwise
  // auto-picks the best match. Returns null for sources that aren't present so
  // the recording continues without that track instead of failing outright.
  private async resolveAudioDevices(
    ffmpeg: string,
    rec: RecordingSettings,
  ): Promise<{ system: string | null; mic: string | null }> {
    const needSystem = rec.audio === 'system' || rec.audio === 'both';
    const needMic = rec.audio === 'mic' || rec.audio === 'both';
    if (!needSystem && !needMic) return { system: null, mic: null };
    // Only enumerate devices for the sources that aren't explicitly chosen.
    const needAuto = (needSystem && !rec.systemDevice) || (needMic && !rec.micDevice);
    const devices = needAuto ? await this.listDshowAudioDevices(ffmpeg) : [];
    if (needAuto && devices.length === 0) {
      this.logger.warn('No DirectShow audio devices found, recording without audio');
    }
    return {
      system: needSystem ? (rec.systemDevice || (devices.length > 0 ? this.pickAudioDevice(devices, 'system') : null)) : null,
      mic: needMic ? (rec.micDevice || (devices.length > 0 ? this.pickAudioDevice(devices, 'mic') : null)) : null,
    };
  }

  // Lists the audio capture devices available on this machine (used by the
  // Recordings page to populate the device pickers).
  async audioDevices(): Promise<string[]> {
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg || process.platform !== 'win32') return [];
    try {
      return await this.listDshowAudioDevices(ffmpeg);
    } catch {
      return [];
    }
  }

  private dshowAudioCache: { at: number; devices: string[] } | null = null;

  // Enumerates DirectShow audio device names by asking ffmpeg to list them.
  // The list is cached for a minute — enumerating takes ~1s per call.
  private listDshowAudioDevices(ffmpeg: string): Promise<string[]> {
    return new Promise((resolve) => {
      if (this.dshowAudioCache && Date.now() - this.dshowAudioCache.at < 60000) {
        resolve(this.dshowAudioCache.devices);
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
      } catch {
        resolve([]);
        return;
      }
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      child.on('error', () => resolve([]));
      child.on('close', () => {
        const devices: string[] = [];
        const audioRe = /"([^"]+)"\s+\(audio\)/g;
        let m: RegExpExecArray | null;
        while ((m = audioRe.exec(stderr)) !== null) {
          const name = m[1].trim();
          if (name && !devices.includes(name)) devices.push(name);
        }
        const altRe = /Alternative name "([^"]+)"/g;
        while ((m = altRe.exec(stderr)) !== null) {
          const name = m[1].trim();
          if (name && !devices.includes(name)) devices.push(name);
        }
        this.dshowAudioCache = { at: Date.now(), devices };
        resolve(devices);
      });
    });
  }

  // Picks the best device for a source kind. "system" prefers loopback-style
  // capture devices (Stereo Mix, What U Hear, VB-Cable, virtual-audio-capturer);
  // "mic" prefers microphone/input devices. Falls back to the first device.
  private pickAudioDevice(devices: string[], kind: 'system' | 'mic'): string | null {
    if (devices.length === 0) return null;
    const prefs = kind === 'system'
      ? [/virtual-audio-capturer/i, /stereo mix/i, /what u hear/i, /cable/i, /loopback/i, /line\s*\(/i]
      : [/microphone/i, /mic/i, /input/i, /capture/i];
    for (const p of prefs) {
      const hit = devices.find((d) => p.test(d));
      if (hit) return hit;
    }
    return devices[0];
  }

  private escapeGdigrabTitle(title: string): string {
    return title.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  }

  private findMcWindowTitle(): Promise<string | null> {
    return new Promise((resolve) => {
      const ps = [
        '-NoProfile', '-Command',
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p = Get-Process | Where-Object { $_.MainWindowTitle -like 'Minecraft*' } | Select-Object -First 1; if ($p) { $p.MainWindowTitle }",
      ];
      execFile(
        'powershell',
        ps,
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          const t = stdout?.trim();
          resolve(err || !t ? null : t);
        },
      );
    });
  }

  stopRecording(): { ok: boolean; error?: string } {
    if (this.state.state === 'idle') return { ok: false, error: 'Not recording.' };
    if (!this.proc) return { ok: false, error: 'Recording process is not running.' };
    this.setState({ state: 'stopping' });
    try {
      this.proc.stdin?.write('q');
    } catch { /* stdin closed */ }
    // If ffmpeg ignores the graceful stop, force-kill after a short grace
    // period. The file may be unplayable in that case, but the recording
    // must never keep running forever.
    const proc = this.proc;
    setTimeout(() => {
      if (this.proc === proc) {
        try { proc.kill(); } catch { /* already gone */ }
      }
    }, 6000);
    return { ok: true };
  }

  // Stops the recording started automatically for a game (called when the
  // game process exits). Manual recordings are left running.
  stopForGame() {
    if (this.gameLinked) this.stopRecording();
  }

  // Called right after a game launch; starts a recording when the user has
  // enabled auto-start. Manual hotkey/button recordings are untouched.
  startForGame(instanceName: string) {
    const rec = this.getRecSettings();
    if (!rec.enabled || !rec.autoStart) return;
    this.startRecording({ gameLinked: true, instanceName }).catch(() => { });
  }

  private startElapsedTimer() {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      if (this.state.state === 'recording' && this.state.startedAt) {
        this.setState({ elapsedMs: Date.now() - this.state.startedAt });
      }
    }, 1000);
  }

  private stopElapsedTimer() {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  private finalize(exitCode: number, stderrTail: string) {
    this.stopElapsedTimer();
    const startedAt = this.state.startedAt;
    const filePath = this.outputPath;
    const fileName = this.state.fileName;
    this.outputPath = null;
    this.gameLinked = false;
    const instanceName = this.sessionInstance;
    this.sessionInstance = null;

    let durationMs = 0;
    let sizeBytes = 0;
    if (startedAt) durationMs = Date.now() - startedAt;
    if (filePath) {
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch { /* file may be missing on failure */ }
    }

    const failed = exitCode !== 0 || !filePath || sizeBytes === 0;
    const error = failed ? (stderrTail.trim() ? this.shortError(stderrTail) : `ffmpeg exited with code ${exitCode}`) : null;

    if (!failed && fileName && filePath) {
      const rec = this.getRecSettings();
      this.db.prepare(
        'INSERT INTO recordings (id, file_name, file_path, instance_name, duration_ms, size_bytes, fps, quality, resolution, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        randomUUID(), fileName, filePath, instanceName, durationMs, sizeBytes,
        rec.fps, rec.quality, rec.resolution, Date.now(),
      );
      this.logger.info('Recording saved', { fileName, sizeBytes, durationMs });
    } else if (filePath) {
      this.logger.warn('Recording failed', { exitCode, error, stderrTail: stderrTail.slice(-500) });
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }

    this.setState({ state: 'idle', startedAt: null, fileName: null, elapsedMs: 0, error });
  }

  private shortError(tail: string): string {
    const lines = tail.trim().split(/\r?\n/);
    const meaningful = lines.filter((l) => /error|not found|failed|could not/i.test(l)).slice(-3);
    const src = meaningful.length ? meaningful.join(' · ') : lines.slice(-1)[0] || '';
    return src.length > 300 ? src.slice(-300) : src;
  }

  // --- gallery ------------------------------------------------------------

  list(): RecordingEntry[] {
    try {
      const rows = this.db.prepare('SELECT * FROM recordings ORDER BY created_at DESC').all() as Record<string, unknown>[];
      const out: RecordingEntry[] = [];
      for (const r of rows) {
        const filePath = String(r.file_path);
        if (!fs.existsSync(filePath)) {
          // File was removed outside the launcher — drop the stale entry.
          this.db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
          continue;
        }
        out.push({
          id: String(r.id),
          fileName: String(r.file_name),
          filePath,
          instanceName: r.instance_name ? String(r.instance_name) : null,
          durationMs: Number(r.duration_ms) || 0,
          sizeBytes: Number(r.size_bytes) || 0,
          fps: Number(r.fps) || 60,
          quality: String(r.quality || ''),
          resolution: String(r.resolution || ''),
          createdAt: Number(r.created_at),
        });
      }
      return out;
    } catch (e) {
      this.logger.error('Failed to list recordings', { error: String(e) });
      return [];
    }
  }

  delete(id: string): { ok: boolean } {
    const row = this.db.prepare('SELECT file_path FROM recordings WHERE id = ?').get(id) as { file_path: string } | undefined;
    if (row) {
      try { fs.unlinkSync(row.file_path); } catch { /* ignore */ }
      this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    }
    return { ok: true };
  }

  openFolder() {
    const folder = this.getRecSettings().folder || this.defaultFolder();
    fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
  }

  // --- screenshots ---------------------------------------------------------

  async captureScreenshot(opts: { instanceName?: string } = {}): Promise<{ ok: boolean; error?: string; entry?: ScreenshotEntry }> {
    const rec = this.getRecSettings();
    if (!rec.enabled) {
      return { ok: false, error: 'Recording is disabled. Enable it in the Recordings page.' };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Screenshots are only supported on Windows for now.' };
    }
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) {
      return { ok: false, error: 'ffmpeg is not installed. Install it to capture screenshots.' };
    }

    const folder = rec.folder || this.defaultFolder();
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const prefix = opts.instanceName
      ? `${opts.instanceName.replace(/[^a-zA-Z0-9_-]+/g, '_')}_`
      : '';
    const fileName = `SlimeLauncher_${prefix}Screenshot_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
    const outPath = path.join(folder, fileName);

    // Grab a single frame of the Minecraft window (falls back to the whole
    // desktop when the window can't be found), like the video recorder.
    const title = await this.findMcWindowTitle();
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-rtbufsize', '256M',
      '-f', 'gdigrab',
      '-framerate', '30',
      '-i', title ? `title=${this.escapeGdigrabTitle(title)}` : 'desktop',
      '-frames:v', '1',
      outPath,
    ];
    this.logger.info('Capturing screenshot', { fileName, title });

    try {
      await this.runFfmpeg(args, 20000);
    } catch (e) {
      // The window may have been missed (closed, renamed, or gdigrab couldn't
      // match the title) — retry once against the whole desktop before giving
      // up so the screenshot button still works.
      if (title) {
        this.logger.warn('Screenshot window capture failed, retrying with desktop', { error: String(e) });
        const desktopArgs = [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-rtbufsize', '256M',
          '-f', 'gdigrab',
          '-framerate', '30',
          '-i', 'desktop',
          '-frames:v', '1',
          outPath,
        ];
        try {
          await this.runFfmpeg(desktopArgs, 20000);
        } catch (e2) {
          this.logger.warn('Screenshot desktop capture failed', { error: String(e2) });
          return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) };
        }
      } else {
        this.logger.warn('Screenshot capture failed', { error: String(e) });
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(outPath).size;
    } catch { /* ignore */ }
    if (sizeBytes === 0) {
      try { fs.unlinkSync(outPath); } catch { /* ignore */ }
      return { ok: false, error: 'Screenshot capture failed — the game window was not found.' };
    }

    const { width, height } = await this.probeSize(outPath);
    const entry: ScreenshotEntry = {
      id: randomUUID(),
      fileName,
      filePath: outPath,
      instanceName: opts.instanceName || null,
      width,
      height,
      sizeBytes,
      createdAt: Date.now(),
    };
    this.db.prepare(
      'INSERT INTO screenshots (id, file_name, file_path, instance_name, width, height, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(entry.id, fileName, outPath, entry.instanceName, width, height, sizeBytes, entry.createdAt);

    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.REC_SHOT_EVENT, entry);
      }
    } catch { /* ignore */ }

    this.logger.info('Screenshot saved', { fileName, sizeBytes });
    return { ok: true, entry };
  }

  screenshots(): ScreenshotEntry[] {
    try {
      const rows = this.db.prepare('SELECT * FROM screenshots ORDER BY created_at DESC').all() as Record<string, unknown>[];
      const out: ScreenshotEntry[] = [];
      for (const r of rows) {
        const filePath = String(r.file_path);
        if (!fs.existsSync(filePath)) {
          // File was removed outside the launcher — drop the stale entry.
          this.db.prepare('DELETE FROM screenshots WHERE id = ?').run(r.id);
          continue;
        }
        out.push({
          id: String(r.id),
          fileName: String(r.file_name),
          filePath,
          instanceName: r.instance_name ? String(r.instance_name) : null,
          width: Number(r.width) || 0,
          height: Number(r.height) || 0,
          sizeBytes: Number(r.size_bytes) || 0,
          createdAt: Number(r.created_at),
        });
      }
      return out;
    } catch (e) {
      this.logger.error('Failed to list screenshots', { error: String(e) });
      return [];
    }
  }

  deleteScreenshot(id: string): { ok: boolean } {
    const row = this.db.prepare('SELECT file_path FROM screenshots WHERE id = ?').get(id) as { file_path: string } | undefined;
    if (row) {
      try { fs.unlinkSync(row.file_path); } catch { /* ignore */ }
      this.db.prepare('DELETE FROM screenshots WHERE id = ?').run(id);
    }
    return { ok: true };
  }

  stats(): RecordingStats {
    const out: RecordingStats = { videoCount: 0, screenshotCount: 0, videoBytes: 0, screenshotBytes: 0, totalBytes: 0 };
    try {
      const v = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS s FROM recordings').get() as { c: number; s: number };
      const sh = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS s FROM screenshots').get() as { c: number; s: number };
      out.videoCount = Number(v.c) || 0;
      out.videoBytes = Number(v.s) || 0;
      out.screenshotCount = Number(sh.c) || 0;
      out.screenshotBytes = Number(sh.s) || 0;
      out.totalBytes = out.videoBytes + out.screenshotBytes;
    } catch (e) {
      this.logger.error('Failed to compute recording stats', { error: String(e) });
    }
    return out;
  }

  // Runs a short ffmpeg job (e.g. a still capture) to completion with a
  // timeout, collecting stderr for a readable error message on failure.
  private async runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) {
      throw new Error('ffmpeg is not installed.');
    }
    return new Promise<void>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (e) {
        reject(new Error(`Failed to start ffmpeg: ${String(e)}`));
        return;
      }
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8');
        if (stderr.length > 8192) stderr = stderr.slice(-4096);
      });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        reject(new Error('Screenshot capture timed out.'));
      }, timeoutMs);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(this.shortError(stderr) || `ffmpeg exited with code ${code}`));
      });
    });
  }

  // Best-effort resolution of a still image via ffprobe (bundled with ffmpeg).
  private async probeSize(filePath: string): Promise<{ width: number; height: number }> {
    const ffmpeg = await this.findFfmpeg();
    if (!ffmpeg) return { width: 0, height: 0 };
    const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (!fs.existsSync(ffprobe)) return { width: 0, height: 0 };
    try {
      const out = execFileSync(
        ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', filePath],
        { encoding: 'utf-8', timeout: 8000, windowsHide: true },
      );
      const [w, h] = out.trim().split('x').map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) return { width: w || 0, height: h || 0 };
    } catch { /* ignore */ }
    return { width: 0, height: 0 };
  }
}