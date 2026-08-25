// Shared type contracts between the Electron main process and the React renderer.
// These mirror the database schema and IPC payloads so both sides stay in sync.

export type LoaderType = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';

export interface MinecraftInstance {
  id: string;
  name: string;
  icon: string | null;
  mcVersion: string;
  loader: LoaderType;
  loaderVersion: string | null;
  javaPath: string | null;
  ramMB: number;
  jvmArgs: string;
  createdAt: number;
  lastPlayedAt: number | null;
  playCount: number;
}

export interface ModEntry {
  id: string;
  instanceId: string;
  slug: string;
  name: string;
  author: string;
  version: string;
  fileName: string;
  enabled: boolean;
  installedAt: number;
  source: 'modrinth' | 'curseforge' | 'manual';
}

export interface MapEntry {
  id: string;
  instanceId: string;
  name: string;
  author: string;
  mapType: string;
  fileName: string;
  installedAt: number;
}

export interface UserAccount {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  createdAt: number;
  launchCount: number;
}

export interface MicrosoftAccount {
  id: string;
  username: string;
  uuid: string;
  accessToken: string;
  expiresAt: number;
  linkedAt: number;
  isActive: boolean;
}

export interface SavedAccount {
  id: string;
  kind: 'offline' | 'microsoft';
  nick: string;
  isActive: boolean;
  createdAt: number;
}

export interface DownloadTask {
  id: string;
  name: string;
  url: string;
  destination: string;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled';
  error: string | null;
  category: 'minecraft' | 'mod' | 'map' | 'java' | 'launcher';
  createdAt: number;
}

export type RecordingQuality = 'low' | 'medium' | 'high' | 'ultra';
export type RecordingResolution = 'window' | '720p' | '1080p' | '1440p' | '2160p';
export type RecordingAudio = 'none' | 'system' | 'mic' | 'both';

export interface RecordingSettings {
  enabled: boolean;
  autoStart: boolean;
  fps: number;
  quality: RecordingQuality;
  resolution: RecordingResolution;
  audio: RecordingAudio;
  // Exact DirectShow device names — empty string means auto-detect.
  systemDevice: string;
  micDevice: string;
  hotkey: string;
  screenshotHotkey: string;
  folder: string;
}

export interface RecordingEntry {
  id: string;
  fileName: string;
  filePath: string;
  instanceName: string | null;
  durationMs: number;
  sizeBytes: number;
  fps: number;
  quality: string;
  resolution: string;
  createdAt: number;
}

export type RecordingState = 'idle' | 'recording' | 'stopping';

export interface RecordingStatus {
  state: RecordingState;
  startedAt: number | null;
  fileName: string | null;
  elapsedMs: number;
  error: string | null;
  install: { progress: number; label: string } | null;
}

export interface FfmpegStatus {
  available: boolean;
  path: string | null;
  downloading: boolean;
}

export interface ScreenshotEntry {
  id: string;
  fileName: string;
  filePath: string;
  instanceName: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: number;
}

export interface RecordingStats {
  videoCount: number;
  screenshotCount: number;
  videoBytes: number;
  screenshotBytes: number;
  totalBytes: number;
}

export interface WorldBackup {
  id: string;
  instanceId: string;
  instanceName: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  worldCount: number;
  worlds: string[];
  createdAt: number;
}

export type DedicatedServerState = 'stopped' | 'starting' | 'running' | 'error';

export interface DedicatedServer {
  id: string;
  name: string;
  mcVersion: string;
  flavor: 'vanilla' | 'paper';
  port: number;
  ramMb: number;
  motd: string;
  onlineMode: boolean;
  dir: string;
  createdAt: number;
}

export interface DedicatedServerStatus {
  id: string;
  state: DedicatedServerState;
  error?: string | null;
}

export interface AppSettings {
  language: string;
  theme: 'dark' | 'midnight' | 'slime';
  startWithWindows: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  accentColor: string;
  uiScale: number;
  blur: boolean;
  shadows: boolean;
  roundedCorners: boolean;
  backgroundStyle: 'gradient' | 'slime' | 'particles' | 'none' | 'custom';
  customBackgroundImage: string | null;
  customBackgroundOpacity: number;
  customBackgroundBlur: number;
  animationsEnabled: boolean;
  animationIntensity: number;
  reducedMotion: boolean;
  pageTransitions: boolean;
  minecraftDirectory: string;
  defaultJavaPath: string;
  defaultRamMB: number;
  jvmArguments: string;
  downloadThreads: number;
  downloadLocation: string;
  autoUpdateMods: boolean;
  autoUpdateLauncher: boolean;
  developerMode: boolean;
  msClientId: string;
  showGameConsole: boolean;
  // Serve original-resolution (HD) skins/capes in-game instead of the
  // 64x64/64x32 downscale. Vanilla Minecraft can't render HD textures, so this
  // is meant for clients with OptiFine or CustomSkinLoader installed.
  hdTexturesInGame: boolean;
  // Base URL of a SlimeLauncher skin directory server. When set, the launcher
  // publishes the local account's skin there and resolves other launcher
  // users' skins by UUID — this makes custom skins visible between two
  // SlimeLauncher players even on third-party servers over the internet.
  // Empty string disables the feature entirely.
  skinDirectoryUrl: string;
  worldBackupsEnabled: boolean;
  worldBackupsKeep: number;
  worldBackupsFolder: string;
  discordPresenceEnabled: boolean;
  discordClientId: string;
  recording: RecordingSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'en',
  theme: 'dark',
  startWithWindows: false,
  minimizeToTray: true,
  closeToTray: false,
  accentColor: '#4ade80',
  uiScale: 1,
  blur: true,
  shadows: true,
  roundedCorners: true,
  backgroundStyle: 'gradient',
  customBackgroundImage: null,
  customBackgroundOpacity: 0.5,
  customBackgroundBlur: 10,
  animationsEnabled: true,
  animationIntensity: 0.6,
  reducedMotion: false,
  pageTransitions: true,
  minecraftDirectory: '',
  defaultJavaPath: '',
  defaultRamMB: 4096,
  jvmArguments: '-Xmn512M -XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1HeapRegionSize=16M -XX:+ParallelGCThreads=4',
  downloadThreads: 4,
  downloadLocation: '',
  autoUpdateMods: false,
  autoUpdateLauncher: true,
  developerMode: false,
  msClientId: '',
  showGameConsole: false,
  hdTexturesInGame: false,
  skinDirectoryUrl: '',
  worldBackupsEnabled: true,
  worldBackupsKeep: 5,
  worldBackupsFolder: '',
  discordPresenceEnabled: false,
  discordClientId: '',
  recording: {
    enabled: false,
    autoStart: false,
    fps: 60,
    quality: 'high',
    resolution: '1080p',
    audio: 'system',
    systemDevice: '',
    micDevice: '',
    hotkey: 'F8',
    screenshotHotkey: 'F9',
    folder: '',
  },
};

export interface NotificationItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
  duration: number;
  createdAt: number;
}

export interface ModrinthMod {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  categories: string[];
  downloads: number;
  project_type: string;
  versions: string[];
}

export interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  files: { url: string; filename: string; primary: boolean; size: number }[];
}

export interface FriendRow {
  id: string;
  nick: string;
  note: string | null;
  uuid: string;
  createdAt: number;
}

export type PresenceState = 'idle' | 'menu' | 'lan' | 'server';

export interface FriendPresence {
  nick: string;
  uuid: string | null;
  state: PresenceState;
  game: string | null;
  loader: string | null;
  mods: string | null;
  server: string | null;
  port: number | null;
  ip: string;
  lastSeen: number;
  // The friend's own skin, broadcast by their launcher (base64 PNG) so the
  // head can be rendered without needing the skin to exist in our DB.
  skin?: string | null;
  skinVariant?: string | null;
}

export interface SelfPresence {
  nick: string;
  uuid: string;
  state: PresenceState;
  game: string | null;
  loader: string | null;
  mods: string | null;
  server: string | null;
  port: number | null;
  since: number;
  // Local IPv4 addresses, shown as a diagnostic in the Friends page.
  ips?: string[];
}

export interface PresenceSnapshot {
  self: SelfPresence;
  friends: FriendPresence[];
}

// ─── Network (Radmin VPN-like) ──────────────────────────────────────────────

export interface NetworkPeer {
  id: string;
  nick: string;
  uuid: string;
  ip: string;
  port: number;
  skin: string | null;
  skinVariant: string | null;
  cape: string | null;
  connectedAt: number;
  gamePort: number | null;
}

export interface NetworkInfo {
  id: string;
  name: string;
  key: string;
  isHost: boolean;
  hostIp: string | null;
  hostPort: number | null;
  hostGamePort: number | null;
  hostSkin: string | null;
  hostSkinVariant: string | null;
  hostCape: string | null;
  selfNick: string;
  selfUuid: string;
  selfSkin: string | null;
  selfSkinVariant: string | null;
  selfCape: string | null;
  selfGamePort: number | null;
  selfIp: string | null;
  internetMode: 'lan' | 'upnp' | 'manual';
  publicIp: string | null;
  peers: NetworkPeer[];
  createdAt: number;
  // Client-side link state: hosts are always 'connected'; clients reflect
  // whether the connection to the host is established yet, failed, or dropped.
  connection: 'connected' | 'connecting' | 'disconnected';
  connectionError: string | null;
  // Recent chat history relayed by the host, so a client that joins (or the
  // page reloading) still sees earlier messages.
  chatHistory: NetworkChatMessage[];
}

export interface NetworkChatMessage {
  id: string;
  senderNick: string;
  senderUuid: string;
  text: string;
  timestamp: number;
}