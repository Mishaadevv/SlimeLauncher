import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RemoteInfo } from 'node:dgram';
import type { DatabaseService } from './database.js';
import type { Logger } from './logger.js';
import { isVirtualAdapter, offlineUuid } from './skin-server.js';
import type { FriendPresence, PresenceSnapshot, PresenceState, SelfPresence } from '../../shared/types.js';
import { pngDimensions, resizePng } from './png-utils.js';

// LAN multicast group used by SlimeLauncher instances on the same network.
// Every running launcher broadcasts a small JSON presence packet a few times
// per second; friends' launchers listen and update the status of the players
// in their friends list.
const MCAST_GROUP = '239.255.77.7';
const MCAST_PORT = 47777;
const BROADCAST_MS = 3000;
const TIMEOUT_MS = 12000;

export interface GamePresence {
  instDir: string;
  game: string;
  loader: string;
  mods: string;
  state: PresenceState;
  server: string | null;
  port: number | null;
  logStartOffset: number;
  // Creation time of the latest.log read at launch. The game's log4j config
  // recreates latest.log on every launch (OnStartupTriggeringPolicy) and at
  // midnight (TimeBasedTriggeringPolicy); when the file is replaced, the
  // recorded byte offset becomes invalid and parsing must restart from 0.
  logBirthtimeMs: number | null;
}

interface RawPacket {
  slime?: number;
  nick?: string;
  uuid?: string;
  game?: string | null;
  loader?: string | null;
  mods?: string | null;
  state?: string;
  server?: string | null;
  port?: number | null;
  skin?: string | null;
  skinVariant?: string | null;
  ts?: number;
}

// A skin broadcast by any nearby SlimeLauncher player (friend or not).
interface PeerSkin {
  nick: string;
  uuid: string | null;
  skin: string | null;
  skinVariant: string | null;
  lastSeen: number;
}

function modsHash(instDir: string): string {
  try {
    const modsDir = path.join(instDir, 'mods');
    if (!fs.existsSync(modsDir)) return '';
    const files = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).sort();
    const joined = files
      .map((f) => {
        try {
          const st = fs.statSync(path.join(modsDir, f));
          return `${f}:${st.size}`;
        } catch {
          return f;
        }
      })
      .join('|');
    return createHash('sha1').update(joined).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

// Finds the most recent "where am I" marker in the game log: a LAN world
// opened (`Starting integrated minecraft server … with port N`), a multiplayer
// server joined (`Connecting to host:port`) or a leave/stop that returns the
// player to the menu.
function parseLogState(logPath: string, logStartOffset = 0): { state: PresenceState; server: string | null; port: number | null } {
  let content = '';
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= logStartOffset) return { state: 'menu', server: null, port: null };
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(stat.size - logStartOffset);
    fs.readSync(fd, buf, 0, buf.length, logStartOffset);
    fs.closeSync(fd);
    content = buf.toString('utf-8');
  } catch {
    return { state: 'menu', server: null, port: null };
  }
  let best: { idx: number; state: PresenceState; server: string | null; port: number | null } | null = null;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match LAN port from various Minecraft versions:
    //   Pre-1.13: "Starting integrated server on port 25565"
    //   1.13+:    "Started integrated server on port 25565"
    //   1.21.x:   "Started serving on 25565" (the port is no longer part of
    //             the "Starting integrated minecraft server version {}" line)
    const portMatch = line.match(/(?:Starting|Started) integrated (?:minecraft )?server (?:on|with) port (\d+)|Started serving on (\d+)/i);
    if (portMatch) {
      best = { idx: i, state: 'lan', server: null, port: Number(portMatch[1] ?? portMatch[2]) };
      continue;
    }
    if (/Connecting to (\S+)/i.test(line)) {
      const m = line.match(/Connecting to (\S+)/i);
      best = { idx: i, state: 'server', server: m ? m[1].replace(/[.,;]$/, '') : null, port: null };
      continue;
    }
    // 1.13–1.18: "Stopping server", 1.19+: "Stopping singleplayer server",
    // older: "Stopping integrated server".
    if (/Stopping (?:integrated |singleplayer |dedicated )?(?:minecraft )?server|Disconnected from|Connection lost|Lost connection/i.test(line)) {
      best = { idx: i, state: 'menu', server: null, port: null };
      continue;
    }
  }
  if (!best) return { state: 'menu', server: null, port: null };
  return { state: best.state, server: best.server, port: best.port };
}

interface Iface4 {
  ip: string;
  broadcast: string | null;
}

// Physical IPv4 interfaces (virtual adapters excluded) with their subnet
// broadcast address, so presence packets reach every machine on every real
// LAN even when the OS routes multicast out the wrong (e.g. VirtualBox)
// adapter or the router's IGMP snooping drops multicast entirely.
function interfaces4(): Iface4[] {
  const out: Iface4[] = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (isVirtualAdapter(name)) continue;
      for (const i of list || []) {
        if (i.family !== 'IPv4' || i.internal || !i.address) continue;
        let broadcast: string | null = null;
        if (i.netmask) {
          try {
            const ip = i.address.split('.').map(Number);
            const mask = i.netmask.split('.').map(Number);
            broadcast = ip.map((p, idx) => p | (~mask[idx] & 255)).join('.');
          } catch { /* keep null */ }
        }
        out.push({ ip: i.address, broadcast });
      }
    }
  } catch { /* no interfaces */ }
  return out;
}

export class PresenceService {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private friends = new Map<string, FriendPresence>();
  // Skins broadcast by ANY nearby SlimeLauncher player, not only friends.
  // The game resolves other players' profiles by UUID through the local skin
  // server; without this cache a non-friend's custom skin would be unknown
  // and both players would render as Steve. Keyed by lowercase nick.
  private peerSkins = new Map<string, PeerSkin>();
  private game: GamePresence | null = null;

  // Set by main.ts to forward presence snapshots to the renderer.
  onSnapshot: ((snap: PresenceSnapshot) => void) | null = null;
  // Set by main.ts to notify when a game port is detected from the log.
  onGamePort: ((port: number) => void) | null = null;
  private lastDetectedPort: number | null = null;

  constructor(
    private db: DatabaseService,
    private logger: Logger,
  ) {}

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      this.logger.warn('Presence socket error', { error: String(err) });
    });
    socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => this.handlePacket(msg, rinfo));
    socket.bind(MCAST_PORT, () => {
      try {
        socket.setBroadcast(true);
        // Join the multicast group on every physical interface — with several
        // adapters (VirtualBox, ZeroTier…) Windows only joins the default one,
        // which is often not the Wi-Fi/ethernet that friends are on.
        const ifaces = interfaces4();
        let joined = 0;
        for (const iface of ifaces) {
          try {
            socket.addMembership(MCAST_GROUP, iface.ip);
            joined++;
          } catch (e) {
            this.logger.debug('Presence: no multicast membership on', { ip: iface.ip, error: String(e) });
          }
        }
        if (joined === 0) {
          socket.addMembership(MCAST_GROUP);
        }
        // Some routers/APs drop multicast at the default TTL of 1.
        socket.setMulticastTTL(3);
      } catch (e) {
        this.logger.warn('Presence: could not join multicast group', { error: String(e) });
      }
    });
    this.socket = socket;
    this.timer = setInterval(() => {
      this.broadcast();
      this.sweep();
      this.push();
    }, BROADCAST_MS);
    this.logger.info('Presence service started', { group: MCAST_GROUP, port: MCAST_PORT });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.friends.clear();
    this.peerSkins.clear();
  }

  // The user launched a game: publish presence with version + loader + mods
  // hash so friends can tell whether they can join a LAN world.
  setGame(instDir: string, game: string, loader: string) {
    // Record current file size so we only read NEW log entries — prevents
    // detecting a LAN port from a previous game session that is still in
    // latest.log.
    let logStartOffset = 0;
    let logBirthtimeMs: number | null = null;
    try {
      const logPath = path.join(instDir, 'logs', 'latest.log');
      if (fs.existsSync(logPath)) {
        const st = fs.statSync(logPath);
        logStartOffset = st.size;
        logBirthtimeMs = st.birthtimeMs;
      }
    } catch { /* ignore */ }
    this.game = {
      instDir,
      game,
      loader,
      mods: modsHash(instDir),
      state: 'menu',
      server: null,
      port: null,
      logStartOffset,
      logBirthtimeMs,
    };
    this.lastDetectedPort = null;
    this.broadcast();
    this.push();
  }

  clearGame() {
    if (this.lastDetectedPort !== null) {
      this.lastDetectedPort = null;
      this.onGamePort?.(0);
    }
    this.game = null;
    this.broadcast();
    this.push();
  }

  // Whether instDir is still the game whose presence we advertise — lets the
  // exit handler of an older game avoid clearing a newer game's presence.
  isCurrentGame(instDir: string): boolean {
    return this.game?.instDir === instDir;
  }

  getSelfPresence(): SelfPresence {
    const identity = this.identity();
    const state: PresenceState = this.game?.state || 'idle';
    return {
      nick: identity.nick,
      uuid: identity.uuid,
      state,
      game: this.game?.game || null,
      loader: this.game?.loader || null,
      mods: this.game?.mods || null,
      server: this.game?.server || null,
      port: this.game?.port || null,
      since: Date.now(),
      ips: this.localIps(),
    };
  }

  getFriendsPresence(): FriendPresence[] {
    return [...this.friends.values()];
  }

  // Looks up a friend's broadcast skin by nick (used by the legacy name-based
  // skin endpoints of pre-1.7 versions). Falls back to skins broadcast by any
  // nearby SlimeLauncher player so legacy clients also see non-friend skins.
  lookupFriendSkinByNick(nick: string): { username: string; skin: string | null; variant: string | null } | null {
    const target = String(nick).toLowerCase();
    for (const f of this.friends.values()) {
      if (f.skin && f.nick.toLowerCase() === target) {
        return { username: f.nick, skin: f.skin, variant: f.skinVariant ?? null };
      }
    }
    const peer = this.peerSkins.get(target);
    if (peer?.skin) {
      return { username: peer.nick, skin: peer.skin, variant: peer.skinVariant ?? null };
    }
    return null;
  }

  // Looks up a friend's broadcast skin by their (offline) uuid. Friends send
  // their skin base64 along with their presence packets, so the skin server
  // can serve it when the game requests that player's profile — this is how
  // offline skins travel between machines that run this launcher. Falls back
  // to skins broadcast by any nearby SlimeLauncher player (friends list not
  // required): the game only knows the other player's UUID, and without this
  // fallback non-friends would always render with the default Steve skin.
  lookupFriendSkin(uuidDashless: string): { username: string; skin: string | null; variant: string | null } | null {
    const target = String(uuidDashless).replace(/-/g, '').toLowerCase();
    for (const f of this.friends.values()) {
      if (!f.skin) continue;
      const fUuid = f.uuid
        ? f.uuid.replace(/-/g, '').toLowerCase()
        : offlineUuid(f.nick).replace(/-/g, '').toLowerCase();
      if (fUuid === target) {
        return { username: f.nick, skin: f.skin, variant: f.skinVariant ?? null };
      }
    }
    for (const s of this.peerSkins.values()) {
      if (!s.skin) continue;
      const sUuid = s.uuid
        ? s.uuid.replace(/-/g, '').toLowerCase()
        : offlineUuid(s.nick).replace(/-/g, '').toLowerCase();
      if (sUuid === target) {
        return { username: s.nick, skin: s.skin, variant: s.skinVariant ?? null };
      }
    }
    return null;
  }

  // Which of the user's instances could join a friend's LAN world (same MC
  // version and identical mods list).
  compatibleInstances(game: string, mods: string): { id: string; name: string; loader: string }[] {
    const out: { id: string; name: string; loader: string }[] = [];
    if (!this.db.isReady()) return out;
    try {
      const rows = this.db.prepare('SELECT id, name, mc_version, loader FROM instances').all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        if (String(r.mc_version) !== game) continue;
        if (!mods) {
          out.push({ id: String(r.id), name: String(r.name), loader: String(r.loader) });
          continue;
        }
        const settings = this.db.prepare("SELECT value FROM settings WHERE key = 'minecraftDirectory'").get() as { value?: string } | undefined;
        const mcDir = settings?.value
          ? (JSON.parse(settings.value) as string)
          : path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.slimelauncher', 'minecraft');
        const dir = path.join(mcDir, String(r.id));
        if (modsHash(dir) === mods) {
          out.push({ id: String(r.id), name: String(r.name), loader: String(r.loader) });
        }
      }
    } catch (e) {
      this.logger.warn('compatibleInstances failed', { error: String(e) });
    }
    return out;
  }

  // Our own skin (base64 PNG + variant), broadcast so friends can render the
  // head without having the skin in their own database. Capped at ~40 KB
  // base64 (~30KB PNG) — larger payloads exceed the UDP packet limit
  // (65507 bytes) and the whole presence packet would silently never arrive.
  // HD skins (1024x1024) are downscaled to 64x64 before broadcast so LAN peers
  // still see a skin instead of falling back to Steve.
  private selfSkin(): { skin: string | null; skinVariant: string | null } {
    try {
      if (!this.db.isReady()) return { skin: null, skinVariant: null };
      const { nick, uuid } = this.identity();
      const uuidKey = uuid.replace(/-/g, '');
      // Offline accounts store skins keyed by nick (case-insensitive), Microsoft accounts by uuid.
      const row = this.db
        .prepare('SELECT skin_data, variant FROM offline_skins WHERE lower(username) = lower(?) OR username = ? LIMIT 1')
        .get(nick, uuidKey) as { skin_data: string | null; variant: string | null } | undefined;
      if (!row?.skin_data) return { skin: null, skinVariant: null };
      const variant = row.variant || 'classic';
      if (row.skin_data.length <= 40 * 1024) {
        return { skin: row.skin_data, skinVariant: variant };
      }
      // Too large for UDP — try to downscale to vanilla 64x64.
      try {
        const buf = Buffer.from(row.skin_data, 'base64');
        const dims = pngDimensions(buf);
        if (dims && (dims.width > 64 || dims.height > 64)) {
          // Classic 64x64, legacy 64x32 is 2:1 so height 32 but we use 64 for safety; resizePng handles both.
          const isLegacy = dims.width !== dims.height;
          const resized = resizePng(buf, 64, isLegacy ? 32 : 64);
          if (resized) {
            const b64 = resized.toString('base64');
            if (b64.length <= 40 * 1024) return { skin: b64, skinVariant: variant };
          }
        }
      } catch { /* fallback to not sending skin */ }
      // Still too large - skip so we don't break presence
      this.logger.debug('Skin too large for presence broadcast, skipping', { nick, size: row.skin_data.length });
    } catch {
      /* no skin */
    }
    return { skin: null, skinVariant: null };
  }

  private localIps(): string[] {
    try {
      const out: string[] = [];
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (isVirtualAdapter(name)) continue;
        for (const i of list || []) {
          if (i.family === 'IPv4' && !i.internal) out.push(i.address);
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private identity(): { nick: string; uuid: string } {
    try {
      if (!this.db.isReady()) return { nick: 'player', uuid: offlineUuid('player') };
      const ms = this.db.prepare('SELECT username, uuid FROM microsoft_accounts WHERE is_active = 1').get() as { username: string; uuid: string } | undefined;
      if (ms) return { nick: ms.username, uuid: ms.uuid };
      const tokenRow = this.db.prepare("SELECT value FROM settings WHERE key = 'slime_session_token'").get() as { value?: string } | undefined;
      if (tokenRow?.value) {
        const token = JSON.parse(tokenRow.value) as string;
        const session = this.db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id?: string } | undefined;
        if (session?.user_id) {
          const user = this.db.prepare('SELECT username FROM users WHERE id = ?').get(session.user_id) as { username?: string } | undefined;
          if (user?.username) return { nick: user.username, uuid: offlineUuid(user.username) };
        }
      }
    } catch {
      /* fall through to default */
    }
    return { nick: 'player', uuid: offlineUuid('player') };
  }

  private broadcast() {
    if (!this.socket) return;
    // While in game, re-read the game log to track where the player is
    // (LAN world opened / multiplayer server joined / back in menu).
    if (this.game) {
      const logPath = path.join(this.game.instDir, 'logs', 'latest.log');
      // The game's log4j config recreates latest.log at every launch and at
      // midnight, so the recorded offset may point into a file that no longer
      // exists. Detect the replacement via the file's creation time: when it
      // changes, restart parsing from byte 0 of the new file (which only
      // contains the current session).
      try {
        const stat = fs.statSync(logPath);
        if (this.game.logBirthtimeMs === null) {
          this.game.logBirthtimeMs = stat.birthtimeMs;
        } else if (stat.birthtimeMs !== this.game.logBirthtimeMs) {
          this.game.logBirthtimeMs = stat.birthtimeMs;
          this.game.logStartOffset = 0;
        }
        // Truncated in place (no rotation) — the old offset is past EOF.
        if (stat.size <= this.game.logStartOffset) {
          this.game.logStartOffset = 0;
        }
      } catch { /* log not readable — keep previous state */ }
      const parsed = parseLogState(logPath, this.game.logStartOffset);
      this.game.state = parsed.state;
      this.game.server = parsed.server;
      this.game.port = parsed.port;
      // Notify network service when a game port is first detected
      if (parsed.port && parsed.port !== this.lastDetectedPort) {
        this.lastDetectedPort = parsed.port;
        this.onGamePort?.(parsed.port);
      } else if (!parsed.port && this.lastDetectedPort !== null) {
        // LAN world closed / back in the menu — stop advertising the old port.
        this.lastDetectedPort = null;
        this.onGamePort?.(0);
      }
    }
    const self = this.getSelfPresence();
    const { skin, skinVariant } = this.selfSkin();
    const packet: RawPacket = {
      slime: 1,
      nick: self.nick,
      uuid: self.uuid,
      state: self.state,
      game: self.game,
      loader: self.loader,
      mods: self.mods,
      server: self.server,
      port: self.port,
      skin,
      skinVariant,
      ts: Date.now(),
    };
    const buf = Buffer.from(JSON.stringify(packet));
    // Send via multicast AND to every physical subnet's directed broadcast
    // (plus the global broadcast as a fallback). Directed broadcasts survive
    // routers/APs that drop multicast, and reach any host in the subnet.
    const targets = [MCAST_GROUP, '255.255.255.255'];
    for (const iface of interfaces4()) {
      if (iface.broadcast && !targets.includes(iface.broadcast)) targets.push(iface.broadcast);
    }
    for (const target of targets) {
      this.socket.send(buf, 0, buf.length, MCAST_PORT, target, (err) => {
        if (err) this.logger.debug('Presence broadcast failed', { target, error: String(err) });
      });
    }
  }

  private handlePacket(msg: Buffer, rinfo: RemoteInfo) {
    let p: RawPacket;
    try {
      p = JSON.parse(msg.toString('utf-8')) as RawPacket;
    } catch {
      return;
    }
    if (p.slime !== 1 || !p.nick) return;
    const nick = String(p.nick).slice(0, 32);
    // Ignore our own multicast echo — but compare UUID too, not just nick:
    // two fresh installs both broadcast as "player", and nick-only matching
    // made them ignore EACH OTHER forever (no friends, no skins).
    const self = this.identity();
    const pktUuid = typeof p.uuid === 'string' ? p.uuid.replace(/-/g, '').toLowerCase() : '';
    const selfUuid = self.uuid.replace(/-/g, '').toLowerCase();
    if (self.nick.toLowerCase() === nick.toLowerCase() && (!pktUuid || pktUuid === selfUuid)) return;

    // Cache the skin BEFORE the friends-list gate: skins must resolve for
    // every nearby SlimeLauncher player, not only for added friends —
    // otherwise two launcher users who aren't friends see plain Steves.
    if (typeof p.skin === 'string' && p.skin) {
      const prev = this.peerSkins.get(nick.toLowerCase());
      this.peerSkins.set(nick.toLowerCase(), {
        nick,
        uuid: typeof p.uuid === 'string' && p.uuid ? p.uuid : null,
        skin: p.skin,
        skinVariant: typeof p.skinVariant === 'string' && p.skinVariant ? p.skinVariant : null,
        lastSeen: Date.now(),
      });
      if (!prev?.skin || prev.skin !== p.skin) {
        this.logger.debug('Learned LAN peer skin', { nick });
      }
    } else {
      this.peerSkins.delete(nick.toLowerCase());
    }

    if (!this.db.isReady()) return;
    const isFriend = this.db.prepare('SELECT id FROM friends WHERE lower(nick) = lower(?)').get(nick);
    if (!isFriend) return;

    const now = Date.now();
    this.friends.set(nick.toLowerCase(), {
      nick,
      uuid: p.uuid || null,
      state: (['idle', 'menu', 'lan', 'server'] as PresenceState[]).includes(p.state as PresenceState) ? (p.state as PresenceState) : 'idle',
      game: p.game || null,
      loader: p.loader || null,
      mods: p.mods || null,
      server: p.server || null,
      port: typeof p.port === 'number' ? p.port : null,
      ip: rinfo.address,
      lastSeen: now,
      skin: typeof p.skin === 'string' && p.skin ? p.skin : null,
      skinVariant: typeof p.skinVariant === 'string' && p.skinVariant ? p.skinVariant : null,
    });
    // Only re-push on actual state change or new friend to avoid flooding the renderer.
    this.push();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, f] of this.friends) {
      if (now - f.lastSeen > TIMEOUT_MS) {
        this.friends.delete(key);
      }
    }
    for (const [key, s] of this.peerSkins) {
      if (now - s.lastSeen > TIMEOUT_MS) {
        this.peerSkins.delete(key);
      }
    }
  }

  private push() {
    if (!this.onSnapshot) return;
    try {
      this.onSnapshot({ self: this.getSelfPresence(), friends: this.getFriendsPresence() });
    } catch (e) {
      this.logger.debug('Presence push failed', { error: String(e) });
    }
  }
}
