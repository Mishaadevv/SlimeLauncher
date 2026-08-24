import { app, BrowserWindow, ipcMain, shell, nativeImage, Tray, Menu, dialog, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPC } from '../shared/ipc.js';

// Some environments (e.g. nvm-for-windows, CI) leave ELECTRON_RUN_AS_NODE=1 in
// the user's environment. When set, Electron boots as a plain Node.js process
// and `require('electron')` returns the path string instead of the API — which
// manifests as a black screen (the window is never created). Strip it early so
// the app always runs as a real Electron process, and so it is not inherited
// by child processes we spawn (e.g. Minecraft).
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}
import { registerWindowHandlers } from './handlers/window.js';
import { registerSettingsHandlers } from './handlers/settings.js';
import { registerAuthHandlers } from './handlers/auth.js';
import { registerAccountsHandlers } from './handlers/accounts.js';
import { registerInstanceHandlers } from './handlers/instances.js';
import { registerModHandlers } from './handlers/mods.js';
import { registerModpackHandlers } from './handlers/modpacks.js';
import { registerMapHandlers } from './handlers/maps.js';
import { registerMcHandlers } from './handlers/minecraft.js';
import { registerJavaHandlers } from './handlers/java.js';
import { registerDownloadHandlers } from './handlers/downloads.js';
import { registerFsHandlers } from './handlers/fs.js';
import { registerMsHandlers } from './handlers/microsoft.js';
import { registerSkinHandlers } from './handlers/skins.js';
import { registerFriendsHandlers } from './handlers/friends.js';
import { registerRecordingHandlers } from './handlers/recordings.js';
import { registerNetworkHandlers, getNetworkService } from './handlers/network.js';
import { registerWorldBackupsHandlers } from './handlers/world-backups.js';
import { registerServerHandlers } from './handlers/servers.js';
import { registerZeroTierHandlers } from './handlers/zerotier.js';
import { hasInstallMarker, clearInstallMarker, isZeroTierInstalled, installZeroTier, hasRadminInstallMarker, clearRadminInstallMarker, installRadminVpn } from './services/zerotier.js';
import { notify } from './handlers/types.js';
import type { HandlerDeps } from './handlers/types.js';
import { DatabaseService } from './services/database.js';
import { SettingsStore } from './services/settings-store.js';
import { DownloadManager } from './services/download-manager.js';
import { SkinServer } from './services/skin-server.js';
import { SkinDirectory } from './services/skin-directory.js';
import { PresenceService } from './services/presence.js';
import { RecorderService } from './services/recorder.js';
import { WorldBackupsService } from './services/world-backups.js';
import { DedicatedServerService } from './services/dedicated-server.js';
import { DiscordRpcService } from './services/discord-rpc.js';
import type { PresenceSnapshot } from '../shared/types.js';
import { Logger } from './services/logger.js';
import { autoUpdater } from 'electron-updater';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const logger = new Logger();
const db = new DatabaseService(logger);
const settingsStore = new SettingsStore(db);
const downloadManager = new DownloadManager(settingsStore, logger);
const skinServer = new SkinServer(db, settingsStore, logger);
const skinDirectory = new SkinDirectory(db, logger);
skinServer.setSkinDirectory(skinDirectory);
const presence = new PresenceService(db, logger);
const recorder = new RecorderService(db, settingsStore, logger);
const worldBackups = new WorldBackupsService(db, settingsStore, logger);
const dedicatedServers = new DedicatedServerService(db, settingsStore, logger);
const discordRpc = new DiscordRpcService(logger);

function createSplash(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashUrl = path.join(__dirname, '../dist/splash.html');
  splashWindow.loadFile(splashUrl).catch(() => {
    // Fallback to renderer dev server splash route
    if (process.env.NODE_ENV === 'development') {
      splashWindow?.loadURL('http://localhost:5173/splash.html').catch(() => { });
    }
  });
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show();
  });
  return splashWindow;
}

function createMainWindow(): BrowserWindow {
  const possibleIcons = [
    path.join(__dirname, '../ico.ico.png'),
    path.join(__dirname, '../ico.ico'),
    path.join(__dirname, '../build/icon.ico'),
  ];
  let icon: Electron.NativeImage | undefined;
  for (const p of possibleIcons) {
    if (fs.existsSync(p)) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) { icon = img; break; }
      } catch { }
    }
  }

  const preloadPath = fs.existsSync(path.join(__dirname, 'preload.mjs'))
    ? path.join(__dirname, 'preload.mjs')
    : path.join(__dirname, 'preload.js');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#0a0e0a',
    icon,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    logger.error('Main window failed to load', { errorCode, errorDescription, validatedURL });
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.error('Renderer console error', { message, line, sourceId });
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('Renderer process gone', details);
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow?.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      const settings = settingsStore.get();
      if (settings.closeToTray) {
        e.preventDefault();
        mainWindow?.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
    }
  });

  mainWindow.on('minimize', () => {
    const settings = settingsStore.get();
    if (settings.minimizeToTray) {
      mainWindow?.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function createTray(icon: Electron.NativeImage | undefined) {
  if (tray) return;
  if (!icon || icon.isEmpty()) {
    logger.warn('Skipping tray creation: icon is missing or empty');
    return;
  }
  try {
    tray = new Tray(icon);
    tray.setToolTip('SlimeLauncher');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open SlimeLauncher',
        click: () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Exit SlimeLauncher',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    logger.error('Failed to create tray icon', { error: String(err) });
  }
}

// Checks for a new release at every launch (electron-updater). When one is
// found the user is asked whether to download it; after the download finishes
// they're asked whether to restart and install. Gated by the
// `autoUpdateLauncher` setting and only runs in the packaged app (there is no
// update feed in development).
let updatePromptOpen = false;
function setupAutoUpdater(deps: HandlerDeps) {
  if (!app.isPackaged) return;
  if (!settingsStore.get().autoUpdateLauncher) return;
  try {
    autoUpdater.autoDownload = false; // ask first, download only on consent
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (m?: unknown) => logger.info(`[updater] ${m ?? ''}`),
      warn: (m?: unknown) => logger.warn(`[updater] ${m ?? ''}`),
      error: (m?: unknown) => logger.error(`[updater] ${m ?? ''}`),
      debug: (m?: unknown) => logger.debug(`[updater] ${m ?? ''}`),
    };

    autoUpdater.on('update-available', (info) => {
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed() || updatePromptOpen) return;
      updatePromptOpen = true;
      logger.info('Update available', { version: info.version });
      notify(deps, { type: 'info', title: 'Update available', message: `SlimeLauncher ${info.version} is ready.`, duration: 6000 });
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update available',
        message: `SlimeLauncher ${info.version} is available`, // e.g. "1.1.0"
        detail: `You are running ${app.getVersion()}. Download and install the update now?`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        updatePromptOpen = false;
        if (response !== 0) return;
        notify(deps, { type: 'info', title: 'Downloading update', message: `SlimeLauncher ${info.version} is downloading…`, duration: 4000 });
        autoUpdater.downloadUpdate().catch((err) => {
          logger.error('Update download failed', { error: String(err) });
          notify(deps, { type: 'error', title: 'Update failed', message: String(err), duration: 8000 });
        });
      }).catch(() => { updatePromptOpen = false; });
    });

    autoUpdater.on('download-progress', (p) => {
      logger.debug('Update download progress', { percent: p.percent, transferred: p.transferred, total: p.total });
    });

    autoUpdater.on('update-downloaded', (info) => {
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed()) return;
      logger.info('Update downloaded', { version: info.version });
      notify(deps, { type: 'success', title: 'Update ready', message: 'Restart to finish installing.', duration: 6000 });
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update ready',
        message: `SlimeLauncher ${info.version} has been downloaded`,
        detail: 'Restart now to install the update?',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
      }).catch(() => { /* user dismissed */ });
    });

    autoUpdater.on('update-not-available', () => {
      logger.info('No update available');
    });

    autoUpdater.on('error', (err) => {
      // No feed / offline / 404 — log quietly, never crash the launcher.
      logger.warn('Update check failed', { error: String(err) });
    });

    // Give the window a moment to appear before the dialog can pop up.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        logger.warn('Update check failed', { error: String(err) });
      });
    }, 3000);
  } catch (e) {
    logger.warn('Auto-updater not available', { error: String(e) });
  }
}

app.whenReady().then(() => {
  // Register a custom protocol to proxy CurseForge CDN images with the API key.
  // CurseForge blocks direct browser requests to mediafilez.forgecdn.net without
  // the x-api-key header, so the renderer uses cfimg://<encoded-url> instead.
  protocol.handle('cfimg', async (req) => {
    const raw = decodeURIComponent(req.url.slice('cfimg://'.length));
    try {
      const resp = await fetch(raw, {
        headers: {
          'x-api-key': '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEjQnPnm',
          'User-Agent': 'SlimeLauncher/1.0.0',
        },
      });
      if (!resp.ok) return new Response(null, { status: resp.status });
      const buf = await resp.arrayBuffer();
      const ct = resp.headers.get('content-type') || 'image/jpeg';
      return new Response(Buffer.from(buf), { headers: { 'Content-Type': ct } });
    } catch {
      return new Response(null, { status: 502 });
    }
  });

  protocol.handle('local', async (req) => {
    const p = decodeURIComponent(req.url.slice('local://'.length));
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      const buf = fs.readFileSync(p);
      let ct = 'application/octet-stream';
      if (p.endsWith('.png')) ct = 'image/png';
      else if (p.endsWith('.jpg') || p.endsWith('.jpeg')) ct = 'image/jpeg';
      else if (p.endsWith('.gif')) ct = 'image/gif';
      else if (p.endsWith('.webp')) ct = 'image/webp';
      else if (p.endsWith('.mp4')) ct = 'video/mp4';
      else if (p.endsWith('.webm')) ct = 'video/webm';
      return new Response(buf, { headers: { 'Content-Type': ct } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  db.init();
  settingsStore.load();
  downloadManager.startProgressTimer();
  downloadManager.resumePending();
  skinServer.start();
  createSplash();
  const win = createMainWindow();

  const possibleIcons = [
    path.join(__dirname, '../ico.ico.png'),
    path.join(__dirname, '../ico.ico'),
    path.join(__dirname, '../build/icon.ico'),
  ];
  let appIcon: Electron.NativeImage | undefined;
  for (const p of possibleIcons) {
    if (fs.existsSync(p)) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) { appIcon = img; break; }
      } catch { }
    }
  }
  createTray(appIcon);

  // Register all IPC handlers with shared dependencies
  const deps = { db, settingsStore, downloadManager, skinServer, skinDirectory, presence, recorder, worldBackups, dedicatedServers, logger, getMainWindow: () => mainWindow };
  // Discord Rich Presence: mirror the local presence state into Discord.
  let discordLastState = '';
  let discordPlayingSince: number | undefined;
  const applyDiscordPresence = (snap: PresenceSnapshot) => {
    try {
      const s = settingsStore.get();
      if (!s.discordPresenceEnabled || !s.discordClientId.trim()) {
        if (discordRpc) discordRpc.setActivity(null);
        return;
      }
      const self = snap.self;
      const gameLabel = self.game ? `Minecraft ${self.game}` : 'Minecraft';
      const since = Date.now();
      if (discordLastState !== `${self.state}:${self.game}:${self.server}:${self.port}`) {
        if (self.state === 'idle') {
          discordPlayingSince = undefined;
          discordRpc.setActivity(null);
        } else {
          if (discordPlayingSince === undefined) discordPlayingSince = since;
          if (self.state === 'lan') {
            discordRpc.setActivity({ details: gameLabel, state: `LAN world on port ${self.port ?? '?'}`, startTimestamp: discordPlayingSince });
          } else if (self.state === 'server') {
            discordRpc.setActivity({ details: gameLabel, state: `on ${self.server || 'a server'}`, startTimestamp: discordPlayingSince });
          } else {
            discordRpc.setActivity({ details: gameLabel, state: 'In menu', startTimestamp: discordPlayingSince });
          }
        }
        discordLastState = `${self.state}:${self.game}:${self.server}:${self.port}`;
      }
    } catch { /* presence must never crash the app */ }
  };
  const syncDiscordConfig = () => {
    try {
      const s = settingsStore.get();
      discordRpc.configure(!!s.discordPresenceEnabled, String(s.discordClientId || ''));
      discordLastState = ''; // force re-apply on next snapshot
      applyDiscordPresence({ self: presence.getSelfPresence(), friends: presence.getFriendsPresence() });
    } catch { /* ignore */ }
  };
  // Re-sync Discord when settings change (the renderer saves via IPC).
  ipcMain.on(IPC.SETTINGS_SET, () => {
    setTimeout(syncDiscordConfig, 50);
  });
  presence.onSnapshot = (snap) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.FRIENDS_PRESENCE, snap);
    }
    applyDiscordPresence(snap);
  };
  presence.start();
  // Let the skin server serve friends' skins (relayed over LAN presence) so
  // offline skins are visible across machines running this launcher.
  skinServer.setFriendSkinResolver((uuid) => presence.lookupFriendSkin(uuid));
  skinServer.setFriendSkinNameResolver((nick) => presence.lookupFriendSkinByNick(nick));
  registerWindowHandlers(deps);
  registerSettingsHandlers(deps);
  registerAuthHandlers(deps);
  registerAccountsHandlers(deps);
  registerInstanceHandlers(deps);
  registerModHandlers(deps);
  registerModpackHandlers(deps);
  registerMapHandlers(deps);
  registerMcHandlers(deps);
  registerJavaHandlers(deps);
  registerDownloadHandlers(deps);
  registerFsHandlers(deps);
  registerMsHandlers(deps);
  registerSkinHandlers(deps);
  registerFriendsHandlers(deps);
  registerRecordingHandlers(deps);
  registerNetworkHandlers(deps);
  registerWorldBackupsHandlers(deps);
  registerServerHandlers(deps);
  registerZeroTierHandlers(deps);
  // If the installer's ZeroTier or Radmin checkbox was ticked, ask the user before
  // downloading anything — consent is never assumed. The marker is cleared
  // either way so this prompt shows at most once.
  void (async () => {
    try {
      const ztMarker = await hasInstallMarker();
      if (ztMarker) clearInstallMarker();
      
      const radminMarker = await hasRadminInstallMarker();
      if (radminMarker) clearRadminInstallMarker();
      
      if (!ztMarker && !radminMarker) return;
      
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed()) return;

      if (ztMarker && !(await isZeroTierInstalled())) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          title: 'Install ZeroTier VPN?',
          message: 'You chose to install ZeroTier VPN during setup.',
          detail: 'ZeroTier creates a virtual network between players so you can play together over the internet. Download and install it now?',
          buttons: ['Install ZeroTier', 'Skip'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response === 0) {
          let lastPhase = '';
          const res = await installZeroTier(logger, (_pct, label) => {
            if (label === lastPhase) return;
            lastPhase = label;
            notify(deps, { type: 'info', title: 'ZeroTier VPN', message: label, duration: 8000 });
          });
          notify(deps, {
            type: res.ok ? 'success' : 'error',
            title: 'ZeroTier VPN',
            message: res.ok
              ? res.installed
                ? 'ZeroTier VPN installed. Use it with the Network tab to play from anywhere.'
                : 'ZeroTier VPN installed. Restart the app if it is not detected yet.'
              : `Install failed: ${res.error || 'unknown error'}. You can retry from the Network page.`,
            duration: 8000,
          });
        }
      }

      if (radminMarker) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          title: 'Install Radmin VPN?',
          message: 'You chose to install Radmin VPN during setup.',
          detail: 'Radmin VPN creates a virtual network between players so you can play together over the internet. Download and install it now?',
          buttons: ['Install Radmin VPN', 'Skip'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response === 0) {
          let lastPhase = '';
          const res = await installRadminVpn(logger, (_pct, label) => {
            if (label === lastPhase) return;
            lastPhase = label;
            notify(deps, { type: 'info', title: 'Radmin VPN', message: label, duration: 8000 });
          });
          notify(deps, {
            type: res.ok ? 'success' : 'error',
            title: 'Radmin VPN',
            message: res.ok
              ? 'Radmin VPN installed. Use it with the Network tab to play from anywhere.'
              : `Install failed: ${res.error || 'unknown error'}.`,
            duration: 8000,
          });
        }
      }
    } catch (e) {
      logger.warn('VPN marker check failed', { error: String(e) });
    }
  })();
  // Wire presence game-port detection to network service
  deps.presence.onGamePort = (port: number) => {
    const ns = getNetworkService();
    if (ns?.isInNetwork()) {
      ns.setSelfGamePort(port);
    }
  };
  recorder.init();

  setupAutoUpdater(deps);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  recorder.dispose();
  downloadManager.stopProgressTimer();
  skinServer.stop();
  presence.stop();
  discordRpc.dispose();
  db.close();
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});