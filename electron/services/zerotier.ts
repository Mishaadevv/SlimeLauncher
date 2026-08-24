import fs from 'node:fs';
import path from 'node:path';
import { execFile, exec, spawn } from 'node:child_process';
import https from 'node:https';
import { app } from 'electron';
import type { Logger } from './logger.js';

// ZeroTier is a free, open-source VPN that works like Radmin VPN (virtual
// LAN over the internet). The launcher offers to install it (official MSI
// from zerotier.com) so users can play across countries without buying a
// server. Radmin VPN itself is proprietary and cannot be bundled.

const MSI_URL = 'https://download.zerotier.com/dist/ZeroTier%20One.msi';
const REG_KEY = 'HKCU\\Software\\SlimeLauncher';

const CLI_CANDIDATES = [
  'C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-cli.exe',
  'C:\\Program Files\\ZeroTier\\One\\zerotier-cli.exe',
];

// The registry/service checks spawn processes, so cache their result for a
// few seconds — the renderer polls `status` while the Network page is open.
let _deepCheckCache: { value: boolean; at: number } | null = null;

function runCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 6000 }, (err) => resolve(!err));
  });
}

// ZeroTier's MSI registers an uninstall entry and its own HKLM key, so a
// previously installed copy is detected even when the CLI lives in a
// non-default location or on another drive.
async function registryHasZeroTier(): Promise<boolean> {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    if (await runCheck('reg', ['query', root, '/s', '/f', 'ZeroTier'])) return true;
  }
  if (await runCheck('reg', ['query', 'HKLM\\SOFTWARE\\ZeroTier\\One'])) return true;
  if (await runCheck('reg', ['query', 'HKLM\\SOFTWARE\\ZeroTier, Inc.\\One'])) return true;
  return false;
}

// Returns true when ZeroTier is not only installed but has at least one
// network in 'OK' / 'CONNECTED' status — meaning it is actually providing
// a virtual LAN.
let _connectedCache: { value: boolean; at: number } | null = null;

export async function isZeroTierConnected(): Promise<boolean> {
  try {
    const installed = await isZeroTierInstalled();
    if (!installed) return false;
    // Cache for 4 seconds (renderer polls while the Network page is open).
    if (_connectedCache && Date.now() - _connectedCache.at < 4000) {
      return _connectedCache.value;
    }
    const cli = await findZeroTierCli();
    if (!cli) { _connectedCache = { value: false, at: Date.now() }; return false; }
    return await new Promise((resolve) => {
      execFile(cli, ['listnetworks'], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        if (err) { _connectedCache = { value: false, at: Date.now() }; resolve(false); return; }
        // Lines look like: 200 listnetworks <nwid> <name> <mac> OK <type> <dev> <ips> ...
        // Any line containing 'OK' or 'CONNECTED' means an active network.
        const connected = /\b(OK|CONNECTED)\b/.test(stdout);
        _connectedCache = { value: connected, at: Date.now() };
        resolve(connected);
      });
    });
  } catch {
    _connectedCache = { value: false, at: Date.now() };
    return false;
  }
}

// Detects whether Radmin VPN is running by checking for its well-known
// process names and the virtual network adapter it creates.
// Uses `exec` via cmd.exe instead of `execFile` because `tasklist` and
// `netsh` may not resolve with `execFile` on some Windows configurations
// (spawns EINVAL).
let _radminCache: { value: boolean; at: number } | null = null;

function shellCheck(command: string, timeout = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout }, (_err, stdout) => {
      resolve(!_err && !!stdout && stdout.length > 0);
    });
  });
}

function shellStdout(command: string, timeout = 6000): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout }, (_err, stdout) => {
      resolve(stdout || '');
    });
  });
}

export async function isRadminVpnRunning(): Promise<boolean> {
  if (_radminCache && Date.now() - _radminCache.at < 4000) {
    return _radminCache.value;
  }
  try {
    const [procFound, adapterOutput] = await Promise.all([
      // Check for Radmin VPN process (try both known executable names)
      shellCheck('tasklist /FI "IMAGENAME eq RadminVPN.exe" /NH').then(
        (ok) => ok || shellCheck('tasklist /FI "IMAGENAME eq radmin_vpn.exe" /NH'),
      ),
      // Check network adapters for Radmin
      shellStdout('netsh interface show interface'),
    ]);
    const adapterFound = /Radmin/i.test(adapterOutput);
    const value = procFound || adapterFound;
    _radminCache = { value, at: Date.now() };
    return value;
  } catch {
    _radminCache = { value: false, at: Date.now() };
    return false;
  }
}

export async function isZeroTierInstalled(force = false): Promise<boolean> {
  try {
    // Fast path: check well-known install locations synchronously.
    const onDisk = CLI_CANDIDATES.some((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (onDisk) return true;
    // Slow path (registry / service / PATH) — run at most once per 5 seconds
    // unless forced (e.g. right after an install attempt).
    if (!force && _deepCheckCache && Date.now() - _deepCheckCache.at < 5000) {
      return _deepCheckCache.value;
    }
    const [inPath, regFound, svcFound] = await Promise.all([
      runCheck('where.exe', ['zerotier-cli']),
      registryHasZeroTier(),
      runCheck('sc.exe', ['query', 'ZeroTierService']).then((ok) => ok || runCheck('sc.exe', ['query', 'ZeroTierOneService'])),
    ]);
    const value = inPath || regFound || svcFound;
    _deepCheckCache = { value, at: Date.now() };
    return value;
  } catch {
    return false;
  }
}

async function findZeroTierCli(): Promise<string | null> {
  for (const p of CLI_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return await new Promise((resolve) => {
    execFile('where.exe', ['zerotier-cli'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

// Returns the IPv4/IPv6 addresses ZeroTier assigned to this machine on its
// connected networks (e.g. 10.147.x.x / fdxx::). These are reachable from
// any machine on the same ZeroTier network, so the network key can advertise
// them alongside the LAN address for cross-network play.
export async function getZeroTierIps(): Promise<string[]> {
  const cli = await findZeroTierCli();
  if (!cli) return [];
  return await new Promise((resolve) => {
    execFile(cli, ['listnetworks'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const ips = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const tokens = line.trim().split(/\s+/);
        // Columns: 200 listnetworks <nwid> <name> <mac> <status> <type> <dev>
        // <assigned ips> <managed ips> ... — the MAC token is the first one in
        // the MAC format, so names with spaces don't shift the columns.
        const macIdx = tokens.findIndex((t) => /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(t));
        if (macIdx === -1) continue;
        const assigned = tokens[macIdx + 4];
        if (!assigned || assigned === '-') continue;
        for (const raw of assigned.split(',')) {
          const ip = raw.replace(/\/\d+$/, '').trim();
          if (!ip || ip === '-' || ip.startsWith('fe80')) continue;
          ips.add(ip);
        }
      }
      resolve([...ips]);
    });
  });
}

export async function installRadminVpn(
  logger: Logger,
  onProgress?: (pct: number, label: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const toolsDir = path.join(app.getPath('userData'), 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const exePath = path.join(toolsDir, 'radmin-vpn.exe');
    if (!fs.existsSync(exePath)) {
      onProgress?.(5, 'Downloading Radmin VPN installer...');
      // Use the official download link
      await downloadFile('https://download.radmin-vpn.com/download/files/Radmin_VPN_2.0.4899.9.exe', exePath, (pct) => onProgress?.(5 + Math.round(pct * 60), 'Downloading Radmin VPN installer...'));
    } else {
      onProgress?.(60, 'Radmin VPN installer already downloaded');
    }
    onProgress?.(70, 'Installing Radmin VPN (confirm the Windows prompt)...');
    
    // Run the installer (interactive, as silent install flags vary and we want the user to see it)
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(exePath, [], { windowsHide: false, detached: true });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`installer exited with code ${code}`));
      });
    });
    
    try { fs.unlinkSync(exePath); } catch { /* ignore */ }
    onProgress?.(100, 'Radmin VPN installed');
    return { ok: true };
  } catch (e) {
    logger.error('Radmin VPN install failed', { error: String(e) });
    return { ok: false, error: String(e) };
  }
}

export async function installZeroTier(
  logger: Logger,
  onProgress?: (pct: number, label: string) => void,
): Promise<{ ok: boolean; error?: string; installed?: boolean }> {
  try {
    if (await isZeroTierInstalled(true)) {
      onProgress?.(100, 'ZeroTier already installed');
      return { ok: true, installed: true };
    }
    const toolsDir = path.join(app.getPath('userData'), 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const msiPath = path.join(toolsDir, 'zerotier.msi');
    if (!fs.existsSync(msiPath)) {
      onProgress?.(5, 'Downloading ZeroTier installer...');
      await downloadFile(MSI_URL, msiPath, (pct) => onProgress?.(5 + Math.round(pct * 60), 'Downloading ZeroTier installer...'));
    } else {
      // Reuse the previously downloaded MSI — never re-download on retry.
      onProgress?.(60, 'ZeroTier installer already downloaded');
    }
    onProgress?.(70, 'Installing ZeroTier (confirm the Windows prompt)...');
    await runMsiElevated(msiPath);
    // msiexec succeeded — verify with a fresh detection before reporting.
    const installed = await isZeroTierInstalled(true);
    if (installed) {
      try { fs.unlinkSync(msiPath); } catch { /* ignore */ }
      onProgress?.(100, 'ZeroTier installed');
      return { ok: true, installed: true };
    }
    // Installer reported success but the CLI is not visible yet (e.g. the
    // service needs a moment to start). Keep the MSI and tell the user.
    onProgress?.(100, 'ZeroTier installed — restart the app if it is not detected');
    return { ok: true, installed: false };
  } catch (e) {
    logger.error('ZeroTier install failed', { error: String(e) });
    // Keep the downloaded MSI on failure so a retry does not re-download it.
    return { ok: false, error: String(e) };
  }
}

// Reads the "install ZeroTier" marker left by the NSIS installer checkbox.
export async function hasInstallMarker(): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY, '/v', 'installZeroTier'], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

export function clearInstallMarker() {
  execFile('reg', ['delete', REG_KEY, '/v', 'installZeroTier', '/f'], { windowsHide: true }, () => { /* ignore */ });
}

export async function hasRadminInstallMarker(): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY, '/v', 'installRadmin'], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

export function clearRadminInstallMarker() {
  execFile('reg', ['delete', REG_KEY, '/v', 'installRadmin', '/f'], { windowsHide: true }, () => { /* ignore */ });
}

function downloadFile(url: string, dest: string, onProgress?: (pct: number) => void, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { fail(new Error('too many redirects')); return; }
        downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress, redirects - 1)
          .then(resolve, fail);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        received += c.length;
        if (total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)));
      });
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', fail);
      res.on('error', fail);
    });
    req.setTimeout(30000, () => req.destroy(new Error('download timeout')));
    req.on('error', fail);
  });
}

// Runs the MSI with elevation (UAC prompt) and waits for completion.
// The path may contain spaces ("Misha Krutoj"), so it must be quoted inside
// the PowerShell command line — Start-Process joins plain arguments with
// spaces without re-quoting, which makes msiexec fail with 1639.
function runMsiElevated(msiPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const psCmd = `$p = Start-Process -FilePath msiexec -ArgumentList "/i \`"${msiPath}\`" /qn /norestart" -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('installer timed out'));
    }, 8 * 60 * 1000);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 3010) {
        resolve();
      } else if (code === 1602) {
        reject(new Error('installation was cancelled (UAC declined)'));
      } else if (code === 1603) {
        reject(new Error('Windows Installer reported a fatal error during installation'));
      } else {
        reject(new Error(`installer exited with code ${code}`));
      }
    });
  });
}