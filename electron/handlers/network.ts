import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { NetworkPeer } from '../../shared/types.js';
import { NetworkService } from '../services/network.js';

import { offlineUuid } from '../services/skin-server.js';
import type { DatabaseService } from '../services/database.js';

let _networkService: NetworkService | null = null;
export function getNetworkService(): NetworkService | null { return _networkService; }

// Resolves the current user's identity (nick, uuid, skin) from the database.
// MS account skins are stored under the account UUID, while offline skins are
// stored under the nick — so we try both keys to find the skin data.
export function resolveIdentity(db: DatabaseService): { nick: string; uuid: string; skin: string | null; skinVariant: string | null; cape: string | null } {
  let nick = 'player';
  let uuid = offlineUuid('player');
  let skin: string | null = null;
  let skinVariant: string | null = null;
  let cape: string | null = null;

  const sessionRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('slime_session_token') as { value: string } | undefined;
  if (sessionRow) {
    try {
      const token = JSON.parse(sessionRow.value) as string;
      const sess = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
      if (sess) {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(sess.user_id) as { username: string } | undefined;
        if (user) {
          nick = user.username;
          uuid = offlineUuid(nick);
        }
      }
    } catch { /* ignore */ }
  }

  // Try MS account (overrides nick/uuid if present)
  const ms = db.prepare('SELECT username, uuid FROM microsoft_accounts WHERE is_active = 1').get() as { username?: string; uuid?: string } | undefined;
  if (ms?.username && ms?.uuid) {
    nick = ms.username;
    uuid = ms.uuid;
  }

  // Load skin: MS skins are keyed by UUID, offline skins by nick — try both.
  try {
    // 1. Try UUID first (covers Microsoft account custom skins)
    const byUuid = db.prepare('SELECT skin_data, variant, cape_data FROM offline_skins WHERE username = ?').get(uuid) as { skin_data?: string; variant?: string; cape_data?: string } | undefined;
    if (byUuid?.skin_data || byUuid?.cape_data) {
      skin = byUuid.skin_data || null;
      skinVariant = byUuid.variant || null;
      cape = byUuid.cape_data || null;
      return { nick, uuid, skin, skinVariant, cape };
    }
    // 2. Fall back to nick (covers offline account skins)
    const byNick = db.prepare('SELECT skin_data, variant, cape_data FROM offline_skins WHERE lower(username) = lower(?)').get(nick) as { skin_data?: string; variant?: string; cape_data?: string } | undefined;
    if (byNick?.skin_data) { skin = byNick.skin_data; skinVariant = byNick.variant || null; }
    if (byNick?.cape_data) { cape = byNick.cape_data; }
  } catch { /* ignore */ }

  return { nick, uuid, skin, skinVariant, cape };
}

export async function updateNetworkIdentity(db: DatabaseService) {
  const s = getNetworkService();
  if (!s || !s.isInNetwork()) return;
  const { nick, uuid, skin, skinVariant, cape } = resolveIdentity(db);
  s.updateIdentity(nick, uuid, skin, skinVariant, cape);
}

export function registerNetworkHandlers(deps: HandlerDeps) {
  const { db, logger, getMainWindow } = deps;

  function service(): NetworkService {
    if (!_networkService) {
      _networkService = new NetworkService(db, logger);
      _networkService.onUpdate = () => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.NETWORK_ON_UPDATE, _networkService!.getInfo());
        }
      };
      _networkService.onPeerJoin = (peer: NetworkPeer) => {
        // Push the peer's skin to the skin server so the game can render
        // their character when they join our LAN world.
        deps.skinServer.setNetworkPeerSkin(
          peer.uuid.replace(/-/g, ''),
          peer.nick,
          peer.skin,
          peer.skinVariant,
          peer.cape,
        );
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.NETWORK_ON_PEER_JOIN, peer);
        }
      };
      // Register peer skins on the client side too (for existing peers
      // that the client didn't see join)
      _networkService.onPeerRegistered = (peer: NetworkPeer) => {
        deps.skinServer.setNetworkPeerSkin(
          peer.uuid.replace(/-/g, ''),
          peer.nick,
          peer.skin,
          peer.skinVariant,
          peer.cape,
        );
      };
      // Register the host's skin on the client side
      _networkService.onHostInfo = (nick: string, uuid: string, skin: string | null, skinVariant: string | null, cape: string | null) => {
        deps.skinServer.setNetworkPeerSkin(uuid.replace(/-/g, ''), nick, skin, skinVariant, cape);
      };
      _networkService.onPeerLeave = (peerId: string) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.NETWORK_ON_PEER_LEAVE, peerId);
        }
      };
      _networkService.onPeerSkinUpdate = (peerId: string, uuid: string, nick: string, skin: string | null, skinVariant: string | null, cape: string | null) => {
        deps.skinServer.setNetworkPeerSkin(uuid.replace(/-/g, ''), nick, skin, skinVariant, cape);
      };
      _networkService.onChat = (msg) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.NETWORK_ON_CHAT, msg);
        }
      };
      _networkService.onChatHistory = (messages) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.NETWORK_ON_CHAT_HISTORY, messages);
        }
      };
      _networkService.onGamePort = (peerId: string, port: number) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.NETWORK_ON_GAME_PORT, { peerId, port });
        }
      };
      // Auto-restore saved network from previous session
      _networkService.autoRestore().catch((e) => {
        logger.warn('Network auto-restore failed', { error: String(e) });
      });
      // Texture URLs in profiles advertise the IP peers can reach — with a
      // ZeroTier network up that is the ZeroTier IP (works across networks).
      void deps.skinServer.refreshHostIp();
    }
    return _networkService;
  }

  ipcMain.handle(IPC.NETWORK_CREATE, async (_e, name: string, opts?: unknown) => {
    try {
      const s = service();
      const { nick, uuid, skin, skinVariant, cape } = resolveIdentity(db);

      const network = await s.createNetwork(String(name || `${nick}'s Network`), nick, uuid, skin, skinVariant, cape, {
        internetMode: (opts as { internetMode?: string } | undefined)?.internetMode as 'auto' | 'manual' | 'lan' | undefined,
        manualIp: (opts as { manualIp?: string } | undefined)?.manualIp,
        manualPort: Number((opts as { manualPort?: number } | undefined)?.manualPort) || undefined,
      });
      void deps.skinServer.refreshHostIp();
      return { ok: true, network };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle(IPC.NETWORK_JOIN, (_e, key: string) => {
    try {
      const s = service();
      const { nick, uuid, skin, skinVariant, cape } = resolveIdentity(db);
      void deps.skinServer.refreshHostIp();
      return { ok: true, network: s.joinNetwork(String(key), nick, uuid, skin, skinVariant, cape) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle(IPC.NETWORK_LEAVE, () => {
    service().leaveNetwork();
    return { ok: true };
  });

  ipcMain.handle(IPC.NETWORK_INFO, () => {
    return service().getInfo();
  });

  ipcMain.handle(IPC.NETWORK_CHAT_SEND, (_e, text: string) => {
    service().sendChat(String(text));
    return { ok: true };
  });
}