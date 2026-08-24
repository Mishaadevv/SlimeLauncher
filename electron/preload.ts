import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';

// Type-safe bridge exposed to the renderer under `window.slime`.
// The renderer never touches Node/Electron directly — only this surface.

const api = {
  app: {
    minimize: () => ipcRenderer.send(IPC.APP_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC.APP_MAXIMIZE),
    close: () => ipcRenderer.send(IPC.APP_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IPC.APP_IS_MAXIMIZED),
    onMaximizeChange: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on(IPC.APP_ON_MAXIMIZE_CHANGE, listener);
      return () => { ipcRenderer.removeListener(IPC.APP_ON_MAXIMIZE_CHANGE, listener); };
    },
    restart: () => ipcRenderer.send(IPC.APP_RESTART),
    version: () => ipcRenderer.invoke(IPC.APP_VERSION),
    openLogs: () => ipcRenderer.invoke(IPC.APP_OPEN_LOGS),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  },
  auth: {
    register: (username: string, email: string, password: string) =>
      ipcRenderer.invoke(IPC.AUTH_REGISTER, username, email, password),
    login: (email: string, password: string) =>
      ipcRenderer.invoke(IPC.AUTH_LOGIN, email, password),
    logout: () => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
    current: () => ipcRenderer.invoke(IPC.AUTH_CURRENT),
    updateProfile: (patch: { username?: string; avatar?: string | null }) =>
      ipcRenderer.invoke(IPC.AUTH_UPDATE_PROFILE, patch),
    changePassword: (current: string, next: string) =>
      ipcRenderer.invoke(IPC.AUTH_CHANGE_PASSWORD, current, next),
  },
  accounts: {
    list: () => ipcRenderer.invoke(IPC.ACCOUNTS_LIST),
    addOffline: (nick: string) => ipcRenderer.invoke(IPC.ACCOUNTS_ADD_OFFLINE, nick),
    setActive: (id: string) => ipcRenderer.invoke(IPC.ACCOUNTS_SET_ACTIVE, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.ACCOUNTS_REMOVE, id),
  },
  ms: {
    login: () => ipcRenderer.invoke(IPC.MS_LOGIN),
    deviceCode: () => ipcRenderer.invoke(IPC.MS_DEVICE_CODE),
    complete: (deviceCode: string) => ipcRenderer.invoke(IPC.MS_COMPLETE, deviceCode),
    logout: (id: string) => ipcRenderer.invoke(IPC.MS_LOGOUT, id),
    list: () => ipcRenderer.invoke(IPC.MS_LIST),
    setActive: (id: string) => ipcRenderer.invoke(IPC.MS_SET_ACTIVE, id),
    profile: () => ipcRenderer.invoke(IPC.MS_PROFILE),
    customSkin: () => ipcRenderer.invoke(IPC.MS_SKIN_GET),
    setCustomSkin: (data: { path?: string; base64?: string; variant?: 'classic' | 'slim' }) =>
      ipcRenderer.invoke(IPC.MS_SKIN_SET, data),
    setCustomCape: (data: { path?: string; base64?: string }) =>
      ipcRenderer.invoke(IPC.MS_SKIN_SET_CAPE, data),
    removeCustomSkin: () => ipcRenderer.invoke(IPC.MS_SKIN_REMOVE),
    removeCustomCape: () => ipcRenderer.invoke(IPC.MS_SKIN_REMOVE_CAPE),
  },
  instance: {
    list: () => ipcRenderer.invoke(IPC.INSTANCE_LIST),
    create: (data: unknown) => ipcRenderer.invoke(IPC.INSTANCE_CREATE, data),
    update: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.INSTANCE_UPDATE, id, patch),
    delete: (id: string) => ipcRenderer.invoke(IPC.INSTANCE_DELETE, id),
    duplicate: (id: string) => ipcRenderer.invoke(IPC.INSTANCE_DUPLICATE, id),
    openFolder: (id: string) => ipcRenderer.invoke(IPC.INSTANCE_OPEN_FOLDER, id),
    get: (id: string) => ipcRenderer.invoke(IPC.INSTANCE_GET, id),
    incrementPlay: (id: string) => ipcRenderer.invoke(IPC.INSTANCE_INCREMENT_PLAY, id),
  },
  mod: {
    list: (instanceId: string) => ipcRenderer.invoke(IPC.MOD_LIST, instanceId),
    install: (data: unknown) => ipcRenderer.invoke(IPC.MOD_INSTALL, data),
    delete: (id: string) => ipcRenderer.invoke(IPC.MOD_DELETE, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.MOD_TOGGLE, id, enabled),
    search: (query: string, facets: string[], page: number, sort?: string, gameVersion?: string) =>
      ipcRenderer.invoke(IPC.MOD_SEARCH, query, facets, page, sort, gameVersion),
    versions: (slug: string, mcVersion: string, loader: string, projectId?: string) =>
      ipcRenderer.invoke(IPC.MOD_VERSIONS, slug, mcVersion, loader, projectId),
    searchModrinth: (query: string, facets: string[], page: number, sort?: string, gameVersion?: string) =>
      ipcRenderer.invoke(IPC.MOD_SEARCH_MODRINTH, query, facets, page, sort, gameVersion),
    versionsModrinth: (slug: string, mcVersion: string, loader: string) =>
      ipcRenderer.invoke(IPC.MOD_VERSIONS_MODRINTH, slug, mcVersion, loader),
    installModrinth: (data: unknown) => ipcRenderer.invoke(IPC.MOD_INSTALL_MODRINTH, data),
    screens: (projectId: string, source: 'curseforge' | 'modrinth') => ipcRenderer.invoke(IPC.MOD_SCREENS, projectId, source),
    updateAll: (instanceId: string) => ipcRenderer.invoke(IPC.MOD_UPDATE_ALL, instanceId),
  },
  modpack: {
    install: (data: unknown) => ipcRenderer.invoke(IPC.MODPACK_INSTALL, data),
  },
  map: {
    list: (instanceId: string) => ipcRenderer.invoke(IPC.MAP_LIST, instanceId),
    install: (data: unknown) => ipcRenderer.invoke(IPC.MAP_INSTALL, data),
    delete: (id: string) => ipcRenderer.invoke(IPC.MAP_DELETE, id),
    openFolder: (id: string) => ipcRenderer.invoke(IPC.MAP_OPEN_FOLDER, id),    search: (query: string, category: string, page: number, sort?: string, gameVersion?: string) => ipcRenderer.invoke(IPC.MAP_SEARCH, query, category, page, sort, gameVersion),
    screens: (projectId: string) => ipcRenderer.invoke(IPC.MAP_SCREENS, projectId),
  },
  mc: {
    versions: () => ipcRenderer.invoke(IPC.MC_VERSIONS),
    loaderVersions: (mcVersion: string, loader: string) =>
      ipcRenderer.invoke(IPC.MC_LOADER_VERSIONS, mcVersion, loader),
    install: (data: unknown) => ipcRenderer.invoke(IPC.MC_INSTALL, data),
    launch: (instanceId: string) => ipcRenderer.invoke(IPC.MC_LAUNCH, instanceId),
    onLaunchProgress: (cb: (p: { stage: string; progress: number; message: string }) => void) => {
      const listener = (_e: unknown, v: { stage: string; progress: number; message: string }) => cb(v);
      ipcRenderer.on(IPC.MC_LAUNCH_PROGRESS, listener);
      return () => { ipcRenderer.removeListener(IPC.MC_LAUNCH_PROGRESS, listener); };
    },
    getConsoleData: () => ipcRenderer.invoke(IPC.MC_CONSOLE_GET_DATA),
    onConsoleLive: (cb: (e: { session: number; chunk: string }) => void) => {
      const listener = (_e: unknown, v: { session: number; chunk: string }) => cb(v);
      ipcRenderer.on(IPC.MC_CONSOLE_LIVE, listener);
      return () => { ipcRenderer.removeListener(IPC.MC_CONSOLE_LIVE, listener); };
    },
    onConsoleStatus: (cb: (e: { session: number; status: string; exitCode: number | null; title?: string }) => void) => {
      const listener = (_e: unknown, v: { session: number; status: string; exitCode: number | null; title?: string }) => cb(v);
      ipcRenderer.on(IPC.MC_CONSOLE_STATUS, listener);
      return () => { ipcRenderer.removeListener(IPC.MC_CONSOLE_STATUS, listener); };
    },
  },
  java: {
    detect: () => ipcRenderer.invoke(IPC.JAVA_DETECT),
    list: () => ipcRenderer.invoke(IPC.JAVA_LIST),
  },
  dl: {
    list: () => ipcRenderer.invoke(IPC.DL_LIST),
    pause: (id: string) => ipcRenderer.invoke(IPC.DL_PAUSE, id),
    resume: (id: string) => ipcRenderer.invoke(IPC.DL_RESUME, id),
    cancel: (id: string) => ipcRenderer.invoke(IPC.DL_CANCEL, id),
    retry: (id: string) => ipcRenderer.invoke(IPC.DL_RETRY, id),
    clearCompleted: () => ipcRenderer.invoke(IPC.DL_CLEAR_COMPLETED),
    onProgress: (cb: (tasks: unknown[]) => void) => {
      const listener = (_e: unknown, v: unknown[]) => cb(v);
      ipcRenderer.on(IPC.DL_PROGRESS, listener);
      return () => { ipcRenderer.removeListener(IPC.DL_PROGRESS, listener); };
    },
  },
  skin: {
    get: () => ipcRenderer.invoke(IPC.SKIN_GET),
    set: (data: { path?: string; base64?: string; variant?: 'classic' | 'slim' }) =>
      ipcRenderer.invoke(IPC.SKIN_SET, data),
    remove: () => ipcRenderer.invoke(IPC.SKIN_REMOVE),
    setCape: (data: { path?: string; base64?: string }) => ipcRenderer.invoke(IPC.SKIN_SET_CAPE, data),
    removeCape: () => ipcRenderer.invoke(IPC.SKIN_REMOVE_CAPE),
    port: () => ipcRenderer.invoke(IPC.SKIN_PORT),
  },
  friends: {
    list: () => ipcRenderer.invoke(IPC.FRIENDS_LIST),
    add: (nick: string) => ipcRenderer.invoke(IPC.FRIENDS_ADD, nick),
    remove: (id: string) => ipcRenderer.invoke(IPC.FRIENDS_REMOVE, id),
    compat: (game: string, mods: string) => ipcRenderer.invoke(IPC.FRIENDS_COMPAT, game, mods),
    onPresence: (cb: (snap: import('../shared/types.js').PresenceSnapshot) => void) => {
      const listener = (_e: unknown, v: import('../shared/types.js').PresenceSnapshot) => cb(v);
      ipcRenderer.on(IPC.FRIENDS_PRESENCE, listener);
      return () => { ipcRenderer.removeListener(IPC.FRIENDS_PRESENCE, listener); };
    },
  },
  notify: {
    on: (cb: (n: unknown) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on(IPC.NOTIFY, listener);
      return () => { ipcRenderer.removeListener(IPC.NOTIFY, listener); };
    },
  },
  fs: {
    selectDirectory: () => ipcRenderer.invoke(IPC.FS_SELECT_DIRECTORY),
    selectFile: (filters: unknown) => ipcRenderer.invoke(IPC.FS_SELECT_FILE, filters),
  },
  network: {
    create: (name: string, opts?: unknown) => ipcRenderer.invoke(IPC.NETWORK_CREATE, name, opts),
    join: (key: string) => ipcRenderer.invoke(IPC.NETWORK_JOIN, key),
    leave: () => ipcRenderer.invoke(IPC.NETWORK_LEAVE),
    info: () => ipcRenderer.invoke(IPC.NETWORK_INFO),
    onUpdate: (cb: (info: unknown) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on(IPC.NETWORK_ON_UPDATE, listener);
      return () => { ipcRenderer.removeListener(IPC.NETWORK_ON_UPDATE, listener); };
    },
    onPeerJoin: (cb: (peer: unknown) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on(IPC.NETWORK_ON_PEER_JOIN, listener);
      return () => { ipcRenderer.removeListener(IPC.NETWORK_ON_PEER_JOIN, listener); };
    },
    onPeerLeave: (cb: (peerId: string) => void) => {
      const listener = (_e: unknown, v: string) => cb(v);
      ipcRenderer.on(IPC.NETWORK_ON_PEER_LEAVE, listener);
      return () => { ipcRenderer.removeListener(IPC.NETWORK_ON_PEER_LEAVE, listener); };
    },
    onGamePort: (cb: (data: unknown) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on(IPC.NETWORK_ON_GAME_PORT, listener);
      return () => { ipcRenderer.removeListener(IPC.NETWORK_ON_GAME_PORT, listener); };
    },
    chatSend: (text: string) => ipcRenderer.invoke(IPC.NETWORK_CHAT_SEND, text),
    onChat: (cb: (msg: unknown) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on(IPC.NETWORK_ON_CHAT, listener);
      return () => { ipcRenderer.removeListener(IPC.NETWORK_ON_CHAT, listener); };
    },
    onChatHistory: (cb: (msgs: unknown[]) => void) => {
      const listener = (_e: unknown, v: unknown[]) => cb(v);
      ipcRenderer.on(IPC.NETWORK_ON_CHAT_HISTORY, listener);
      return () => { ipcRenderer.removeListener(IPC.NETWORK_ON_CHAT_HISTORY, listener); };
    },
  },
  zerotier: {
    status: () => ipcRenderer.invoke(IPC.ZT_STATUS),
    install: () => ipcRenderer.invoke(IPC.ZT_INSTALL),
  },
  rec: {
    list: () => ipcRenderer.invoke(IPC.REC_LIST),
    delete: (id: string) => ipcRenderer.invoke(IPC.REC_DELETE, id),
    openFolder: () => ipcRenderer.invoke(IPC.REC_OPEN_FOLDER),
    start: () => ipcRenderer.invoke(IPC.REC_START),
    stop: () => ipcRenderer.invoke(IPC.REC_STOP),
    status: () => ipcRenderer.invoke(IPC.REC_STATUS),
    onStatus: (cb: (s: import('../shared/types.js').RecordingStatus) => void) => {
      const listener = (_e: unknown, v: import('../shared/types.js').RecordingStatus) => cb(v);
      ipcRenderer.on(IPC.REC_STATUS_EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.REC_STATUS_EVENT, listener); };
    },
    ffmpegStatus: () => ipcRenderer.invoke(IPC.REC_FFMPEG_STATUS),
    installFfmpeg: () => ipcRenderer.invoke(IPC.REC_INSTALL_FFMPEG),
    audioDevices: () => ipcRenderer.invoke(IPC.REC_AUDIO_DEVICES),
    shotCapture: () => ipcRenderer.invoke(IPC.REC_SHOT_CAPTURE),
    shotList: () => ipcRenderer.invoke(IPC.REC_SHOT_LIST),
    shotDelete: (id: string) => ipcRenderer.invoke(IPC.REC_SHOT_DELETE, id),
    stats: () => ipcRenderer.invoke(IPC.REC_STATS),
    onShot: (cb: (s: import('../shared/types.js').ScreenshotEntry) => void) => {
      const listener = (_e: unknown, v: import('../shared/types.js').ScreenshotEntry) => cb(v);
      ipcRenderer.on(IPC.REC_SHOT_EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.REC_SHOT_EVENT, listener); };
    },
  },
  worldBackups: {
    list: (instanceId?: string) => ipcRenderer.invoke(IPC.WORLD_BACKUPS_LIST, instanceId),
    create: (instanceId: string) => ipcRenderer.invoke(IPC.WORLD_BACKUPS_CREATE, instanceId),
    delete: (id: string) => ipcRenderer.invoke(IPC.WORLD_BACKUPS_DELETE, id),
    restore: (id: string, instanceId: string) => ipcRenderer.invoke(IPC.WORLD_BACKUPS_RESTORE, id, instanceId),
    openFolder: (instanceId?: string) => ipcRenderer.invoke(IPC.WORLD_BACKUPS_OPEN_FOLDER, instanceId),
  },
  servers: {
    list: () => ipcRenderer.invoke(IPC.SERVER_LIST),
    create: (opts: { name: string; mcVersion: string; flavor: 'vanilla' | 'paper'; port: number; ramMb: number; motd: string; onlineMode: boolean }) =>
      ipcRenderer.invoke(IPC.SERVER_CREATE, opts),
    start: (id: string) => ipcRenderer.invoke(IPC.SERVER_START, id),
    stop: (id: string) => ipcRenderer.invoke(IPC.SERVER_STOP, id),
    delete: (id: string) => ipcRenderer.invoke(IPC.SERVER_DELETE, id),
    log: (id: string) => ipcRenderer.invoke(IPC.SERVER_LOG, id),
    openFolder: (id: string) => ipcRenderer.invoke(IPC.SERVER_OPEN_FOLDER, id),
    onStatus: (cb: (s: { id: string; state: string; error?: string | null; line?: string }) => void) => {
      const listener = (_e: unknown, v: { id: string; state: string; error?: string | null; line?: string }) => cb(v);
      ipcRenderer.on(IPC.SERVER_STATUS_EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.SERVER_STATUS_EVENT, listener); };
    },
  },
};

contextBridge.exposeInMainWorld('slime', api);

export type SlimeApi = typeof api;