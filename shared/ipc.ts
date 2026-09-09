// Central IPC channel contract. Both main and renderer import these names
// so there is a single source of truth for the bridge surface.

export const IPC = {
  // App / window
  APP_MINIMIZE: 'app:minimize',
  APP_MAXIMIZE: 'app:maximize',
  APP_CLOSE: 'app:close',
  APP_IS_MAXIMIZED: 'app:isMaximized',
  APP_ON_MAXIMIZE_CHANGE: 'app:onMaximizeChange',
  APP_RESTART: 'app:restart',
  APP_VERSION: 'app:version',
  APP_OPEN_LOGS: 'app:openLogs',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Hardware (auto-tuned defaults)
  SYSTEM_INFO: 'system:info',

  // Accounts (SlimeLauncher)
  AUTH_REGISTER: 'auth:register',
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_CURRENT: 'auth:current',
  AUTH_UPDATE_PROFILE: 'auth:updateProfile',
  AUTH_CHANGE_PASSWORD: 'auth:changePassword',

  // Microsoft Minecraft accounts
  MS_LOGIN: 'ms:login',
  MS_DEVICE_CODE: 'ms:deviceCode',
  MS_COMPLETE: 'ms:complete',
  MS_LOGOUT: 'ms:logout',
  MS_LIST: 'ms:list',
  MS_SET_ACTIVE: 'ms:setActive',
  MS_PROFILE: 'ms:profile',
  MS_SKIN_GET: 'ms:customSkinGet',
  MS_SKIN_SET: 'ms:customSkinSet',
  MS_SKIN_SET_CAPE: 'ms:customCapeSet',
  MS_SKIN_REMOVE: 'ms:customSkinRemove',
  MS_SKIN_REMOVE_CAPE: 'ms:customCapeRemove',

  // Multi-account manager (max 8 saved accounts, offline or Microsoft)
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_ADD_OFFLINE: 'accounts:addOffline',
  ACCOUNTS_SET_ACTIVE: 'accounts:setActive',
  ACCOUNTS_REMOVE: 'accounts:remove',

  // Instances
  INSTANCE_LIST: 'instance:list',
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_UPDATE: 'instance:update',
  INSTANCE_DELETE: 'instance:delete',
  INSTANCE_DUPLICATE: 'instance:duplicate',
  INSTANCE_OPEN_FOLDER: 'instance:openFolder',
  INSTANCE_GET: 'instance:get',
  INSTANCE_INCREMENT_PLAY: 'instance:incrementPlay',

  // Mods
  MOD_LIST: 'mod:list',
  MOD_INSTALL: 'mod:install',
  MOD_DELETE: 'mod:delete',
  MOD_TOGGLE: 'mod:toggle',
  MOD_SEARCH: 'mod:search',
  MOD_VERSIONS: 'mod:versions',
  MOD_SEARCH_MODRINTH: 'mod:searchModrinth',
  MOD_VERSIONS_MODRINTH: 'mod:versionsModrinth',
  MOD_INSTALL_MODRINTH: 'mod:installModrinth',
  MOD_SCREENS: 'mod:screens',
  MOD_UPDATE_ALL: 'mod:updateAll',

  // Modpacks
  MODPACK_INSTALL: 'modpack:install',

  // Maps (CurseForge only)
  MAP_LIST: 'map:list',
  MAP_INSTALL: 'map:install',
  MAP_DELETE: 'map:delete',
  MAP_OPEN_FOLDER: 'map:openFolder',
  MAP_SEARCH: 'map:search',
  MAP_SCREENS: 'map:screens',

  // Minecraft versions
  MC_VERSIONS: 'mc:versions',
  MC_LOADER_VERSIONS: 'mc:loaderVersions',
  MC_INSTALL: 'mc:install',
  MC_LAUNCH: 'mc:launch',
  MC_LAUNCH_PROGRESS: 'mc:launchProgress',
  MC_CONSOLE_GET_DATA: 'mc:console:getData',
  MC_CONSOLE_LIVE: 'mc:console:live',
  MC_CONSOLE_STATUS: 'mc:console:status',

  // Java
  JAVA_DETECT: 'java:detect',
  JAVA_LIST: 'java:list',

  // Downloads
  DL_LIST: 'dl:list',
  DL_PAUSE: 'dl:pause',
  DL_RESUME: 'dl:resume',
  DL_CANCEL: 'dl:cancel',
  DL_RETRY: 'dl:retry',
  DL_CLEAR_COMPLETED: 'dl:clearCompleted',
  DL_PROGRESS: 'dl:progress',

  // Offline skins
  SKIN_GET: 'skin:get',
  SKIN_SET: 'skin:set',
  SKIN_REMOVE: 'skin:remove',
  SKIN_SET_CAPE: 'skin:setCape',
  SKIN_REMOVE_CAPE: 'skin:removeCape',
  SKIN_PORT: 'skin:port',

  // Friends / LAN presence
  FRIENDS_LIST: 'friends:list',
  FRIENDS_ADD: 'friends:add',
  FRIENDS_REMOVE: 'friends:remove',
  FRIENDS_COMPAT: 'friends:compat',
  FRIENDS_PRESENCE: 'friends:presence',

  // Notifications (main -> renderer)
  NOTIFY: 'notify',

  // Game recording
  REC_LIST: 'rec:list',
  REC_DELETE: 'rec:delete',
  REC_OPEN_FOLDER: 'rec:openFolder',
  REC_START: 'rec:start',
  REC_STOP: 'rec:stop',
  REC_STATUS: 'rec:status',
  REC_STATUS_EVENT: 'rec:statusEvent',
  REC_FFMPEG_STATUS: 'rec:ffmpegStatus',
  REC_INSTALL_FFMPEG: 'rec:installFfmpeg',
  REC_AUDIO_DEVICES: 'rec:audioDevices',
  REC_SHOT_CAPTURE: 'rec:shotCapture',
  REC_SHOT_LIST: 'rec:shotList',
  REC_SHOT_DELETE: 'rec:shotDelete',
  REC_SHOT_EVENT: 'rec:shotEvent',
  REC_STATS: 'rec:stats',

  // Filesystem helpers
  FS_SELECT_DIRECTORY: 'fs:selectDirectory',
  FS_SELECT_FILE: 'fs:selectFile',

  // Network (Radmin VPN-like)
  NETWORK_CREATE: 'network:create',
  NETWORK_JOIN: 'network:join',
  NETWORK_LEAVE: 'network:leave',
  NETWORK_INFO: 'network:info',
  NETWORK_ON_UPDATE: 'network:update',
  NETWORK_ON_PEER_JOIN: 'network:peerJoin',
  NETWORK_ON_PEER_LEAVE: 'network:peerLeave',
  NETWORK_ON_GAME_PORT: 'network:gamePort',
  NETWORK_CHAT_SEND: 'network:chatSend',
  NETWORK_ON_CHAT: 'network:chat',
  NETWORK_ON_CHAT_HISTORY: 'network:chatHistory',

  // ZeroTier VPN (free Radmin alternative) install helper
  ZT_STATUS: 'zerotier:status',
  ZT_INSTALL: 'zerotier:install',

  // World backups
  WORLD_BACKUPS_LIST: 'worldBackups:list',
  WORLD_BACKUPS_CREATE: 'worldBackups:create',
  WORLD_BACKUPS_DELETE: 'worldBackups:delete',
  WORLD_BACKUPS_RESTORE: 'worldBackups:restore',
  WORLD_BACKUPS_OPEN_FOLDER: 'worldBackups:openFolder',

  // Dedicated Minecraft servers
  SERVER_CREATE: 'server:create',
  SERVER_LIST: 'server:list',
  SERVER_START: 'server:start',
  SERVER_STOP: 'server:stop',
  SERVER_DELETE: 'server:delete',
  SERVER_LOG: 'server:log',
  SERVER_OPEN_FOLDER: 'server:openFolder',
  SERVER_STATUS_EVENT: 'server:statusEvent',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];