import { ipcMain, BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { MinecraftInstance, LoaderType } from '../../shared/types.js';
import { notify } from './types.js';
import { refreshMsTokenIfExpired } from './microsoft.js';
import { patchAuthlibForLocalServer, isAuthlibJar, patchClientJarForLegacySkins } from '../services/skin-patch.js';

const MC_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
function platformKey(): 'windows' | 'osx' | 'linux' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

// A parsed Minecraft version JSON (either a vanilla version or a loader profile).
interface VersionProfile {
  id?: string;
  inheritsFrom?: string;
  mainClass?: string;
  assetIndex?: { id: string; url: string };
  javaVersion?: { majorVersion?: number };
  minecraftArguments?: string;
  logging?: { client?: { argument?: string; file?: { id?: string; url?: string } } };
  arguments?: {
    jvm?: Array<string | { rules?: unknown[]; value?: string | string[] }>;
    game?: Array<string | { rules?: unknown[]; value?: string | string[] }>;
  };
  libraries?: Array<{
    name: string;
    url?: string;
    sha1?: string;
    natives?: Record<string, string>;
    downloads?: { artifact?: { path: string; url: string; sha1?: string }; classifiers?: Record<string, { path: string; url: string }> };
  }>;
}

// Combines a loader profile with the vanilla version it is based on.
// * Self-contained profiles (Forge/NeoForge) are used as-is, only falling back
//   to the vanilla assetIndex/javaVersion when absent.
// * Inheriting profiles (Fabric/Quilt, `inheritsFrom`) add the vanilla game
//   args, assets and java to the loader's own main class / jvm args / libs.
function mergeVersionProfiles(loader: VersionProfile, vanilla: VersionProfile): VersionProfile {
  if (!loader.inheritsFrom) {
    return {
      ...loader,
      assetIndex: loader.assetIndex || vanilla.assetIndex,
      javaVersion: loader.javaVersion || vanilla.javaVersion,
    };
  }
  const loaderGame = loader.arguments?.game || [];
  const vanillaGame = vanilla.arguments?.game || [];
  const vanillaJvm = vanilla.arguments?.jvm || [];
  const loaderJvm = loader.arguments?.jvm || [];
  const jvm = [...vanillaJvm, ...loaderJvm];
  const game = [...vanillaGame, ...loaderGame];
  return {
    id: loader.id || vanilla.id,
    mainClass: loader.mainClass || vanilla.mainClass,
    assetIndex: vanilla.assetIndex,
    javaVersion: vanilla.javaVersion,
    logging: vanilla.logging,
    minecraftArguments: loader.minecraftArguments || vanilla.minecraftArguments,
    // Only emit `arguments` when a profile actually ships structured args.
    // Loader profiles only add their own args on top of the vanilla ones:
    // Fabric/Quilt ship an empty `game` list (the vanilla args are inherited),
    // while Forge/NeoForge append e.g. `--launchTarget forge_client`. BUT
    // pre-1.13 profiles (e.g. Forge 1.12.2) use the legacy `minecraftArguments`
    // string and have NO `arguments` field — emitting an empty-but-truthy
    // `{ jvm: [], game: [] }` here would make the launch code take the
    // structured branch and silently drop BOTH the `-cp` classpath and the
    // game args, so the JVM fails with "Could not find or load main class".
    ...(jvm.length > 0 || game.length > 0 ? { arguments: { jvm, game } } : {}),
    libraries: dedupeLibraries([...(vanilla.libraries || []), ...(loader.libraries || [])]),
  };
}

// Deduplicates libraries by `group:artifact` + optional classifier (NOT full
// name, which includes the version). A loader profile (Forge/NeoForge) often
// pins its own versions of shared libraries (e.g. guava 33.3.1 vs vanilla's
// 33.5.0) — when both end up merged into one classpath the JVM module system
// crashes with "export package ... to module" ResolutionErrors. The loader's
// version wins, so the merged profile stays internally consistent. Classifiers
// (e.g. `...:natives-windows`) are kept apart from the plain artifact — they
// are separate jars and must not replace it.
function dedupeLibraries<T extends { name?: string }>(libs: T[]): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const lib of libs) {
    if (!lib.name) {
      out.push(lib);
      continue;
    }
    const parts = lib.name.split(':');
    const classifier = parts.length >= 4 ? `:${parts[3]}` : '';
    const key = `${parts.slice(0, 2).join(':')}${classifier}`;
    if (seen.has(key)) {
      // Loader libs come after vanilla libs in the merged list, so replacing
      // keeps the loader-pinned version.
      out[seen.get(key)!] = lib;
      continue;
    }
    seen.set(key, out.length);
    out.push(lib);
  }
  return out;
}

// Jar files are zip archives (PK magic). Everything else (HTML error pages,
// partial downloads) would crash the game's classloader, so treat them as
// missing and let the downloader replace them.
function isZipFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch {
    return false;
  }
}

// Old-format libraries carry a maven base URL (e.g. https://maven.fabricmc.net/)
// instead of a direct jar link. Resolve the real artifact URL and relative path
// from the `group:artifact:version` name.
function mavenJarRef(base: string, name: string): { url: string; rel: string } {
  const parts = name.split(':');
  const [group, artifact, version] = parts;
  const rel = `${group.split('.').join('/')}/${artifact}/${version}/${artifact}-${version}.jar`;
  const b = base.endsWith('/') ? base : base + '/';
  return { url: b + rel, rel };
}

function getRequiredJavaVersion(mcVersion: string, versionData?: { javaVersion?: { majorVersion?: number } }): { min: number; max?: number } {
  // Prefer the authoritative runtime declared in the version JSON. Every modern
  // version (1.17+, 26.x, snapshots/pre/rc) ships `javaVersion.majorVersion`
  // (e.g. 26.x → 25, 1.21 → 21), so this is the most accurate source.
  const explicit = versionData?.javaVersion?.majorVersion;
  if (explicit && explicit >= 8) return { min: explicit };

  // Ancient builds (classic, rd-, infdev, alpha, beta) have no javaVersion field
  // and only run on Java 8. Their ids mangle the numeric heuristic below.
  if (/^(rd-|inf-|c0|d0|a1|b1)/.test(mcVersion)) return { min: 8, max: 8 };

  // Snapshots like 26w01a → check leading number
  const clean = mcVersion.replace(/[^0-9.]/g, '');
  const parts = clean.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;

  if (major >= 26) return { min: 25 }; // 26.x and newer
  if (major >= 2 || (major === 1 && minor >= 21)) return { min: 21 }; // 1.21+ and 2x.x
  if (major === 1 && minor >= 20 && parts[2] !== undefined && parts[2] >= 5) return { min: 21 }; // 1.20.5+
  if (major === 1 && minor >= 18) return { min: 17 }; // 1.18 - 1.20.4
  if (major === 1 && minor >= 17) return { min: 17 }; // 1.17 - 1.17.1
  // Pre-1.17: LaunchWrapper uses URLClassLoader which was removed in Java 9+.
  // These versions MUST run on Java 8 exactly.
  return { min: 8, max: 8 };
}

function getAdoptiumApiUrl(javaMajor: number): string {
  return `https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot`;
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c: Buffer) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    // Without a timeout a hung connection stalled installs/launches forever.
    req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.on('error', reject);
  });
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c: Buffer) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.on('error', reject);
  });
}

// Mojang/loader endpoints are frequently slow or throttled, and a single
// hiccup used to abort the whole first-time install — which is why the very
// first launch could "do nothing" while a second launch (with files already on
// disk) worked. Retry a few times with backoff before giving up.
async function fetchJsonRetry(url: string, attempts = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

async function downloadFileRetry(url: string, dest: string, expectedSha1?: string, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await downloadFile(url, dest, expectedSha1);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// Downloads a file with a sha1 check. Guards against stalled connections with
// an inactivity timeout (reset on every chunk) so a hung server can never leave
// the launcher stuck on 'Launching…' forever.
function downloadFile(
  url: string,
  dest: string,
  expectedSha1?: string,
  inactivityMs = 60000,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let settled = false;
    let timer: NodeJS.Timeout;
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        reject(new Error(`Download timed out after ${Math.round(inactivityMs / 1000)}s of no activity: ${path.basename(dest)}`));
      }, inactivityMs);
    };

    const doRequest = (reqUrl: string) => {
      const c = reqUrl.startsWith('https') ? https : http;
      const req = c.get(reqUrl, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location);
        }
        if (res.statusCode && res.statusCode >= 400) {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`)); }
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
            void (async () => {
              if (settled) return;
              if (expectedSha1) {
                const actual = await sha1File(dest);
                if (actual.toLowerCase() !== expectedSha1.toLowerCase()) {
                  settled = true; clearTimeout(timer);
                  try { fs.unlinkSync(dest); } catch { /* ignore */ }
                  reject(new Error(`SHA-1 mismatch for ${path.basename(dest)} (expected ${expectedSha1}, got ${actual})`));
                  return;
                }
              }
              settled = true; clearTimeout(timer);
              resolve();
            })().catch((err) => {
              if (!settled) {
                settled = true; clearTimeout(timer);
                reject(err);
              }
            });
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

// Streams the file into the hash instead of readFileSync: hashing the 25 MB
// client jar (and every library, on every launch) with a whole-file buffer
// blocked the main process for noticeable stretches.
function sha1File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Writes JSON via a temp file + rename so an interrupted write (crash, power
// loss) can never leave a truncated file behind — a half-written version JSON
// used to break EVERY subsequent launch of the instance.
function writeJsonAtomic(filePath: string, data: unknown, space?: number): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, space));
  fs.renameSync(tmp, filePath);
}

function sendProgress(deps: HandlerDeps, stage: string, progress: number, message: string) {
  const win = deps.getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.MC_LAUNCH_PROGRESS, { stage, progress, message });
  }
}

// --- Minecraft console window ---
// A separate terminal-style window shows the game's stdout/stderr. Two modes:
//  * live — opened at launch when the "Show game console" setting is on, and
//    the output streams into it in real time;
//  * crash — always opened when the game crashes, showing the captured log.
// The console page (src/console.html) fetches the current state over IPC on
// load and then receives live chunks / status updates.

type ConsoleStatus = 'starting' | 'running' | 'crashed' | 'closed';

interface ConsoleState {
  session: number;
  title: string;
  instanceName: string;
  output: string;
  status: ConsoleStatus;
  exitCode: number | null;
  crashedAt: number | null;
  logPath: string | null;
}

let consoleSeq = 0;
let activeConsole: ConsoleState | null = null;
let consoleWindow: BrowserWindow | null = null;

function getOrCreateConsoleWindow(): BrowserWindow {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.show();
    consoleWindow.focus();
    return consoleWindow;
  }
  const appPath = app.getAppPath();
  const preloadMjs = path.join(appPath, 'dist-electron', 'preload.mjs');
  const preloadPath = fs.existsSync(preloadMjs)
    ? preloadMjs
    : path.join(appPath, 'dist-electron', 'preload.js');

  const win = new BrowserWindow({
    width: 880,
    height: 560,
    minWidth: 520,
    minHeight: 320,
    frame: false,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  consoleWindow = win;
  win.on('closed', () => { consoleWindow = null; });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173/console.html').catch(() => { });
  } else {
    win.loadFile(path.join(appPath, 'dist', 'console.html'));
  }
  win.once('ready-to-show', () => win.show());
  return win;
}

// Opens the console in live mode for a running game. Returns the session id
// the launch should stream into, or null when the window can't be shown.
function openGameConsole(instanceName: string): number | null {
  try {
    const session = ++consoleSeq;
    activeConsole = {
      session,
      title: `Minecraft Console — ${instanceName}`,
      instanceName,
      output: '',
      status: 'starting',
      exitCode: null,
      crashedAt: null,
      logPath: null,
    };
    getOrCreateConsoleWindow();
    return session;
  } catch (e) {
    return null;
  }
}

function pushConsoleLive(session: number, chunk: string) {
  const win = consoleWindow;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send(IPC.MC_CONSOLE_LIVE, { session, chunk });
  }
}

function pushConsoleStatus(session: number, status: ConsoleStatus, exitCode: number | null, title?: string) {
  const win = consoleWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.MC_CONSOLE_STATUS, { session, status, exitCode, title });
  }
}

export function registerMcHandlers(deps: HandlerDeps) {
  const { db, settingsStore, logger } = deps;

  ipcMain.handle(IPC.MC_CONSOLE_GET_DATA, () =>
    activeConsole ? { session: activeConsole.session, state: activeConsole } : null);

  ipcMain.handle(IPC.MC_VERSIONS, async () => {
    try {
      const manifest = (await fetchJson(MC_VERSION_MANIFEST)) as {
        latest: { release: string; snapshot: string };
        versions: { id: string; type: string; url: string }[];
      };
      return {
        latest: manifest.latest,
        versions: manifest.versions.map((v) => ({ id: v.id, type: v.type })),
      };
    } catch (e) {
      logger.error('Failed to fetch MC versions', { error: String(e) });
      return { latest: { release: '1.20.1', snapshot: '24w10a' }, versions: [] };
    }
  });

  ipcMain.handle(IPC.MC_LOADER_VERSIONS, async (_e, mcVersion: string, loader: LoaderType) => {
    try {
      return await fetchLoaderVersions(deps, loader, mcVersion);
    } catch (e) {
      logger.error('Failed to fetch loader versions', { error: String(e) });
      return [];
    }
  });

  ipcMain.handle(IPC.MC_INSTALL, async (_e, data: { instanceId: string }) => {
    const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(data.instanceId) as Record<string, unknown> | undefined;
    if (!inst) return { ok: false, error: 'Instance not found.' };
    const settings = settingsStore.load();
    const instDir = path.join(settings.minecraftDirectory, data.instanceId);
    fs.mkdirSync(instDir, { recursive: true });

    // Track the install in the Downloads page so users can see whether the
    // version finished downloading.
    const dlName = `Minecraft ${inst.mc_version}${String(inst.loader) !== 'vanilla' ? ` (${inst.loader})` : ''}`;
    const dlId = randomUUID();
    db.prepare(
      "INSERT INTO downloads (id, name, url, destination, total_bytes, downloaded_bytes, status, category, created_at) VALUES (?, ?, 'slime:install', ?, 0, 0, 'downloading', 'minecraft', ?)"
    ).run(dlId, dlName, instDir, Date.now());
    const finishInstall = (status: 'completed' | 'error', error: string | null) => {
      db.prepare('UPDATE downloads SET status = ?, error = ?, total_bytes = 1, downloaded_bytes = 1 WHERE id = ?').run(status, error, dlId);
    };

    sendProgress(deps, 'preparing', 0.05, 'Preparing instance...');
    try {
      await installVanilla(deps, String(inst.mc_version), settings.minecraftDirectory, data.instanceId);
      if (String(inst.loader) !== 'vanilla') {
        // Auto-fetch latest loader version if not set
        let loaderVersion = String(inst.loader_version || '');
        if (!loaderVersion) {
          sendProgress(deps, 'loader', 0.65, `Finding latest ${inst.loader} version...`);
          const versions = await fetchLoaderVersions(deps, String(inst.loader) as LoaderType, String(inst.mc_version));
          loaderVersion = versions[0] || '';
          if (loaderVersion) {
            db.prepare('UPDATE instances SET loader_version = ? WHERE id = ?').run(loaderVersion, data.instanceId);
          }
        }
        if (loaderVersion) {
          sendProgress(deps, 'loader', 0.7, `Installing ${inst.loader} ${loaderVersion}...`);
          await installLoader(deps, String(inst.loader) as LoaderType, String(inst.mc_version), loaderVersion, instDir);
        } else {
          logger.warn(`No ${inst.loader} version found for ${inst.mc_version}`);
          finishInstall('error', `No ${inst.loader} version exists for Minecraft ${inst.mc_version}.`);
          sendProgress(deps, 'error', 0, `No ${inst.loader} version exists for Minecraft ${inst.mc_version}.`);
          return { ok: false, error: `No ${inst.loader} version exists for Minecraft ${inst.mc_version}.` };
        }
      }
      finishInstall('completed', null);
      sendProgress(deps, 'done', 1, 'Installation complete.');
      notify(deps, { type: 'success', title: 'Instance ready', message: `${String(inst.name)} is ready to play.` });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finishInstall('error', msg);
      sendProgress(deps, 'error', 0, msg);
      notify(deps, { type: 'error', title: 'Installation failed', message: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.MC_LAUNCH, async (_e, instanceId: string) => {
    const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as Record<string, unknown> | undefined;
    if (!inst) return { ok: false, error: 'Instance not found.' };
    const settings = settingsStore.load();

    sendProgress(deps, 'checking', 0.05, 'Checking files...');
    const instDir = path.join(settings.minecraftDirectory, instanceId);
    const mcVersion = String(inst.mc_version);
    const loader = String(inst.loader);

    // Loader instances launch from their own version profile
    // (versions/<mc>-<loader>…/<mc>-<loader>….json) while the client jar and
    // vanilla libraries live under versions/<mc>. Forge/NeoForge append the
    // loader version to the folder name, so scan for the matching prefix.
    const vanillaId = mcVersion;
    const vanillaJson = path.join(instDir, 'versions', vanillaId, `${vanillaId}.json`);
    let launchId = findLoaderProfileId(instDir, mcVersion, loader);
    let launchJson = path.join(instDir, 'versions', launchId, `${launchId}.json`);

    // Ensure installed — wait for downloads to complete. Re-resolve the loader
    // profile afterwards because a fresh install creates the profile folder.
    if (!fs.existsSync(launchJson) || !fs.existsSync(vanillaJson)) {
      sendProgress(deps, 'installing', 0.1, 'Installing Minecraft files...');
      try {
        await installVanilla(deps, mcVersion, settings.minecraftDirectory, instanceId);
        if (loader !== 'vanilla') {
          let loaderVersion = String(inst.loader_version || '');
          if (!loaderVersion) {
            sendProgress(deps, 'installing', 0.3, `Finding latest ${loader} version...`);
            const versions = await fetchLoaderVersions(deps, loader as LoaderType, mcVersion);
            loaderVersion = versions[0] || '';
            if (loaderVersion) {
              db.prepare('UPDATE instances SET loader_version = ? WHERE id = ?').run(loaderVersion, instanceId);
            }
          }
          if (loaderVersion) {
            await installLoader(deps, loader as LoaderType, mcVersion, loaderVersion, instDir);
          }
        }
        launchId = findLoaderProfileId(instDir, mcVersion, loader);
        launchJson = path.join(instDir, 'versions', launchId, `${launchId}.json`);
      } catch (e) {
        return { ok: false, error: `Installation failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // Verify critical files exist
    if (!fs.existsSync(launchJson)) {
      return { ok: false, error: `Version JSON not found for ${launchId}. Try reinstalling.` };
    }

    // Loader profiles like Fabric/Quilt are declared with `inheritsFrom` — they
    // only add a main class, extra JVM args and their own libraries, while the
    // real game args / assets / java come from the vanilla version they inherit.
    // Merge the two so the launch below sees a complete picture.
    let vanillaProfile: VersionProfile;
    let loaderProfile: VersionProfile;
    try {
      vanillaProfile = JSON.parse(fs.readFileSync(vanillaJson, 'utf-8')) as VersionProfile;
      loaderProfile = JSON.parse(fs.readFileSync(launchJson, 'utf-8')) as VersionProfile;
    } catch (e) {
      // A truncated version JSON (crash mid-install) used to break EVERY later
      // launch with an obscure error. Delete the corrupt files and reinstall.
      logger.warn('Version JSON corrupted — reinstalling', { error: String(e) });
      sendProgress(deps, 'installing', 0.1, 'Repairing corrupted version files...');
      try { fs.unlinkSync(vanillaJson); } catch { /* ignore */ }
      try { if (launchJson !== vanillaJson) fs.unlinkSync(launchJson); } catch { /* ignore */ }
      try {
        await installVanilla(deps, mcVersion, settings.minecraftDirectory, instanceId);
        if (loader !== 'vanilla') {
          let lv = String(inst.loader_version || '');
          if (!lv) {
            const versions = await fetchLoaderVersions(deps, loader as LoaderType, mcVersion);
            lv = versions[0] || '';
            if (lv) db.prepare('UPDATE instances SET loader_version = ? WHERE id = ?').run(lv, instanceId);
          }
          if (lv) await installLoader(deps, loader as LoaderType, mcVersion, lv, instDir);
        }
        launchId = findLoaderProfileId(instDir, mcVersion, loader);
        launchJson = path.join(instDir, 'versions', launchId, `${launchId}.json`);
        vanillaProfile = JSON.parse(fs.readFileSync(vanillaJson, 'utf-8')) as VersionProfile;
        loaderProfile = JSON.parse(fs.readFileSync(launchJson, 'utf-8')) as VersionProfile;
      } catch (e2) {
        return { ok: false, error: `Version files are corrupted and could not be repaired automatically. Reinstall this instance. (${e2 instanceof Error ? e2.message : String(e2)})` };
      }
    }
    const versionData = mergeVersionProfiles(loaderProfile, vanillaProfile);

    const clientJar = path.join(instDir, 'versions', vanillaId, `${vanillaId}.jar`);
    // Verify the client jar against its declared SHA-1 too — a corrupt jar
    // (interrupted download) crashes the game on EVERY launch. Auto-heal by
    // re-downloading it here, not just when the file is missing.
    let clientSha1: string | undefined;
    try {
      const vData0 = JSON.parse(fs.readFileSync(vanillaJson, 'utf-8')) as { downloads?: { client?: { sha1?: string } } };
      clientSha1 = vData0.downloads?.client?.sha1;
    } catch { /* ignore */ }
    const clientOk = fs.existsSync(clientJar)
      && (!clientSha1 || (await sha1File(clientJar)).toLowerCase() === clientSha1.toLowerCase());
    if (!clientOk) {
      sendProgress(deps, 'downloading', 0.15, 'Downloading Minecraft client jar...');
      try {
        const vData = JSON.parse(fs.readFileSync(vanillaJson, 'utf-8')) as {
          downloads: { client: { url: string } };
        };
        if (fs.existsSync(clientJar)) { try { fs.unlinkSync(clientJar); } catch { /* ignore */ } }
        await downloadFileRetry(vData.downloads.client.url, clientJar, clientSha1);
      } catch (e) {
        return { ok: false, error: `Failed to download client jar: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // Check and download libraries (with SHA-1 verification to auto-heal corrupt files)
    sendProgress(deps, 'libraries', 0.2, 'Checking libraries...');
    try {
      const libsDir = path.join(instDir, 'libraries');
      for (const lib of versionData.libraries || []) {
        const artifact = lib.downloads?.artifact;
        if (artifact) {
          const libPath = path.join(libsDir, artifact.path);
          const exists = fs.existsSync(libPath);
          const sha1Ok = !exists || !artifact.sha1
            ? exists
            : (await sha1File(libPath)).toLowerCase() === artifact.sha1.toLowerCase();
          if (!sha1Ok) {
            try { fs.unlinkSync(libPath); } catch { /* ignore */ }
          }
          if (!sha1Ok || !exists) {
            try { await downloadFileRetry(artifact.url, libPath, artifact.sha1); } catch (e) {
              logger.warn('Library re-download failed', { lib: artifact.path, error: String(e) });
              // A required library that can't be restored would only crash the
              // game at launch — fail loudly with the reason instead.
              return {
                ok: false,
                error: `Failed to download required library ${artifact.path}: ${e instanceof Error ? e.message : String(e)}. Check your internet connection and try again.`,
              };
            }
          }
          continue;
        }
        // Old-format library (pre-1.6 / loader profiles): url is a maven base.
        // Validate existing files — corrupt ones (HTML, partial) must be
        // replaced or the game classloader will crash.
        if (lib.url && lib.name) {
          const parts = lib.name.split(':');
          if (parts.length >= 3) {
            const base = lib.url.endsWith('/') ? lib.url : lib.url + '/';
            const [group, name, version] = parts;
            const rel = `${group.split('.').join('/')}/${name}/${version}/${name}-${version}`;
            const libPath = path.join(libsDir, ...group.split('.'), name, version, `${name}-${version}.jar`);
            const valid = fs.existsSync(libPath) && isZipFile(libPath);
            if (!valid) {
              try { fs.unlinkSync(libPath); } catch { /* ignore */ }
              try { await downloadFile(base + rel + '.jar', libPath, lib.sha1); } catch { /* may 404 */ }
            }
            const classifier = lib.natives?.[platformKey()];
            if (classifier) {
              const nativePath = path.join(libsDir, ...group.split('.'), name, version, `${name}-${version}-${classifier}.jar`);
              const nativeValid = fs.existsSync(nativePath) && isZipFile(nativePath);
              if (!nativeValid) {
                try { fs.unlinkSync(nativePath); } catch { /* ignore */ }
                try { await downloadFile(base + rel + '-' + classifier + '.jar', nativePath); } catch { /* may 404 */ }
              }
            }
          }
        }
      }
    } catch (e) {
      logger.error('Library check failed', { error: String(e) });
    }

    // Check assets — pre-1.6 versions (alpha/beta) have no assetIndex
    sendProgress(deps, 'assets', 0.3, 'Checking assets...');
    try {
      if (versionData.assetIndex?.url) {
        const assetsDir = path.join(settings.minecraftDirectory, 'assets', 'indexes');
        fs.mkdirSync(assetsDir, { recursive: true });
        const indexPath = path.join(assetsDir, `${versionData.assetIndex.id}.json`);
        if (!fs.existsSync(indexPath)) {
          const indexData = await fetchJson(versionData.assetIndex.url);
          fs.writeFileSync(indexPath, JSON.stringify(indexData));
        }
        // Materialise the legacy virtual tree for pre-1.6 versions
        if (versionData.assetIndex.id === 'pre-1.6') {
          const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
            virtual?: Record<string, unknown>;
            objects?: Record<string, { hash: string; size: number }>;
          };
          materializeLegacyAssets(indexData, path.join(settings.minecraftDirectory, 'assets'));
        }
      }
    } catch (e) {
      logger.error('Asset check failed', { error: String(e) });
    }

    // Authentication
    sendProgress(deps, 'authenticating', 0.5, 'Authenticating...');
    const SESSION_KEY = 'slime_session_token';
    const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
    let authUsername = 'player';
    let authUuid = offlineUuid('player');
    let authToken = '0';

    // Check Microsoft account first — with a REAL access token so the game runs
    // online (multiplayer, skins, capes), not offline with token "0".
    const msAccount = db.prepare('SELECT * FROM microsoft_accounts WHERE is_active = 1').get() as Record<string, unknown> | undefined;
    if (msAccount) {
      authUsername = String(msAccount.username);
      authUuid = dashUuid(String(msAccount.uuid));
      try {
        authToken = await refreshMsTokenIfExpired(deps, msAccount);
      } catch {
        authToken = String(msAccount.access_token || '0');
      }
      if (!/^eyJ/.test(authToken)) {
        return { ok: false, error: 'Microsoft session expired. Please open Accounts, remove this Microsoft account and link it again via Sign In.' };
      }
    } else if (tokenRow) {
      // Check session for offline user
      try {
        const token = JSON.parse(tokenRow.value) as string;
        const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
        if (session) {
          const user = db.prepare('SELECT username FROM users WHERE id = ?').get(session.user_id) as { username: string } | undefined;
          if (user) {
            authUsername = user.username;
            authUuid = offlineUuid(user.username);
          }
        }
      } catch { /* ignore */ }
    }

    // Find Java — prefer the authoritative javaVersion declared in the JSON
    const javaReq = getRequiredJavaVersion(mcVersion, versionData);
    sendProgress(deps, 'java', 0.55, `Finding Java ${javaReq.min}+...`);
    const javaPath = await findOrDownloadJava(deps, inst, settings, logger, versionData);
    if (!javaPath) {
      return { ok: false, error: `Java ${javaReq.min}+ is required for Minecraft ${inst.mc_version}. Please install Java ${javaReq.min} or higher.` };
    }

    // Auto-backup worlds before launch (non-blocking, best effort).
    if (deps.worldBackups.isEnabled()) {
      sendProgress(deps, 'backup', 0.68, 'Backing up worlds...');
      void deps.worldBackups.createForInstance(instanceId, String(inst.name), instDir).catch(() => {});
    }

    // Build and launch
    sendProgress(deps, 'launching', 0.7, 'Launching Minecraft...');
    const ramMB = Number(inst.ram_mb) || settings.defaultRamMB;
    const userJvmArgs = String(inst.jvm_args || settings.jvmArguments);

    const classpath = await buildClasspath(deps, instDir, launchId, vanillaId, versionData);

    // Offline-skins "mod" for MC 1.7–1.12: authlib 1.5.x hardcodes the session
    // server URL and ignores the minecraft.api.*.host properties, so profile
    // and skin requests never reach the local skin server. Patch a copy of
    // that one class to point at the local server and prepend it to the
    // classpath — the patched class wins, and every skin request flows through
    // the launcher (own skins, plus friends' skins relayed over LAN presence).
    // Offline-skins mod, injected per version at launch:
    //  * authlib era (1.7+): if the session URL is hardcoded in authlib (1.5.x
    //    → YggdrasilMinecraftSessionService, 1.6.x/2.x/3.x → YggdrasilEnvironment)
    //    we patch a copy of those classes to point at the local skin server.
    //    Versions that read minecraft.api.*.host (1.16.2+) are a no-op there.
    //  * pre-1.7 (no authlib): skins are fetched directly from hardcoded hosts
    //    (s3.amazonaws.com / skins.minecraft.net) by name, so we patch the
    //    client jar classes that reference them.
    let launchClasspath = classpath;
    if (deps.skinServer.isRunning()) {
      const skinsModDir = path.join(instDir, 'skins-mod');
      const host = deps.skinServer.getSessionHost();

      const authlibEntry = classpath.find((p) => isAuthlibJar(path.basename(p)));
      if (authlibEntry) {
        sendProgress(deps, 'skins', 0.68, 'Adding offline skins support…');
        try {
          fs.mkdirSync(skinsModDir, { recursive: true });
          // Full copy of authlib with the patched classes, named exactly like
          // the original so the JVM derives the same module name. The original
          // is REPLACED on the classpath, not supplemented: modern Forge runs
          // the game as a JPMS module and two jars exporting
          // com.mojang.authlib.yggdrasil would fail with a split-package
          // ResolutionException.
          const patchedJar = path.join(skinsModDir, path.basename(authlibEntry));
          if (patchAuthlibForLocalServer(authlibEntry, patchedJar, host)) {
            launchClasspath = classpath.map((p) => (p === authlibEntry ? patchedJar : p));
            logger.info('Offline skins mod injected (authlib replaced)', { instanceId, patchedJar });
          }
        } catch (e) {
          logger.warn('Offline skins mod injection failed', { error: String(e) });
        }
      } else {
        // Pre-1.7 — patch the client jar's skin-URL classes and prepend the
        // mini-jar (legacy versions run on the plain classpath, where split
        // packages are legal).
        sendProgress(deps, 'skins', 0.68, 'Adding offline skins support…');
        try {
          fs.mkdirSync(skinsModDir, { recursive: true });
          const clientJar = path.join(instDir, 'versions', vanillaId, `${vanillaId}.jar`);
          const patchedClient = path.join(skinsModDir, 'client-skins.jar');
          if (fs.existsSync(clientJar) && patchClientJarForLegacySkins(clientJar, patchedClient, host)) {
            launchClasspath = [patchedClient, ...classpath];
            logger.info('Offline skins mod injected (client patched)', { instanceId, patchedClient });
          }
        } catch (e) {
          logger.warn('Legacy client skins patch failed', { error: String(e) });
        }
      }
    }

    const mainClass = versionData.mainClass || 'net.minecraft.client.main.Main';
    const nativesDir = path.join(instDir, 'natives');
    const javaNativesDir = path.join(nativesDir, 'java');
    fs.mkdirSync(nativesDir, { recursive: true });
    fs.mkdirSync(javaNativesDir, { recursive: true });

    // Newer versions (1.19.3+/22w42a+ and all 26.x) reference the natives root
    // with a `/java` suffix in their JVM args (e.g.
    // `-Djava.library.path=${natives_directory}/java`). For those, the
    // `natives_directory` template must be the *base* natives dir; older
    // versions reference it directly (`-Djava.library.path=${natives_directory}`).
    const usesNativesSubdirs = JSON.stringify(versionData.arguments?.jvm ?? []).includes('${natives_directory}/');

    // Extract natives from jars
    const nativesExtractedMarker = path.join(nativesDir, '.extracted');
    if (!fs.existsSync(nativesExtractedMarker)) {
      sendProgress(deps, 'natives', 0.65, 'Extracting native libraries...');
      const nativePlatform = platformKey();
      const nativeExt = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
      const libsDir = path.join(instDir, 'libraries');

      let nativesOk = true;
      const markFail = () => { nativesOk = false; };
      for (const lib of versionData.libraries || []) {
        // Old-style: classifiers with natives-windows
        const nativesClassifier = lib.downloads?.classifiers?.[`natives-${nativePlatform}`];
        if (nativesClassifier) {
          const jarPath = path.join(libsDir, nativesClassifier.path);
          if (!fs.existsSync(jarPath)) {
            try { await downloadFile(nativesClassifier.url, jarPath); } catch { markFail(); }
          }
          if (!(await extractNativesJar(jarPath, javaNativesDir, nativeExt))) markFail();
          continue;
        }

        // New-style: artifact jar with "natives" in name (e.g. lwjgl-glfw-3.4.1-natives-windows.jar)
        const artifact = lib.downloads?.artifact;
        if (artifact && artifact.path && artifact.path.includes('natives')) {
          // Only extract natives matching THIS machine's architecture. The
          // natives set includes -x86 / -arm64 jars whose DLLs would overwrite
          // the 64-bit ones ("Can't load IA 32-bit .dll on a AMD 64-bit").
          if (!matchesNativeArch(artifact.path)) continue;
          const jarPath = path.join(libsDir, artifact.path);
          if (!fs.existsSync(jarPath)) {
            try { await downloadFile(artifact.url, jarPath); } catch { markFail(); }
          }
          if (!(await extractNativesJar(jarPath, javaNativesDir, nativeExt))) markFail();
          continue;
        }

        // Pre-1.6: natives field + maven base url, no downloads.classifiers.
        // Reconstruct the classifier jar path (e.g. lwjgl-platform-2.9.0-natives-windows.jar).
        const classifier = lib.natives?.[nativePlatform];
        if (classifier && lib.url && lib.name) {
          const parts = lib.name.split(':');
          if (parts.length >= 3) {
            const [group, name, version] = parts;
            const base = lib.url.endsWith('/') ? lib.url : lib.url + '/';
            const rel = `${group.split('.').join('/')}/${name}/${version}/${name}-${version}-${classifier}.jar`;
            const jarPath = path.join(libsDir, ...group.split('.'), name, version, `${name}-${version}-${classifier}.jar`);
            if (!fs.existsSync(jarPath)) {
              try { await downloadFile(base + rel, jarPath); } catch { markFail(); }
            }
            if (!(await extractNativesJar(jarPath, javaNativesDir, nativeExt))) markFail();
          }
        }
      }
      // Only mark natives as extracted when EVERY jar succeeded. Previously the
      // marker was written unconditionally, so a failed first extraction (e.g.
      // PowerShell cold start timing out) was skipped forever and the game kept
      // crashing with missing natives on every later launch.
      if (nativesOk) {
        fs.writeFileSync(nativesExtractedMarker, Date.now().toString());
      } else {
        logger.warn('Native extraction incomplete; will retry on next launch', { instanceId });
      }
    }

    // Download log4j config
    let log4jConfigPath = '';
    const logging = (versionData as { logging?: { client?: { argument?: string; file?: { id?: string; url?: string } } } }).logging;
    if (logging?.client?.file?.url && logging?.client?.file?.id) {
      const logDir = path.join(instDir, 'assets', 'log-configs');
      fs.mkdirSync(logDir, { recursive: true });
      log4jConfigPath = path.join(logDir, logging.client.file.id);
      if (!fs.existsSync(log4jConfigPath)) {
        try { await downloadFile(logging.client.file.url, log4jConfigPath); } catch { /* ignore */ }
      }
    }

    const separator = process.platform === 'win32' ? ';' : ':';
    const classpathStr = launchClasspath.join(separator);

    // Pre-1.6 versions read their resources from the materialised legacy tree
    // (assets/virtual/legacy); everything newer uses the plain assets root.
    const assetsRoot = path.join(settings.minecraftDirectory, 'assets');
    const gameAssetsDir = versionData.assetIndex?.id === 'pre-1.6'
      ? path.join(assetsRoot, 'virtual', 'legacy')
      : assetsRoot;

    // Template variables
    const templates: Record<string, string> = {
      'auth_player_name': authUsername,
      'version_name': String(inst.mc_version),
      'game_directory': instDir,
      'assets_root': assetsRoot,
      'assets_index_name': versionData.assetIndex?.id || String(inst.mc_version),
      'auth_uuid': authUuid,
      'auth_access_token': authToken,
      'auth_session': authToken,
      'clientid': '',
      'auth_xuid': '',
      'user_type': 'msa',
      'version_type': 'SlimeLauncher',
      'natives_directory': usesNativesSubdirs ? nativesDir : javaNativesDir,
      // Old-style aliases (pre-1.6 version JSON uses these names)
      'assets_dir': gameAssetsDir,
      'game_assets': gameAssetsDir,
      'game_dir': instDir,
      'natives_dir': javaNativesDir,
      'auth_uuid_old': '',
      'launcher_name': 'SlimeLauncher',
      'launcher_version': app.getVersion(),
      'classpath': classpathStr,
      'classpath_separator': separator,
      'library_directory': path.join(instDir, 'libraries'),
      'classpath_index': '',
      'user_properties': '{}',
      // Log4j
      'path': log4jConfigPath,
      // Resolution
      'resolution_width': '854',
      'resolution_height': '480',
      // Quick play
      'quickPlayPath': '',
      'quickPlaySingleplayer': '',
      'quickPlayMultiplayer': '',
      'quickPlayRealms': '',
      // Demo
      'demo': '',
    };

    // Resolve a single argument value, handling arrays and template vars
    function resolveValue(val: string | string[] | undefined): string[] {
      if (val === undefined || val === null) return [];
      const arr = Array.isArray(val) ? val : [val];
      return arr.map((v) => {
        if (typeof v !== 'string') return '';
        return v.replace(/\$\{(\w+)\}/g, (_, key: string) => templates[key] ?? '');
      }).filter(Boolean);
    }

    // Build JVM args from version JSON
    const finalJvmArgs: string[] = [
      `-Xmx${ramMB}M`,
      `-Xms${ramMB}M`,
    ];

    // Point the in-game session client at the local skin server so offline
    // players see each other's custom skins (visible only to clients launched
    // from this launcher).
    //
    // authlib only adopts a custom environment when the FULL set of host
    // properties it knows about is present — a lone `session.host` is silently
    // ignored ("Ignoring hosts properties. All need to be set: ..." logged by
    // the game). The required set differs per authlib generation:
    //   authlib 4.x (MC 1.19–1.20):  auth/account/session/services
    //   authlib 7.x (MC 1.21+):      session/services/profiles
    // So pass every property; each version picks the ones it understands and
    // ignores the rest. authlib 1.5.x (MC ≤1.12.2) hardcodes the session URL
    // and ignores all of them (offline skins need a Java agent there).
    const sessionHost = deps.skinServer ? deps.skinServer.getSessionHost() : '';
    if (sessionHost) {
      finalJvmArgs.push(
        `-Dminecraft.api.auth.host=${sessionHost}`,
        `-Dminecraft.api.account.host=${sessionHost}`,
        `-Dminecraft.api.session.host=${sessionHost}`,
        `-Dminecraft.api.services.host=${sessionHost}`,
        `-Dminecraft.api.profiles.host=${sessionHost}`,
      );
    }

    if (versionData.arguments?.jvm && versionData.arguments.jvm.length > 0) {
      for (const jvmArg of versionData.arguments.jvm) {
        // Handle both string and object formats
        if (typeof jvmArg === 'string') {
          finalJvmArgs.push(...resolveValue(jvmArg));
          continue;
        }
        // Check rules if present (skip macOS-only args on Windows, etc.)
        if (jvmArg.rules) {
          let allowed = false;
          for (const rule of jvmArg.rules as Array<{ action: string; os?: { name?: string }; features?: unknown }>) {
            if (rule.action === 'allow') {
              if (rule.os?.name) {
                const osMap: Record<string, string> = { 'osx': 'darwin', 'windows': 'win32', 'linux': 'linux' };
                if (rule.os.name === osMap[process.platform]) allowed = true;
              } else {
                allowed = true;
              }
            }
            if (rule.action === 'deny') {
              allowed = false;
            }
          }
          if (!allowed) continue;
        }
        finalJvmArgs.push(...resolveValue((jvmArg as { value?: string | string[] }).value));
      }
    } else {
      // Old-style: hardcode common JVM args
      finalJvmArgs.push(
        `-Djava.library.path=${javaNativesDir}`,
        '-cp', classpathStr,
      );
    }

    // Add user JVM args
    if (userJvmArgs) {
      finalJvmArgs.push(...userJvmArgs.split(' ').filter(Boolean));
    }

    // Build game args
    const finalGameArgs: string[] = [];

    if (versionData.arguments?.game && versionData.arguments.game.length > 0) {
      for (const gameArg of versionData.arguments.game) {
        // Handle both string and object formats
        if (typeof gameArg === 'string') {
          finalGameArgs.push(...resolveValue(gameArg));
          continue;
        }
        if (gameArg.rules) {
          let allowed = false;
          for (const rule of gameArg.rules as Array<{ action: string; features?: Record<string, boolean> }>) {
            if (rule.action === 'allow') {
              // Features like is_demo_user, has_custom_resolution — just allow simple args
              if (!rule.features || Object.keys(rule.features).length === 0) {
                allowed = true;
              }
            }
          }
          if (!allowed) continue;
        }
        finalGameArgs.push(...resolveValue((gameArg as { value?: string | string[] }).value));
      }
    } else if (versionData.minecraftArguments) {
      // Old-style (pre-1.13): a flat string of `--flag value` pairs. Template
      // placeholders are resolved atomically so paths with spaces (e.g.
      // `C:\Users\Me\My Documents`) stay intact after the space-split.
      finalGameArgs.push(...parseMinecraftArguments(versionData.minecraftArguments, templates));
    } else {
      // Fallback
      finalGameArgs.push(
        '--username', authUsername,
        '--uuid', authUuid,
        '--accessToken', authToken,
        '--gameDir', instDir,
        '--assetsDir', path.join(settings.minecraftDirectory, 'assets'),
        '--assetIndex', versionData.assetIndex?.id || String(inst.mc_version),
        '--version', String(inst.mc_version),
        '--userType', 'msa',
        '--versionType', 'SlimeLauncher',
      );
    }

    const args = [...finalJvmArgs, mainClass, ...finalGameArgs];

    logger.info('Launching Minecraft', { instanceId, javaPath, username: authUsername });
    const child = spawn(javaPath, args, { cwd: instDir, detached: false });
    const consoleSession = settings.showGameConsole ? openGameConsole(String(inst.name)) : null;
    trackProcess(child, deps, instanceId, String(inst.name), instDir, consoleSession);

    // Publish our skin to the remote directory so other launcher players see
    // it even on third-party servers (fire-and-forget, only if enabled).
    try {
      const dashless = authUuid.replace(/-/g, '');
      const byNick = db.prepare('SELECT skin_data, cape_data, variant FROM offline_skins WHERE username = ?').get(authUsername) as
        | { skin_data: string | null; cape_data: string | null; variant: string }
        | undefined;
      const byUuid = !byNick?.skin_data
        ? (db.prepare('SELECT skin_data, cape_data, variant FROM offline_skins WHERE username = ?').get(dashless) as
            | { skin_data: string | null; cape_data: string | null; variant: string }
            | undefined)
        : undefined;
      const row = byNick?.skin_data ? byNick : byUuid;
      if (row?.skin_data) {
        void deps.skinDirectory.publish(authUsername, row.skin_data, row.variant, row.cape_data ?? null);
      }
    } catch { /* best effort */ }

    // Publish LAN presence so friends see what we're playing (and can join a
    // LAN world). The service polls the game log while the process runs.
    try {
      deps.presence.setGame(instDir, mcVersion, loader);
      deps.recorder.startForGame(String(inst.name));
      child.on('exit', () => {
        // Only clear presence when THIS game is still the tracked one —
        // launching a second instance overwrites it, and the first game's
        // exit must not hide the second one from friends.
        if (deps.presence.isCurrentGame(instDir)) deps.presence.clearGame();
        deps.recorder.stopForGame();
      });
    } catch (e) {
      logger.warn('Presence publish failed', { error: String(e) });
    }

    db.prepare('UPDATE instances SET play_count = play_count + 1, last_played_at = ? WHERE id = ?').run(Date.now(), instanceId);
    sendProgress(deps, 'running', 1, `Minecraft is running as ${authUsername}.`);
    notify(deps, { type: 'success', title: 'Minecraft launched', message: `${String(inst.name)} is starting as ${authUsername}.` });
    return { ok: true };
  });
}

async function findOrDownloadJava(
  deps: HandlerDeps,
  inst: Record<string, unknown>,
  settings: { defaultJavaPath: string },
  logger: HandlerDeps['logger'],
  versionData?: { javaVersion?: { majorVersion?: number } },
): Promise<string | null> {
  const mcVersion = String(inst.mc_version || '1.20.1');
  const javaReq = getRequiredJavaVersion(mcVersion, versionData);

  // 1. Check instance-specific Java (verify version)
  if (inst.java_path && fs.existsSync(String(inst.java_path))) {
    const verified = await verifyJavaVersion(String(inst.java_path), javaReq.min, javaReq.max);
    if (verified) return String(inst.java_path);
    logger.warn('Instance Java does not meet version requirement', { javaPath: String(inst.java_path), javaReq });
  }

  // 2. Check settings Java (verify version)
  if (settings.defaultJavaPath && fs.existsSync(settings.defaultJavaPath)) {
    const verified = await verifyJavaVersion(settings.defaultJavaPath, javaReq.min, javaReq.max);
    if (verified) return settings.defaultJavaPath;
    logger.warn('Settings Java does not meet version requirement', { javaPath: settings.defaultJavaPath, javaReq });
  }

  // 3. Auto-detect Java (version-appropriate)
  const detected = await detectJava(javaReq.min, javaReq.max);
  if (detected) {
    logger.info('Auto-detected Java', { path: detected, javaReq, mcVersion });
    return detected;
  }

  // 4. Auto-download the exact Java version needed
  logger.info('Java not found, attempting auto-download', { javaReq, mcVersion });
  sendProgress(deps, 'java', 0.56, `Downloading Java ${javaReq.min}...`);
  try {
    const downloaded = await downloadJava(deps, javaReq.min);
    if (downloaded) {
      logger.info('Java auto-downloaded', { path: downloaded, javaVersion: javaReq.min });
      notify(deps, { type: 'info', title: 'Java downloaded', message: `Java ${javaReq.min} has been installed.` });
      return downloaded;
    }
  } catch (e) {
    logger.error('Java auto-download failed', { error: String(e) });
  }

  return null;
}

async function verifyJavaVersion(javaPath: string, minVersion: number, maxVersion?: number): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const exe = javaPath.endsWith('.exe') || javaPath === 'java' ? javaPath : path.join(javaPath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (!fs.existsSync(exe)) return false;
    // `java -version` prints to stderr (and occasionally stdout) — check both.
    const { stdout, stderr } = await execFileAsync(exe, ['-version'], { timeout: 5000 });
    const output = `${stdout}\n${stderr}`;
    const match = output.match(/version "([^"]+)"/);
    if (!match) return false;
    const ver = match[1];
    let major: number;
    if (ver.startsWith('1.')) {
      major = parseInt(ver.split('.')[1], 10);
    } else {
      major = parseInt(ver.split('.')[0], 10);
    }
    if (major < minVersion) return false;
    if (maxVersion !== undefined && major > maxVersion) return false;
    return true;
  } catch {
    return false;
  }
}

export async function detectJava(minVersion: number = 8, maxVersion?: number): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const candidates: string[] = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    // JAVA_HOME env var
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      candidates.push(path.join(javaHome, 'bin', 'java.exe'));
    }

    // Java directory (Oracle, etc.)
    const javaDir = path.join(programFiles, 'Java');
    if (fs.existsSync(javaDir)) {
      for (const d of fs.readdirSync(javaDir)) {
        candidates.push(path.join(javaDir, d, 'bin', 'java.exe'));
      }
    }
    // 32-bit Java
    const javaDirX86 = path.join(programFilesX86, 'Java');
    if (fs.existsSync(javaDirX86)) {
      for (const d of fs.readdirSync(javaDirX86)) {
        candidates.push(path.join(javaDirX86, d, 'bin', 'java.exe'));
      }
    }
    // Eclipse Adoptium / Temurin
    const adoptiumDir = path.join(programFiles, 'Eclipse Adoptium');
    if (fs.existsSync(adoptiumDir)) {
      for (const d of fs.readdirSync(adoptiumDir)) {
        candidates.push(path.join(adoptiumDir, d, 'bin', 'java.exe'));
      }
    }
    // Microsoft OpenJDK
    const msDir = path.join(programFiles, 'Microsoft');
    if (fs.existsSync(msDir)) {
      for (const d of fs.readdirSync(msDir)) {
        if (d.toLowerCase().includes('jdk') || d.toLowerCase().includes('java')) {
          candidates.push(path.join(msDir, d, 'bin', 'java.exe'));
        }
      }
    }
    // Zulu / Azul
    const zuluDir = path.join(programFiles, 'Zulu');
    if (fs.existsSync(zuluDir)) {
      for (const d of fs.readdirSync(zuluDir)) {
        candidates.push(path.join(zuluDir, d, 'bin', 'java.exe'));
      }
    }
    // Minecraft launcher runtime (has version-specific subdirs like jre-8, jre-17, jre-21)
    const mcRuntime = path.join(home, '.minecraft', 'runtime');
    if (fs.existsSync(mcRuntime)) {
      walkForJava(mcRuntime, candidates, 'java.exe');
    }
    // .slimelauncher runtime (version-specific dirs like jdk-8.0.xxx, jdk-17.0.xxx, jdk-21.0.xxx, or jdk8uXXX)
    const slRuntime = path.join(home, '.slimelauncher', 'runtime');
    if (fs.existsSync(slRuntime)) {
      for (const d of fs.readdirSync(slRuntime)) {
        if (d.startsWith('jdk')) {
          candidates.push(path.join(slRuntime, d, 'bin', 'java.exe'));
        } else {
          walkForJava(path.join(slRuntime, d), candidates, 'java.exe');
        }
      }
    }
    // JetBrains / IntelliJ runtimes
    const jetbrainsDir = path.join(home, '.jdks');
    if (fs.existsSync(jetbrainsDir)) {
      for (const d of fs.readdirSync(jetbrainsDir)) {
        candidates.push(path.join(jetbrainsDir, d, 'bin', 'java.exe'));
      }
    }
    // AppData\Local\Programs (some installers)
    const localPrograms = path.join(home, 'AppData', 'Local', 'Programs');
    if (fs.existsSync(localPrograms)) {
      for (const d of fs.readdirSync(localPrograms)) {
        if (d.toLowerCase().includes('java') || d.toLowerCase().includes('jdk') || d.toLowerCase().includes('jre')) {
          walkForJava(path.join(localPrograms, d), candidates, 'java.exe');
        }
      }
    }
  } else {
    candidates.push('/usr/bin/java', '/usr/local/bin/java');
    // JAVA_HOME on Unix
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      candidates.push(path.join(javaHome, 'bin', 'java'));
    }
    const sdkman = path.join(home, '.sdkman', 'candidates', 'java');
    if (fs.existsSync(sdkman)) {
      for (const d of fs.readdirSync(sdkman)) {
        candidates.push(path.join(sdkman, d, 'bin', 'java'));
      }
    }
  }

  // Check all candidates and return the first one that meets the version requirement
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        // `java -version` prints to stderr (and occasionally stdout) — check both.
        const { stdout, stderr } = await execFileAsync(c, ['-version'], { timeout: 5000 });
        const output = `${stdout}\n${stderr}`;
        const match = output.match(/version "([^"]+)"/);
        if (match) {
          const ver = match[1];
          // Handle "1.8.0_xxx" format → major = 8
          let major: number;
          if (ver.startsWith('1.')) {
            major = parseInt(ver.split('.')[1], 10);
          } else {
            major = parseInt(ver.split('.')[0], 10);
          }
          if (major >= minVersion) {
            if (maxVersion === undefined || major <= maxVersion) {
              return c;
            }
          }
        }
      } catch { /* not java or broken */ }
    }
  }

  // Try PATH java — check version
  try {
    // `java -version` prints to stderr (and occasionally stdout) — check both.
    const { stdout, stderr } = await execFileAsync('java', ['-version'], { timeout: 5000 });
    const output = `${stdout}\n${stderr}`;
    const match = output.match(/version "([^"]+)"/);
    if (match) {
      let major: number;
      if (match[1].startsWith('1.')) {
        major = parseInt(match[1].split('.')[1], 10);
      } else {
        major = parseInt(match[1].split('.')[0], 10);
      }
      if (major >= minVersion && (maxVersion === undefined || major <= maxVersion)) return 'java';
    }
  } catch { /* not found */ }

  return null;
}

async function downloadJava(deps: HandlerDeps, javaMajor: number): Promise<string | null> {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const runtimeDir = path.join(home, '.slimelauncher', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  try {
    const apiUrl = getAdoptiumApiUrl(javaMajor);
    const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';

    // Prefer a JRE (much smaller than a JDK) since Minecraft only needs a
    // runtime; fall back to a full JDK for versions without JRE builds.
    let assets = (await fetchJson(`${apiUrl}?image_type=jre&os=${osName}&architecture=${arch}&vendor=eclipse`)) as Array<{
      binary: { package: { link: string; name: string; size: number }; home?: string };
      version: { semver: string; major: { version: string } };
    }>;
    if (!assets || assets.length === 0) {
      assets = (await fetchJson(`${apiUrl}?image_type=jdk&os=${osName}&architecture=${arch}&vendor=eclipse`)) as typeof assets;
    }
    if (!assets || assets.length === 0) {
      deps.logger.error('No Adoptium assets found', { javaMajor, osName, arch });
      return null;
    }

    const jdk = assets[0];
    const archiveName = jdk.binary.package.name;

    // binary.home is sometimes undefined for older Java versions (e.g. Java 8)
    // Construct a fallback: strip .zip/.tar.gz extension to get dir name
    const extractedDirName = jdk.binary.home || archiveName.replace(/\.(zip|tar\.gz|tgz)$/i, '');
    const javaHome = path.join(runtimeDir, extractedDirName);
    const javaExe = process.platform === 'win32' ? path.join(javaHome, 'bin', 'java.exe') : path.join(javaHome, 'bin', 'java');

    if (fs.existsSync(javaExe)) {
      const works = await verifyJavaVersion(javaExe, javaMajor, javaMajor);
      if (works) {
        deps.logger.info('Java already downloaded', { path: javaExe, javaMajor });
        return javaExe;
      }
      deps.logger.warn('Existing Java binary does not meet requirements, re-downloading', { path: javaExe, javaMajor });
    }

    const archivePath = path.join(runtimeDir, archiveName);

    deps.logger.info('Downloading Java runtime', { version: jdk.version.semver, url: jdk.binary.package.link, javaMajor, extractedDirName });
    sendProgress(deps, 'java', 0.57, `Downloading Java ${javaMajor} (${jdk.version.semver})...`);

    if (!fs.existsSync(archivePath)) {
      const totalBytes = jdk.binary.package.size || 0;
      await downloadFile(
        jdk.binary.package.link,
        archivePath,
        undefined,
        120000,
        (received) => {
          const frac = totalBytes > 0 ? received / totalBytes : 0;
          sendProgress(deps, 'java', 0.57 + Math.min(frac, 1) * 0.05, `Downloading Java ${javaMajor} — ${Math.round(frac * 100)}%`);
        }
      );
    }

    sendProgress(deps, 'java', 0.6, 'Extracting Java...');
    if (process.platform === 'win32') {
      const { execSync } = await import('node:child_process');
      try {
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${runtimeDir}' -Force"`, { timeout: 180000 });
      } catch {
        // Fallback: use tar if PowerShell extraction fails
        try {
          execSync(`tar -xf "${archivePath}" -C "${runtimeDir}"`, { timeout: 180000 });
        } catch {
          deps.logger.error('Both PowerShell Expand-Archive and tar failed for Java extraction');
        }
      }
    } else {
      const { execSync } = await import('node:child_process');
      execSync(`tar -xzf "${archivePath}" -C "${runtimeDir}"`, { timeout: 180000 });
    }

    // Check expected extracted dir first (binary.home), then scan all jdk* dirs
    if (fs.existsSync(javaExe)) {
      const works = await verifyJavaVersion(javaExe, javaMajor, javaMajor);
      if (works) {
        deps.logger.info('Java extracted successfully', { path: javaExe, javaMajor });
        return javaExe;
      }
    }

    // Fallback: scan all dirs starting with jdk — verify exact version match
    const extractedDirs = fs.readdirSync(runtimeDir).filter((d) => d.startsWith('jdk'));
    for (const d of extractedDirs) {
      const candidate = path.join(runtimeDir, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(candidate)) {
        const works = await verifyJavaVersion(candidate, javaMajor, javaMajor);
        if (works) {
          deps.logger.info('Java extracted successfully (fallback scan)', { path: candidate, javaMajor });
          return candidate;
        }
      }
    }

    // Final fallback: scan ALL dirs in runtime for any java binary
    const allDirs = fs.readdirSync(runtimeDir);
    for (const d of allDirs) {
      const candidate = path.join(runtimeDir, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(candidate)) {
        const works = await verifyJavaVersion(candidate, javaMajor, javaMajor);
        if (works) {
          deps.logger.info('Java found in runtime (final fallback)', { path: candidate, javaMajor, dir: d });
          return candidate;
        }
      }
    }
  } catch (e) {
    deps.logger.error('Java download failed', { error: String(e), javaMajor });
  }

  return null;
}

// Captures the game's stdout/stderr while it runs. When a live console session
// is active ("Show game console" setting), output streams into the console
// window in real time. On a crash (non-zero exit, spawn failure, or the game
// vanishing right after start with error output) the console window opens (if
// not already) with the full captured log, the log is written to
// <instance>/logs/slimelauncher-crash.log, and common corrupt-file causes are
// healed for the next launch.
function trackProcess(
  child: ChildProcess,
  deps: HandlerDeps,
  instanceId: string,
  instanceName: string,
  instDir: string,
  consoleSession: number | null,
) {
  const startedAt = Date.now();
  const MAX_OUTPUT = 512 * 1024;
  let outputBuf = '';
  let settled = false;

  const append = (chunk: string) => {
    outputBuf += chunk;
    if (outputBuf.length > MAX_OUTPUT) outputBuf = outputBuf.slice(-MAX_OUTPUT);
    if (consoleSession !== null && activeConsole && activeConsole.session === consoleSession) {
      activeConsole.output = outputBuf;
      pushConsoleLive(consoleSession, chunk);
    }
  };

  const setStatus = (status: ConsoleStatus, exitCode: number | null, title?: string) => {
    if (consoleSession !== null && activeConsole && activeConsole.session === consoleSession) {
      activeConsole.status = status;
      if (exitCode !== null) activeConsole.exitCode = exitCode;
      if (title) activeConsole.title = title;
      pushConsoleStatus(consoleSession, status, exitCode, title);
    }
  };

  child.stdout?.on('data', (d: Buffer) => {
    const msg = d.toString('utf-8');
    append(msg);
    deps.logger.debug(`[mc:${instanceId}] ${msg.trim()}`);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString('utf-8');
    append(msg);
    deps.logger.error(`[mc:${instanceId}] ${msg.trim()}`);
  });

  // Some crashes are caused by a corrupt local file left behind by an earlier
  // interrupted install/download. Heal them so the next launch re-downloads or
  // re-extracts instead of crashing the same way.
  const healAfterCrash = () => {
    try {
      if (/unsatisfiedlinkerror|could not load (native )?library|no lwjgl in java\.library\.path|\b\w+\.dll\b.*(is 32-bit|can't load|could not)/i.test(outputBuf)) {
        const marker = path.join(instDir, 'natives', '.extracted');
        if (fs.existsSync(marker)) {
          fs.unlinkSync(marker);
          deps.logger.warn('Crash points to broken natives — marked for re-extraction', { instanceId });
        }
      }
    } catch { /* best effort */ }
  };

  const handleCrash = (exitCode: number | null, reason: string) => {
    if (settled) return;
    settled = true;
    healAfterCrash();
    let logPath: string | null = null;
    try {
      const logDir = path.join(instDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      logPath = path.join(logDir, 'slimelauncher-crash.log');
      fs.writeFileSync(logPath, outputBuf || 'No output was captured from the game process.');
    } catch { /* best effort */ }

    const crashedAt = Date.now();
    if (consoleSession !== null && activeConsole && activeConsole.session === consoleSession) {
      // Live console already open — turn it into the crash report.
      activeConsole.title = `Minecraft crashed — ${instanceName}`;
      activeConsole.status = 'crashed';
      activeConsole.exitCode = exitCode;
      activeConsole.crashedAt = crashedAt;
      activeConsole.logPath = logPath;
      pushConsoleStatus(consoleSession, 'crashed', exitCode, activeConsole.title);
    } else {
      activeConsole = {
        session: ++consoleSeq,
        title: `Minecraft crashed — ${instanceName}`,
        instanceName,
        output: outputBuf || 'No output was captured from the game process.',
        status: 'crashed',
        exitCode,
        crashedAt,
        logPath,
      };
      getOrCreateConsoleWindow();
    }
    notify(deps, { type: 'error', title: `Minecraft crashed (exit code ${exitCode})`, message: reason, duration: 10000 });
  };

  child.on('exit', (code) => {
    const runtimeMs = Date.now() - startedAt;
    deps.logger.info('Minecraft exited', { instanceId, code, runtimeMs });
    if (settled) return;
    // A crash: non-zero exit, or the game closed within a few seconds of
    // starting while printing error output (e.g. missing natives, bad JVM
    // args that exit 0 but never open a window).
    const looksLikeError = /\b(error|exception|failed|could not|unsatisfiedlink|classnotfound|noclassdeffound)\b/i.test(outputBuf);
    if (code !== 0 || (code === 0 && runtimeMs < 4000 && looksLikeError)) {
      const short = outputBuf.trim().split(/\r?\n/).slice(-8).join('\n').substring(0, 600);
      handleCrash(code, short || `Minecraft exited with code ${code}`);
    } else {
      setStatus('closed', code);
      notify(deps, { type: code === 0 ? 'info' : 'warning', title: 'Minecraft closed', message: `Exit code: ${code}`, duration: 5000 });
    }
  });
  child.on('error', (err) => {
    deps.logger.error('Failed to start Minecraft process', { error: String(err) });
    if (settled) return;
    settled = true;
    const message = `Failed to start the Java process:\n${String(err)}\n\nCheck that the selected Java path exists and is a valid Java installation.`;
    if (consoleSession !== null && activeConsole && activeConsole.session === consoleSession) {
      activeConsole.title = `Minecraft failed to start — ${instanceName}`;
      activeConsole.status = 'crashed';
      activeConsole.exitCode = null;
      activeConsole.crashedAt = Date.now();
      activeConsole.output = outputBuf || message;
      pushConsoleStatus(consoleSession, 'crashed', null, activeConsole.title);
      pushConsoleLive(consoleSession, message + '\n');
    } else {
      activeConsole = {
        session: ++consoleSeq,
        title: `Minecraft failed to start — ${instanceName}`,
        instanceName,
        output: outputBuf || message,
        status: 'crashed',
        exitCode: null,
        crashedAt: Date.now(),
        logPath: null,
      };
      getOrCreateConsoleWindow();
    }
    notify(deps, { type: 'error', title: 'Failed to start Minecraft', message: String(err), duration: 10000 });
  });
}

function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Microsoft profile UUIDs are stored dashless (32 hex chars); the game expects
// the canonical 8-4-4-4-12 dashed form for sessions/skins.
function dashUuid(uuid: string): string {
  const clean = String(uuid).replace(/-/g, '');
  if (clean.length !== 32) return String(uuid);
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

// Old-style (pre-1.13) versions declare game args as a flat string, e.g.
// `--username ${auth_player_name} --session ${auth_session} --gameDir ${game_directory}`.
// We split on whitespace, but resolved template values (file paths!) may contain
// spaces, so placeholders are substituted after the split via unique sentinels.
function parseMinecraftArguments(raw: string, templates: Record<string, string>): string[] {
  // Swap every ${placeholder} for a token guaranteed to contain no whitespace.
  const sentinels: Record<string, string> = {};
  let idx = 0;
  const masked = raw.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const token = `\u0000SLIME${idx++}\u0000`;
    sentinels[token] = templates[key] ?? '';
    return token;
  });
  const tokens = masked.split(/\s+/).filter(Boolean);
  return tokens.map((tok) => sentinels[tok] ?? tok).filter((v) => v !== '');
}

const QUILT_META = 'https://meta.quiltmc.org/v3/versions/loader';

async function fetchLoaderVersions(deps: HandlerDeps, loader: LoaderType, mcVersion: string): Promise<string[]> {
  const { logger } = deps;
  try {
    if (loader === 'fabric') {
      // Unsupported versions return an error object (not an array) from the
      // API — guard so the dropdown just ends up empty instead of crashing.
      const raw = (await fetchJson(`${FABRIC_META}/versions/loader/${mcVersion}`)) as unknown;
      const loaders = Array.isArray(raw) ? (raw as Array<{ loader: { version: string } }>) : [];
      return loaders.map((l) => l.loader.version);
    }
    if (loader === 'forge') {
      const xml = await fetchText(`${FORGE_MAVEN}/maven-metadata.xml`);
      const matches = xml.match(/<version>([^<]+)<\/version>/g) || [];
      return matches
        .map((m) => m.replace(/<\/?version>/g, ''))
        .filter((v) => v.startsWith(`${mcVersion}-`))
        .map((v) => v.replace(`${mcVersion}-`, ''));
    }
    if (loader === 'neoforge') {
      const xml = await fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
      const matches = xml.match(/<version>([^<]+)<\/version>/g) || [];
      return matches.map((m) => m.replace(/<\/?version>/g, '')).filter((v) => v.includes(mcVersion));
    }
    if (loader === 'quilt') {
      // Quilt has no releases for old versions — the API returns an error
      // object instead of an array; treat that as an empty list.
      const raw = (await fetchJson(`${QUILT_META}/${mcVersion}`)) as unknown;
      const loaders = Array.isArray(raw) ? (raw as Array<{ loader: { version: string } }>) : [];
      return loaders.map((l) => l.loader.version);
    }
  } catch (e) {
    logger.error('Failed to fetch loader versions', { error: String(e), loader, mcVersion });
  }
  return [];
}

// --- Vanilla installation ---
async function installVanilla(deps: HandlerDeps, mcVersion: string, baseDir: string, instanceId: string): Promise<void> {
  // Retried fetches: Mojang's piston-meta is throttled/slow at times and a
  // single failed fetch used to abort the entire first-time install.
  const manifest = (await fetchJsonRetry(MC_VERSION_MANIFEST)) as { versions: { id: string; url: string }[] };
  const versionMeta = manifest.versions.find((v) => v.id === mcVersion);
  if (!versionMeta) throw new Error(`Minecraft ${mcVersion} not found in manifest.`);
  const versionData = (await fetchJsonRetry(versionMeta.url)) as {
    downloads?: { client?: { url: string; sha1?: string; size?: number } };
    libraries?: {
      name: string;
      url?: string;
      downloads?: { artifact?: { path: string; url: string; sha1?: string } };
    }[];
    assetIndex?: { id: string; url: string };
    assets?: string;
    mainClass: string;
  };

  const instDir = path.join(baseDir, instanceId);
  const versionDir = path.join(instDir, 'versions', mcVersion);
  fs.mkdirSync(versionDir, { recursive: true });
  writeJsonAtomic(path.join(versionDir, `${mcVersion}.json`), versionData);

  // Client jar — download and wait
  const clientJar = path.join(versionDir, `${mcVersion}.jar`);
  const client = versionData.downloads?.client;
  if (client?.url) {
    if (!fs.existsSync(clientJar) || (client.sha1 && (await sha1File(clientJar)).toLowerCase() !== client.sha1.toLowerCase())) {
      if (fs.existsSync(clientJar)) { try { fs.unlinkSync(clientJar); } catch { /* ignore */ } }
      sendProgress(deps, 'downloading', 0.1, `Downloading Minecraft ${mcVersion} client...`);
      await downloadFileRetry(client.url, clientJar, client.sha1);
    }
  } else {
    throw new Error(`Version JSON for ${mcVersion} has no client download URL.`);
  }

  // Libraries — download and wait
  const libsDir = path.join(instDir, 'libraries');
  const libraries = versionData.libraries || [];
  const platformKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  let libCount = 0;
  const totalLibs = libraries.filter((l) => l.downloads?.artifact).length;
  const progressFor = () => 0.15 + (libCount / Math.max(totalLibs, 1)) * 0.5;
  for (const lib of libraries) {
    const artifact = lib.downloads?.artifact;
    if (artifact) {
      const libPath = path.join(libsDir, artifact.path);
      if (!fs.existsSync(libPath)) {
        libCount++;
        sendProgress(deps, 'libraries', progressFor(), `Downloading library ${libCount}/${totalLibs}...`);
        await downloadFile(artifact.url, libPath, artifact.sha1);
      }
      continue;
    }
    // Old-format library (pre-1.6): { name, url } where url is the maven base URL
    if (lib.url && lib.name) {
      const parts = lib.name.split(':');
      if (parts.length >= 3) {
        const [group, name, version] = parts;
        const base = lib.url.endsWith('/') ? lib.url : lib.url + '/';
        const rel = `${group.split('.').join('/')}/${name}/${version}/${name}-${version}`;
        const libPath = path.join(libsDir, ...group.split('.'), name, version, `${name}-${version}.jar`);
        if (!fs.existsSync(libPath)) {
          libCount++;
          sendProgress(deps, 'libraries', progressFor(), `Downloading library ${libCount}/${totalLibs}...`);
          try {
            await downloadFile(base + rel + '.jar', libPath);
          } catch { /* some old libs 404 — the game may still run */ }
        }
        // Old-format native classifiers (e.g. lwjgl-platform-2.9.0-natives-windows.jar)
        const classifier = (lib as { natives?: Record<string, string> }).natives?.[platformKey];
        if (classifier) {
          const nativePath = path.join(libsDir, ...group.split('.'), name, version, `${name}-${version}-${classifier}.jar`);
          if (!fs.existsSync(nativePath)) {
            try {
              await downloadFile(base + rel + '-' + classifier + '.jar', nativePath);
            } catch { /* native may 404 — launch will retry */ }
          }
        }
      }
    }
  }

  // Asset index — pre-1.6 versions (alpha/beta) have no assetIndex; resources
  // ship inside the client jar, so skip the whole asset step for them.
  const assetIndex = versionData.assetIndex;
  if (assetIndex?.url) {
    const assetsDir = path.join(baseDir, 'assets', 'indexes');
    fs.mkdirSync(assetsDir, { recursive: true });
    const indexPath = path.join(assetsDir, `${assetIndex.id}.json`);
    if (!fs.existsSync(indexPath)) {
      sendProgress(deps, 'assets', 0.65, 'Downloading asset index...');
      const indexData = await fetchJson(assetIndex.url);
      fs.writeFileSync(indexPath, JSON.stringify(indexData));
    }

    // Download asset objects
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
        objects: Record<string, { hash: string; size: number }>;
      };
      const objectsDir = path.join(baseDir, 'assets', 'objects');
      let assetCount = 0;
      const totalAssets = Object.keys(indexData.objects).length;
      for (const [, obj] of Object.entries(indexData.objects)) {
        const hash = obj.hash;
        const prefix = hash.substring(0, 2);
        const objPath = path.join(objectsDir, prefix, hash);
        if (!fs.existsSync(objPath)) {
          assetCount++;
          if (assetCount % 50 === 0) {
            const progress = 0.65 + (assetCount / Math.max(totalAssets, 1)) * 0.3;
            sendProgress(deps, 'assets', progress, `Downloading assets ${assetCount}/${totalAssets}...`);
          }
          try {
            await downloadFile(`https://resources.download.minecraft.net/${prefix}/${hash}`, objPath);
          } catch { /* some assets may fail, that's ok */ }
        }
      }
    } catch (e) {
      deps.logger.error('Asset download failed', { error: String(e) });
    }

    // Pre-1.6 versions reference the legacy 'virtual' asset tree. Materialise it
    // so `--assetsDir assets/virtual/legacy` points at real files (sounds, icons).
    if (assetIndex.id === 'pre-1.6') {
      try {
        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
          virtual?: Record<string, unknown>;
          objects?: Record<string, { hash: string; size: number }>;
        };
        materializeLegacyAssets(indexData, path.join(baseDir, 'assets'));
      } catch (e) {
        deps.logger.error('Legacy asset materialisation failed', { error: String(e) });
      }
    }
  }
}

// Re-creates assets/virtual/legacy from an asset index. Two layouts exist:
//  * newer indexes carry a `virtual` tree whose leaves are object hashes;
//  * the pre-1.6 index has no `virtual` — its `objects` keys are the resource
//    paths themselves (icons/sound/...) which map to hashed objects.
function materializeLegacyAssets(
  index: { virtual?: Record<string, unknown>; objects?: Record<string, { hash: string; size: number }> } | undefined,
  assetsRoot: string,
): void {
  if (!index) return;
  const objectsDir = path.join(assetsRoot, 'objects');
  const virtualDir = path.join(assetsRoot, 'virtual', 'legacy');
  const copyHash = (hash: string, destRel: string) => {
    const src = path.join(objectsDir, hash.slice(0, 2), hash);
    const dest = path.join(virtualDir, destRel);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } catch { /* ignore */ }
    }
  };

  if (index.virtual && typeof index.virtual === 'object') {
    const walk = (node: Record<string, unknown>, rel: string) => {
      for (const [key, val] of Object.entries(node)) {
        if (typeof val === 'string') {
          copyHash(val, path.join(rel, key));
        } else if (val && typeof val === 'object') {
          walk(val as Record<string, unknown>, path.join(rel, key));
        }
      }
    };
    walk(index.virtual, '');
    return;
  }

  if (index.objects && typeof index.objects === 'object') {
    for (const [rel, obj] of Object.entries(index.objects)) {
      if (obj && typeof obj.hash === 'string') copyHash(obj.hash, rel);
    }
  }
}

async function installLoader(deps: HandlerDeps, loader: LoaderType, mcVersion: string, loaderVersion: string, instDir: string): Promise<void> {
  if (loader === 'fabric') {
    const profileUrl = `${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
    const profile = await fetchJson(profileUrl);
    const profilePath = path.join(instDir, 'versions', `${mcVersion}-fabric`, `${mcVersion}-fabric.json`);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    writeJsonAtomic(profilePath, profile);

    // Download Fabric libraries. Their `url` is the maven base — resolve the
    // real artifact jar and verify the sha1 when the profile provides one.
    const profileData = profile as { libraries: { name: string; url: string; sha1?: string }[] };
    const libsDir = path.join(instDir, 'libraries');
    for (const lib of profileData.libraries) {
      if (!lib.url) continue;
      const parts = lib.name.split(':');
      if (parts.length < 3) continue;
      const { url, rel } = mavenJarRef(lib.url, lib.name);
      const libPath = path.join(libsDir, ...rel.split('/'));
      if (!fs.existsSync(libPath) || !isZipFile(libPath)) {
        try { fs.unlinkSync(libPath); } catch { /* ignore */ }
        await downloadFile(url, libPath, lib.sha1);
      }
    }
  } else if (loader === 'forge' || loader === 'neoforge') {
    const base = loader === 'forge' ? FORGE_MAVEN : NEOFORGE_MAVEN;
    const installerUrl = `${base}/${mcVersion}-${loaderVersion}/${loader === 'forge' ? 'forge' : 'neoforge'}-${mcVersion}-${loaderVersion}-installer.jar`;
    const installerPath = path.join(instDir, `${loader}-installer.jar`);
    if (!fs.existsSync(installerPath)) {
      await downloadFile(installerUrl, installerPath);
    }
    // Old-format installers (≈1.5.2–1.12.1; any jar whose install_profile.json
    // carries `versionInfo`) were republished on the current maven as GUI-only
    // jars — they accept no --installClient / --installDir CLI options, so
    // invoking them can never succeed. Install directly from the profile
    // instead (same approach as MultiMC/Prism).
    const profileRaw = readZipEntry(installerPath, 'install_profile.json');
    if (profileRaw) {
      let profile: Record<string, any> | null = null;
      try {
        profile = JSON.parse(profileRaw.toString('utf8')) as Record<string, any>;
      } catch (e) {
        deps.logger.warn('Failed to parse installer profile, falling back to running the jar', { error: String(e) });
      }
      if (profile && profile.versionInfo && typeof profile.versionInfo === 'object') {
        // Old-format installer: running the jar never works (the republished
        // jars are GUI-only and accept no CLI options), so any failure here
        // must surface its own error instead of falling back to the jar.
        await installForgeFromProfile(deps, profile, installerPath, instDir, `${loader} ${mcVersion}-${loaderVersion}`);
        return;
      }
    }
    // The Forge/NeoForge installer refuses to run without a launcher profile:
    // "There is no Minecraft launcher profile in <dir>, you need to run the
    // launcher first!" A minimal launcher_profiles.json satisfies that check
    // and the installer injects its own profile into it as it goes.
    const launcherProfiles = path.join(instDir, 'launcher_profiles.json');
    if (!fs.existsSync(launcherProfiles)) {
      fs.writeFileSync(launcherProfiles, JSON.stringify({ profiles: {}, selectedProfile: null }, null, 2));
    }
    // Run the installer with a suitable Java: prefer the version the game
    // itself needs, then fall back to any Java 8+ (the installer runs fine on
    // Java 8 even for modern versions).
    const javaReq = getRequiredJavaVersion(mcVersion);
    const javaPath =
      (await detectJava(javaReq.min)) ||
      (await detectJava(17)) ||
      (await detectJava(8));
    if (!javaPath) {
      throw new Error('Java is required to run the Forge/NeoForge installer. Install any Java 8+.');
    }
    const { spawn } = await import('node:child_process');
    // Modern installers accept --installClient; older ones used --installDir.
    // Try each until one succeeds. The installer downloads ~80 MB of client
    // jar plus libraries, so run it with a live progress pulse — otherwise the
    // install modal sits on one stage and looks frozen.
    const attempts: string[][] = [
      ['-jar', installerPath, '--installClient', instDir],
      ['-jar', installerPath, '--install-client', instDir],
      ['-jar', installerPath, '--installDir', instDir],
    ];
    let lastErr = '';
    for (const args of attempts) {
      const result = await runInstaller(deps, javaPath, args, `${loader} ${mcVersion}-${loaderVersion}`);
      if (result === true) {
        lastErr = '';
        break;
      }
      lastErr = 'stderr' in result ? result.stderr.slice(-800) : result.error;
      deps.logger.warn(`${loader} installer attempt failed`, { args: args[2], error: lastErr.slice(0, 400) });
    }
    if (lastErr) {
      throw new Error(`${loader} installer failed for ${mcVersion}-${loaderVersion}: ${lastErr.slice(0, 600)}`);
    }
    // The installer wrote versions/<mc>-<loader>-<ver>/ itself and downloaded
    // all Forge libraries into libraries/. Nothing more to do — the launch
    // profile scan picks the folder up automatically.
  } else if (loader === 'quilt') {
    const profileUrl = `${QUILT_META}/${mcVersion}/${loaderVersion}/profile/json`;
    const profile = await fetchJson(profileUrl);
    const profilePath = path.join(instDir, 'versions', `${mcVersion}-quilt`, `${mcVersion}-quilt.json`);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    writeJsonAtomic(profilePath, profile);

    // Download Quilt libraries (same maven-base format as Fabric)
    const profileData = profile as { libraries: { name: string; url: string; sha1?: string }[] };
    const libsDir = path.join(instDir, 'libraries');
    for (const lib of profileData.libraries) {
      if (!lib.url) continue;
      const parts = lib.name.split(':');
      if (parts.length < 3) continue;
      const { url, rel } = mavenJarRef(lib.url, lib.name);
      const libPath = path.join(libsDir, ...rel.split('/'));
      if (!fs.existsSync(libPath) || !isZipFile(libPath)) {
        try { fs.unlinkSync(libPath); } catch { /* ignore */ }
        await downloadFile(url, libPath, lib.sha1);
      }
    }
  }
}

// Extracts a single entry (e.g. install_profile.json, the bundled universal
// jar) from a Forge installer jar. Minimal ZIP reader: parses the end-of-
// central-directory record, walks the central directory, and inflates the
// entry — no external dependency needed for a file we control the layout of.
function readZipEntry(jarPath: string, entryName: string): Buffer | null {
  try {
    const buf = fs.readFileSync(jarPath);
    // EOCD: scan backwards from the end (comment is at most 64 KB).
    let eocd = -1;
    const start = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= start; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdEnd = cdOffset + buf.readUInt32LE(eocd + 12);
    let pos = cdOffset;
    while (pos + 46 <= cdEnd && buf.readUInt32LE(pos) === 0x02014b50) {
      const method = buf.readUInt16LE(pos + 10);
      const compSize = buf.readUInt32LE(pos + 20);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localOffset = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
      if (name === entryName) {
        if (localOffset + 30 > buf.length) return null;
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const data = buf.subarray(localOffset + 30 + lNameLen + lExtraLen, localOffset + 30 + lNameLen + lExtraLen + compSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        return null; // unsupported compression method
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
  } catch {
    /* not a readable zip */
  }
  return null;
}

// Installs an old-format Forge profile without running the installer jar:
// extracts the bundled universal jar, downloads the declared libraries and
// writes the version profile JSON. Libraries are rewritten with an explicit
// `downloads.artifact` so the launch code (classpath + verification) uses the
// exact same paths — including NO-URL libraries, which the old profiles list
// without a mirror and which live on Mojang's libraries server.
async function installForgeFromProfile(
  deps: HandlerDeps,
  profile: Record<string, any>,
  installerPath: string,
  instDir: string,
  label: string,
): Promise<void> {
  const install = (profile.install || {}) as Record<string, any>;
  const versionInfo = profile.versionInfo as Record<string, any>;
  const profileId = String(versionInfo.id || '');
  if (!profileId) throw new Error('Forge installer profile has no version id.');

  const libsDir = path.join(instDir, 'libraries');
  const profileDir = path.join(instDir, 'versions', profileId);
  fs.mkdirSync(profileDir, { recursive: true });

  // The bundled Forge universal jar: install.path is `group:artifact:version`
  // and install.filePath is the jar name (e.g. forge-…-universal.jar). Old
  // installers carry it inside the installer jar itself.
  const forgePath = String(install.path || '');
  const [fGroup, fArtifact, fVersion] = forgePath.split(':');
  const forgeRel = fGroup && fArtifact && fVersion
    ? `${fGroup.split('.').join('/')}/${fArtifact}/${fVersion}/${install.filePath || `${fArtifact}-${fVersion}.jar`}`
    : null;
  const forgeFileName = String(install.filePath || '');

  // Extract the bundled Forge universal jar first, so its presence doesn't
  // depend on the library list in the profile.
  let forgeRelPlaced: string | null = null;
  if (forgeRel) {
    const dest = path.join(libsDir, ...forgeRel.split('/'));
    if (!fs.existsSync(dest)) {
      const bundled = forgeFileName ? readZipEntry(installerPath, forgeFileName) : null;
      if (bundled) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bundled);
        forgeRelPlaced = forgeRel;
        deps.logger.info('Forge universal jar extracted', { path: forgeRel });
      }
    } else {
      forgeRelPlaced = forgeRel;
    }
    if (!forgeRelPlaced) {
      // Some installers don't bundle it — fall back to the forge maven.
      const dest = path.join(libsDir, ...forgeRel.split('/'));
      await downloadFile(`${FORGE_MAVEN}/${forgeRel}`, dest);
      forgeRelPlaced = forgeRel;
    }
  }

  // versionInfo.libraries + install.libraries, deduplicated by name.
  const libs: Array<Record<string, any>> = [];
  for (const lib of [...(versionInfo.libraries || []), ...(install.libraries || [])]) {
    if (lib && lib.name && !libs.some((l) => l.name === lib.name)) libs.push(lib);
  }

  const resolved: Array<Record<string, any>> = [];
  let idx = 0;
  for (const lib of libs) {
    const name = String(lib.name || '');
    const parts = name.split(':');
    if (parts.length < 3) continue;
    const [group, artifact, version] = parts;
    idx += 1;
    sendProgress(deps, 'loader', 0.6 + Math.min(idx / Math.max(libs.length, 1), 1) * 0.25, `${label} — installing ${artifact} ${version}…`);

    // Natives-only libraries (lwjgl-platform, jinput-platform on 1.6.x) ship
    // no plain jar — only classifier jars. Keep them in the profile (with a
    // mirror URL) so the launcher's natives extraction downloads the right
    // classifier at launch. The forge jar itself never has a natives field.
    if (lib.natives) {
      resolved.push({ ...lib, url: String(lib.url || 'https://libraries.minecraft.net/') });
      continue;
    }

    let rel: string;
    let url: string;
    if (forgeRel && name === forgePath) {
      // Forge universal jar — already placed above; just record its path.
      rel = forgeRel;
      url = `${FORGE_MAVEN}/${rel}`;
    } else {
      rel = `${group.split('.').join('/')}/${artifact}/${version}/${artifact}-${version}.jar`;
      const base = lib.url
        ? (String(lib.url).endsWith('/') ? String(lib.url) : `${String(lib.url)}/`)
        : 'https://libraries.minecraft.net/';
      url = `${base}${rel}`;
      const dest = path.join(libsDir, ...rel.split('/'));
      if (!fs.existsSync(dest) || !isZipFile(dest)) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        await downloadFile(url, dest);
      }
    }
    resolved.push({
      ...lib,
      url: String(lib.url || 'https://libraries.minecraft.net/'),
      downloads: {
        artifact: {
          path: rel,
          url,
        },
      },
    });
  }

  writeJsonAtomic(path.join(profileDir, `${profileId}.json`), { ...versionInfo, libraries: resolved }, 2);
  deps.logger.info('Forge installed from profile', { profileId, libraries: resolved.length });
}

// Runs the Forge/NeoForge installer as a child process, streaming its output
// to the log and reporting a live progress pulse so the install modal doesn't
// look frozen while the ~80 MB client jar and libraries download. Returns true
// on success, or an object with the captured stderr when it fails.
async function runInstaller(
  deps: HandlerDeps,
  javaPath: string,
  args: string[],
  label: string,
): Promise<true | { stderr: string } | { error: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: true | { stderr: string } | { error: string }) => { if (!settled) { settled = true; resolve(v); } };
    const child = spawn(javaPath, args, { windowsHide: true });
    let stderrBuf = '';
    let stdoutBuf = '';

    // Pulse every 2s so the UI sees movement regardless of what the installer
    // prints (its progress bars use \r and are not line-delimited).
    let pulse = 0.7;
    const timer = setInterval(() => {
      pulse = Math.min(pulse + 0.02, 0.97);
      sendProgress(deps, 'loader', pulse, `${label} — installing (downloading libraries…)`);
    }, 2000);

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      // Parse the installer's own stage lines for nicer progress messages.
      const lines = stdoutBuf.split(/\r?\n/).filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (last && /^(Downloading|Extracting|Copying|Patching|Injecting|Considering)/i.test(last.trim())) {
        sendProgress(deps, 'loader', pulse, `${label} — ${last.trim().substring(0, 90)}`);
      }
      if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-16384);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-16384);
    });

    child.on('error', (err) => finish({ error: `Failed to start installer: ${String(err)}` }));
    child.on('close', (code) => {
      clearInterval(timer);
      if (code === 0) {
        deps.logger.info('Installer finished', { label, tail: stderrBuf.slice(-400) });
        finish(true);
      } else {
        deps.logger.error('Installer exited non-zero', { label, code, tail: stderrBuf.slice(-1200) });
        finish({ stderr: stderrBuf.slice(-1200) || 'Installer exited with an unknown error.' });
      }
    });
  });
}

// Returns the version-folder id used for launching. Vanilla uses the plain
// mc version; loader instances use their profile folder (fabric → <mc>-fabric,
// forge → <mc>-forge-<version>, …). Falls back to the vanilla id if the loader
// profile is missing so the instance can still be re-installed on launch.
function findLoaderProfileId(instDir: string, mcVersion: string, loader: string): string {
  if (loader === 'vanilla') return mcVersion;
  const versionsDir = path.join(instDir, 'versions');
  if (fs.existsSync(versionsDir)) {
    // Old-format Forge profiles are named e.g. `1.7.10-Forge10.13.4.1614-1.7.10`
    // (capital F), while the prefix here is lowercase — compare case-insensitively.
    const prefix = `${mcVersion}-${loader}`.toLowerCase();
    const match = fs.readdirSync(versionsDir).find((d) => d.toLowerCase().startsWith(prefix));
    if (match) return match;
  }
  return mcVersion;
}

// Builds the classpath from the merged version profile's declared libraries —
// never by scanning the libraries directory. Scanning pulls in stale/foreign
// jars (duplicate jopt-simple/asm versions left by earlier installs) which
// crash the JVM module system on Forge/NeoForge with ResolutionException.
// Natives jars are excluded here — they are extracted to the natives dir
// instead of being placed on the classpath.
async function buildClasspath(
  deps: HandlerDeps,
  instDir: string,
  launchId: string,
  vanillaId: string,
  versionData: VersionProfile,
): Promise<string[]> {
  const jar = path.join(instDir, 'versions', launchId, `${launchId}.jar`);
  const fallbackJar = path.join(instDir, 'versions', vanillaId, `${vanillaId}.jar`);
  const libsDir = path.join(instDir, 'libraries');
  const libs: string[] = [fs.existsSync(jar) ? jar : fallbackJar];
  const seen = new Set<string>();

  for (const lib of versionData.libraries || []) {
    let rel: string | undefined;
    const artifact = lib.downloads?.artifact;
    if (artifact?.path) {
      rel = artifact.path;
    } else if (lib.url && lib.name) {
      // Old-format library: url is a maven base, derive the relative path.
      const parts = lib.name.split(':');
      if (parts.length >= 3) {
        const [group, name, version] = parts;
        rel = `${group.split('.').join('/')}/${name}/${version}/${name}-${version}.jar`;
      }
    }
    if (!rel) continue;
    // Natives classifiers never belong on the classpath.
    if (rel.includes('-natives-') || rel.includes('natives-')) continue;
    const full = path.join(libsDir, rel);
    if (fs.existsSync(full) && !seen.has(full)) {
      seen.add(full);
      libs.push(full);
    }
  }
  return libs;
}

// Natives jars come in per-architecture flavours: `lwjgl-...-natives-windows.jar`
// (x64), `...-natives-windows-x86.jar` (32-bit) and `...-natives-windows-arm64.jar`.
// Extracting all of them would overwrite the x64 DLLs with 32-bit ones and
// crash with "Can't load IA 32-bit .dll on a AMD 64-bit platform". Only the
// jars for the current architecture should ever be extracted.
function matchesNativeArch(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const arch = process.arch; // 'x64' | 'ia32' | 'arm64'
  const hasArm = lower.includes('arm64');
  const hasX86 = lower.includes('-x86') || lower.includes('-x86.');
  if (arch === 'arm64') return hasArm;
  if (arch === 'ia32') return hasX86;
  // x64 — accept plain `natives-windows.jar` and reject x86/arm64 variants.
  return !hasX86 && !hasArm;
}

// Natives jars are extracted with an async child process so the Electron main
// process (and the whole UI) is never blocked — the old `execSync` froze the
// launcher for the full extraction and could time out on a cold PowerShell
// start. Returns whether extraction succeeded so the caller only writes the
// "extracted" marker when every jar actually made it.
async function extractNativesJar(jarPath: string, destDir: string, nativeExt: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    if (process.platform === 'win32') {
      // PowerShell ZipFile to extract native files from jar (zip format).
      // ExtractToFile is an extension method on ZipFileExtensions — calling it
      // directly on the ZipArchive object fails with "MethodNotFound" in
      // PowerShell, which silently swallowed every native extraction and left
      // the game with an empty natives dir (UnsatisfiedLinkError: lwjgl.dll).
      const script = `Add-Type -Assembly System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${jarPath.replace(/'/g, "''")}'); foreach($e in $z.Entries){if($e.Name.EndsWith('${nativeExt}')){[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,(Join-Path '${destDir.replace(/'/g, "''")}' $e.Name),$true)}};$z.Dispose()`;
      await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 120000, windowsHide: true });
    } else {
      await execFileAsync('unzip', ['-j', '-o', jarPath, `*${nativeExt}`, '-d', destDir], { timeout: 120000 });
    }
    return true;
  } catch {
    return false;
  }
}

function walkForJava(dir: string, out: string[], exeName: string, depth = 0) {
  if (depth > 5) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === exeName) {
        out.push(path.join(dir, entry.name));
        return;
      }
      if (entry.isDirectory()) {
        walkForJava(path.join(dir, entry.name), out, exeName, depth + 1);
      }
    }
  } catch { /* ignore permission errors */ }
}
