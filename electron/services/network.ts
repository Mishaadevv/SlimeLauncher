import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './database.js';
import type { Logger } from './logger.js';
import { detectLanIp, isVirtualAdapter, offlineUuid } from './skin-server.js';
import { findIgd, getPublicIp, upnpAddPortMapping, upnpDeletePortMapping } from './nat.js';
import { getZeroTierIps } from './zerotier.js';
import type { NetworkPeer, NetworkInfo, NetworkChatMessage } from '../../shared/types.js';

// Simple JSON-over-TCP protocol for peer communication.
// Every message is a single line of JSON followed by \n.

// How long a single address attempt may take before the client fails over to
// the next candidate in the key (ZeroTier IPs first, LAN IP last).
const CONNECT_TIMEOUT_MS = 7000;

// Minecraft's LAN world discovery: the world host broadcasts a short MOTD
// announcement to 224.0.2.60:4445 every 1.5 s; clients on the Multiplayer
// screen listen and show it under "LAN World". When the world host is on a
// DIFFERENT network (Network tab / ZeroTier), its broadcast never reaches us
// — so the launcher re-announces it locally with the reachable host address.
const MC_LAN_GROUP = '224.0.2.60';
const MC_LAN_PORT = 4445;
const MC_LAN_INTERVAL_MS = 1500;

interface PeerConnection {
  id: string;
  nick: string;
  uuid: string;
  socket: net.Socket;
  ip: string;
  port: number;
  skin: string | null;
  skinVariant: string | null;
  cape: string | null;
  connectedAt: number;
  gamePort: number | null;
  buffer: string;
}

export class NetworkService {
  private server: net.Server | null = null;
  private serverPort = 0;
  private hostIp = '127.0.0.1';
  private networkId: string | null = null;
  private networkName: string = '';
  private networkKey: string = '';
  private isHost = false;
  private peers = new Map<string, PeerConnection>();
  private clientSocket: net.Socket | null = null;
  private clientBuffer = '';
  private hostInfo: { ip: string; port: number; ips: string[] } | null = null;
  private selfNick = 'Player';
  private selfUuid = '';
  private selfSkin: string | null = null;
  private selfSkinVariant: string | null = null;
  private selfCape: string | null = null;
  private selfGamePort: number | null = null;
  private hostGamePort: number | null = null;
  // Internet mode: 'lan' = LAN only, 'upnp' = public port mapped via the
  // router (UPnP), 'manual' = user forwarded a port on the router manually.
  private internetMode: 'lan' | 'upnp' | 'manual' = 'lan';
  private publicIp: string | null = null;
  private upnpIgd: { controlUrl: string } | null = null;
  private mappedPorts = new Set<number>();
  private _hostSkinFromPeer: string | null = null;
  private _hostSkinVariantFromPeer: string | null = null;
  private _hostCapeFromPeer: string | null = null;
  // Recent chat messages kept by the host and relayed to peers that join
  // later, so a client always sees the conversation that happened before it.
  private chatHistory: NetworkChatMessage[] = [];
  private localProxyServer: net.Server | null = null;
  private localProxyPort: number | null = null;
  // Client link state: 'connected' while the socket to the host is up,
  // 'connecting' while it is being established, 'disconnected' after a
  // failure or drop. Hosts stay 'connected' for as long as the server runs.
  private connection: 'connected' | 'connecting' | 'disconnected' = 'connected';
  private connectionError: string | null = null;
  private wasConnected = false;

  // Error codes collected across connect attempts of the current join, used
  // to distinguish "host offline/blocked" from "no route to that network".
  private connectFailures: string[] = [];
  private db: DatabaseService;
  // Local re-announcement of the host's LAN world (Minecraft's 224.0.2.60:4445
  // protocol) so the world shows up in the in-game Multiplayer LAN list even
  // when the host is on another network.
  private lanSocket: dgram.Socket | null = null;
  private lanTimer: NodeJS.Timeout | null = null;

  // Callbacks set by main.ts
  onHostInfo: ((nick: string, uuid: string, skin: string | null, skinVariant: string | null, cape: string | null) => void) | null = null;
  // Fires for any peer (existing or new) — used by handler to register skin in skin server
  onPeerRegistered: ((peer: NetworkPeer) => void) | null = null;
  onUpdate: (() => void) | null = null;
  onPeerJoin: ((peer: NetworkPeer) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onPeerSkinUpdate: ((peerId: string, uuid: string, nick: string, skin: string | null, skinVariant: string | null, cape: string | null) => void) | null = null;
  onGamePort: ((peerId: string, port: number) => void) | null = null;
  onChat: ((msg: NetworkChatMessage) => void) | null = null;
  onChatHistory: ((messages: NetworkChatMessage[]) => void) | null = null;

  constructor(
    db: DatabaseService,
    private logger: Logger,
  ) {
    this.db = db;
  }

  // Resolves the current user's identity (nick, uuid, skin) from the database.
  // MS account skins are stored under the account UUID, while offline skins
  // are stored under the nick — so we try both keys to find the skin data.
  private resolveIdentity(): { nick: string; uuid: string; skin: string | null; skinVariant: string | null; cape: string | null } {
    let nick = 'player';
    let uuid = offlineUuid('player');
    let skin: string | null = null;
    let skinVariant: string | null = null;
    let cape: string | null = null;

    const sessionRow = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('slime_session_token') as { value: string } | undefined;
    if (sessionRow) {
      try {
        const token = JSON.parse(sessionRow.value) as string;
        const sess = this.db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
        if (sess) {
          const user = this.db.prepare('SELECT username FROM users WHERE id = ?').get(sess.user_id) as { username: string } | undefined;
          if (user) {
            nick = user.username;
            uuid = offlineUuid(nick);
          }
        }
      } catch { /* ignore */ }
    }

    // Try MS account (overrides nick/uuid if present)
    const ms = this.db.prepare('SELECT username, uuid FROM microsoft_accounts WHERE is_active = 1').get() as { username?: string; uuid?: string } | undefined;
    if (ms?.username && ms?.uuid) {
      nick = ms.username;
      uuid = ms.uuid;
    }

    // Load skin: MS skins are keyed by UUID, offline skins by nick — try both.
    try {
      const byUuid = this.db.prepare('SELECT skin_data, variant, cape_data FROM offline_skins WHERE username = ?').get(uuid) as { skin_data?: string; variant?: string; cape_data?: string } | undefined;
      if (byUuid?.skin_data || byUuid?.cape_data) {
        skin = byUuid.skin_data || null;
        skinVariant = byUuid.variant || null;
        cape = byUuid.cape_data || null;
        return { nick, uuid, skin, skinVariant, cape };
      }
      const byNick = this.db.prepare('SELECT skin_data, variant, cape_data FROM offline_skins WHERE lower(username) = lower(?)').get(nick) as { skin_data?: string; variant?: string; cape_data?: string } | undefined;
      if (byNick?.skin_data) { skin = byNick.skin_data; skinVariant = byNick.variant || null; }
      if (byNick?.cape_data) { cape = byNick.cape_data; }
    } catch { /* ignore */ }

    return { nick, uuid, skin, skinVariant, cape };
  }

  // Try to restore a previously saved network on app start.
  // Host: re-create with same name (new port/key since old server is dead).
  // Client: re-join with saved key.
  async autoRestore(): Promise<NetworkInfo | null> {
    const saved = this.loadSavedState();
    if (!saved) return null;
    try {
      const { nick, uuid, skin, skinVariant, cape } = this.resolveIdentity();
      if (saved.isHost) {
        const info = await this.createNetwork(saved.name, nick, uuid, skin, skinVariant, cape);
        this.logger.info('Network restored (host)', { name: saved.name });
        return info;
      } else {
        const info = this.joinNetwork(saved.key, nick, uuid, skin, skinVariant, cape);
        this.logger.info('Network restored (client)', { key: saved.key });
        return info;
      }
    } catch (e) {
      this.logger.warn('Failed to restore network', { error: String(e) });
      this.clearState();
      return null;
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private saveState() {
    if (!this.db.isReady()) return;
    try {
      const state = {
        networkId: this.networkId,
        networkName: this.networkName,
        networkKey: this.networkKey,
        isHost: this.isHost,
        hostIp: this.isHost ? this.hostIp : (this.hostInfo?.ip ?? null),
        hostPort: this.isHost ? this.serverPort : (this.hostInfo?.port ?? null),
selfNick: this.selfNick,
      selfUuid: this.selfUuid,
      };
      this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('network_state', JSON.stringify(state));
    } catch (e) {
      this.logger.warn('Failed to save network state', { error: String(e) });
    }
  }

  private clearState() {
    if (!this.db.isReady()) return;
    try {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run('network_state');
    } catch { /* ignore */ }
  }

  loadSavedState(): { isHost: boolean; key: string; name: string } | null {
    if (!this.db.isReady()) return null;
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('network_state') as { value: string } | undefined;
      if (!row) return null;
      const state = JSON.parse(row.value) as { isHost: boolean; networkKey: string; networkName: string };
      if (!state.networkKey) return null;
      return { isHost: state.isHost, key: state.networkKey, name: state.networkName };
    } catch {
      return null;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  createNetwork(
    name: string,
    nick: string,
    uuid: string,
    skin: string | null,
    skinVariant: string | null,
    cape: string | null,
    opts?: { internetMode?: 'auto' | 'manual' | 'lan'; manualIp?: string; manualPort?: number },
  ): Promise<NetworkInfo> {
    this.leaveNetwork();
    this.selfNick = nick || 'Player';
    this.selfUuid = uuid || offlineUuid(this.selfNick);
    this.selfSkin = skin;
    this.selfSkinVariant = skinVariant;
    this.selfCape = cape;
    this.networkId = randomUUID();
    this.networkName = name || `${this.selfNick}'s Network`;
    this.isHost = true;
    this.connection = 'connected';
    this.connectionError = null;
    this.wasConnected = true;
    this.chatHistory = [];

    // Detect host IP
    this.hostIp = this.detectHostIp();

    // Start TCP server — resolve after bind completes so port & key are valid
    return new Promise<NetworkInfo>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleIncoming(socket));
      this.server.on('error', (err) => {
        this.logger.error('Network server error', { error: String(err) });
        reject(err);
      });
      this.server.listen(0, '0.0.0.0', async () => {
        const addr = this.server?.address() as net.AddressInfo | null;
        this.serverPort = addr ? addr.port : 0;
        const mode = opts?.internetMode ?? 'auto';
        if (mode === 'manual' && opts?.manualIp && opts?.manualPort) {
          // User forwarded a port on the router manually — advertise it.
          this.internetMode = 'manual';
          this.publicIp = opts.manualIp;
          this.networkKey = this.encodeKey([opts.manualIp], opts.manualPort);
          this.logger.info('Network created (manual internet)', { ip: opts.manualIp, port: opts.manualPort });
        } else if (mode === 'auto') {
          // Try UPnP: map the network port on the router, then learn the
          // public IP via STUN. Falls back to LAN when the router blocks it.
          let mapped = false;
          try {
            const igd = await findIgd();
            if (igd) {
              const ok = await upnpAddPortMapping(igd, this.serverPort, this.serverPort, 'TCP');
              if (ok) {
                const pub = await getPublicIp();
                if (pub) {
                  this.upnpIgd = igd;
                  this.mappedPorts.add(this.serverPort);
                  this.publicIp = pub;
                  this.internetMode = 'upnp';
                  this.networkKey = this.encodeKey([pub], this.serverPort);
                  mapped = true;
                  this.logger.info('Network created (UPnP internet)', { publicIp: pub, port: this.serverPort });
                } else {
                  await upnpDeletePortMapping(igd, this.serverPort, 'TCP').catch(() => { /* ignore */ });
                }
              }
            }
          } catch (e) {
            this.logger.warn('UPnP mapping failed', { error: String(e) });
          }
          if (!mapped) {
            this.internetMode = 'lan';
            this.networkKey = this.encodeKey(await this.collectCandidateIps(), this.serverPort);
            // Best effort: learn the public IP anyway so the UI can hint at
            // manual port forwarding when the router lacks UPnP.
            void getPublicIp().then((p) => {
              if (p) {
                this.publicIp = p;
                this.emit();
              }
            });
            this.logger.info('Network created (LAN)', { ip: this.hostIp, port: this.serverPort });
          }
        } else {
          this.internetMode = 'lan';
          this.networkKey = this.encodeKey(await this.collectCandidateIps(), this.serverPort);
          this.logger.info('Network created (LAN)', { ip: this.hostIp, port: this.serverPort });
        }
        this.saveState();
        this.emit();
        resolve(this.getInfo());
      });
    });
  }

  joinNetwork(key: string, nick: string, uuid: string, skin: string | null, skinVariant: string | null, cape: string | null): NetworkInfo {
    this.leaveNetwork();
    this.selfNick = nick || 'Player';
    this.selfUuid = uuid || offlineUuid(this.selfNick);
    this.selfSkin = skin;
    this.selfSkinVariant = skinVariant;
    this.selfCape = cape;
    this.isHost = false;

    const decoded = this.decodeKey(key);
    if (!decoded) {
      throw new Error('Invalid network key');
    }
    this.hostInfo = { ip: decoded.ips[0], port: decoded.port, ips: decoded.ips };
    this.networkId = randomUUID();
    this.networkName = 'Joined Network';
    this.networkKey = key;
    this.chatHistory = [];
    this.connection = 'connecting';
    this.connectionError = null;
    this.wasConnected = false;
    this.connectFailures = [];

    this.connectToHost();

    return this.getInfo();
  }

  // Tries to connect to all candidate addresses concurrently (Happy Eyeballs).
  // The first socket to connect wins; the others are destroyed. This eliminates
  // the long delay when some IPs (like VirtualBox adapters) silently drop packets.
  private connectToHost() {
    const host = this.hostInfo;
    if (!host || host.ips.length === 0) return; // left the network while connecting
    
    let settled = false;
    const sockets: net.Socket[] = [];
    
    const onFail = (errCode: string) => {
      this.connectFailures.push(errCode);
      if (this.connectFailures.length === host.ips.length && !settled) {
        settled = true;
        const refused = this.connectFailures.includes('ECONNREFUSED');
        this.connection = 'disconnected';
        this.connectionError = refused
          ? `The host refused the connection (tried ${host.ips.join(', ')}:${host.port}). ` +
            `It may be offline, or Windows Firewall is blocking the port.`
          : `Could not reach the host (tried ${host.ips.join(', ')}:${host.port}). ` +
            `If you are on different networks, the host must use internet mode (Auto/Manual), ` +
            `or both of you must be on the same VPN/ZeroTier network.`;
        this.emit();
      }
    };

    for (const ip of host.ips) {
      const socket = net.createConnection({ port: host.port, host: ip });
      sockets.push(socket);
      
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        socket.destroy(new Error('timeout'));
      });
      
      socket.once('connect', () => {
        if (settled) {
          // We already connected to another IP, close this one
          socket.destroy();
          return;
        }
        settled = true;
        this.clientSocket = socket;
        
        // Update hostInfo.ip to the IP that actually succeeded
        if (this.hostInfo) {
          this.hostInfo.ip = ip;
        }
        
        // Destroy all other pending sockets
        for (const s of sockets) {
          if (s !== socket && !s.destroyed) s.destroy();
        }
        
        socket.setTimeout(0);
        this.logger.info('Connected to network host', { ip, port: host.port });
        this.connection = 'connected';
        this.connectionError = null;
        this.wasConnected = true;
        // Send identification
        this.sendToHost({
          type: 'identify',
          nick: this.selfNick,
          uuid: this.selfUuid,
          skin: this.selfSkin,
          skinVariant: this.selfSkinVariant,
          cape: this.selfCape,
        });
        this.ensureLanSocket();
        this.updateLanAnnouncement();
        this.saveState();
        this.emit();
      });
      
      socket.on('data', (data) => {
        if (this.clientSocket === socket) this.handleClientData(data);
      });
      
      socket.on('error', (err) => {
        if (this.clientSocket === socket && this.wasConnected) {
          this.logger.error('Network client error', { error: String(err) });
          this.connection = 'disconnected';
          this.connectionError = 'Connection to the host was lost.';
          this.updateLanAnnouncement();
          this.emit();
          return;
        }
        if (this.clientSocket === socket) return; // shouldn't happen if not connected
        if (!settled) {
          this.logger.info('Network connect attempt failed', { ip, port: host.port, error: String(err) });
          onFail((err as NodeJS.ErrnoException).code || 'timeout');
        }
      });
      
      socket.on('close', () => {
        if (this.clientSocket === socket) {
          this.clientBuffer = '';
          this.peers.clear();
          if (this.wasConnected) {
            this.logger.info('Disconnected from host');
            this.connection = 'disconnected';
            this.connectionError = 'Connection to the host was lost.';
            this.updateLanAnnouncement();
            this.emit();
          }
          return;
        }
        if (!settled) {
          this.logger.info('Network connect attempt closed', { ip, port: host.port });
          onFail('timeout');
        }
      });
    }
  }

  // Addresses advertised in a LAN-mode key: ZeroTier IPs first (reachable
  // from anywhere when both players joined the same ZeroTier network), then
  // ALL other IPv4 addresses (LAN, Radmin VPN, Hamachi, etc.). The client
  // will try to connect to all of them concurrently and use the first one
  // that succeeds, eliminating issues with virtual adapters dropping packets.
  private async collectCandidateIps(): Promise<string[]> {
    const ips: string[] = [];
    try {
      const zt = await getZeroTierIps();
      for (const ip of zt) if (!ips.includes(ip)) ips.push(ip);
    } catch { /* ZeroTier not available */ }
    
    try {
      for (const [, list] of Object.entries(os.networkInterfaces())) {
        for (const i of list || []) {
          if (i.family === 'IPv4' && !i.internal && i.address) {
            if (!ips.includes(i.address)) ips.push(i.address);
          }
        }
      }
    } catch { /* ignore */ }
    
    return ips.length ? ips : ['127.0.0.1'];
  }

  // Re-announces the host's LAN world locally (Minecraft's LAN discovery
  // protocol, 224.0.2.60:4445) while connected and the host has a game port,
  // so the world appears in the in-game Multiplayer LAN list. The real
  // announcement only travels within the host's subnet; for players on other
  // networks this spoofed one points at the address THIS client used to reach
  // the host (e.g. the ZeroTier IP).
  private updateLanAnnouncement() {
    const active =
      !this.isHost &&
      this.connection === 'connected' &&
      !!this.hostGamePort &&
      !!this.hostInfo?.ip &&
      this.hostGamePort > 0;
    if (active && !this.lanTimer) {
      this.sendLanAnnouncement();
      this.lanTimer = setInterval(() => this.sendLanAnnouncement(), MC_LAN_INTERVAL_MS);
    } else if (!active && this.lanTimer) {
      clearInterval(this.lanTimer);
      this.lanTimer = null;
      if (this.lanSocket) {
        try { this.lanSocket.close(); } catch { /* ignore */ }
        this.lanSocket = null;
      }
    }
  }

  private sendLanAnnouncement() {
    if (!this.hostInfo || !this.hostGamePort || !this.lanSocket) return;
    // If local proxy is active, announce 127.0.0.1 so Minecraft connects locally.
    // The launcher will then tunnel the traffic to the host.
    const ip = this.localProxyPort ? '127.0.0.1' : this.hostInfo.ip;
    const port = this.localProxyPort ? this.localProxyPort : this.hostGamePort;
    const payload = Buffer.from(`[MOTD]${this.networkName}[/MOTD][AD]${ip}:${port}[/AD]`);
    const send = (iface: string | null) => {
      try {
        if (iface) this.lanSocket!.setMulticastInterface(iface);
        this.lanSocket!.send(payload, 0, payload.length, MC_LAN_PORT, MC_LAN_GROUP, (err) => {
          if (err) this.logger.debug('LAN announce send failed', { error: String(err) });
        });
      } catch { /* one interface failing must not stop the others */ }
    };
    send(null);
    try {
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (isVirtualAdapter(name)) continue;
        for (const i of list || []) {
          if (i.family === 'IPv4' && !i.internal && i.address) send(i.address);
        }
      }
    } catch { /* ignore */ }
  }

  private ensureLanSocket() {
    if (this.lanSocket) return;
    try {
      this.lanSocket = dgram.createSocket('udp4');
      this.lanSocket.on('error', (err) => this.logger.debug('LAN announce socket error', { error: String(err) }));
    } catch {
      this.lanSocket = null;
    }
  }

  private startLocalProxy() {
    if (this.localProxyServer) return;
    this.localProxyServer = net.createServer((localSocket) => {
      if (!this.hostInfo || !this.hostInfo.ip) {
        localSocket.destroy();
        return;
      }
      const proxySocket = net.createConnection({ port: this.hostInfo.port, host: this.hostInfo.ip });
      proxySocket.once('connect', () => {
        proxySocket.write(JSON.stringify({ type: 'proxy' }) + '\n');
        localSocket.pipe(proxySocket);
        proxySocket.pipe(localSocket);
      });
      proxySocket.on('error', () => localSocket.destroy());
      localSocket.on('error', () => proxySocket.destroy());
      proxySocket.on('close', () => localSocket.destroy());
      localSocket.on('close', () => proxySocket.destroy());
    });
    this.localProxyServer.on('error', (err) => {
      this.logger.warn('Local proxy server error', { error: String(err) });
    });
    this.localProxyServer.listen(0, '127.0.0.1', () => {
      const addr = this.localProxyServer?.address() as net.AddressInfo | null;
      this.localProxyPort = addr ? addr.port : null;
      this.updateLanAnnouncement();
      this.emit();
    });
  }

  private stopLocalProxy() {
    if (this.localProxyServer) {
      try { this.localProxyServer.close(); } catch {}
      this.localProxyServer = null;
      this.localProxyPort = null;
      this.updateLanAnnouncement();
      this.emit();
    }
  }

  leaveNetwork() {
    this.clearState();
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.serverPort = 0;
    }
    if (this.clientSocket) {
      try { this.clientSocket.destroy(); } catch { /* ignore */ }
      this.clientSocket = null;
    }
    this.clientBuffer = '';
    this.stopLocalProxy();
    // Close all peer connections (if host)
    for (const [, peer] of this.peers) {
      try { peer.socket.destroy(); } catch { /* ignore */ }
    }
    this.peers.clear();
    // Remove UPnP port mappings (best effort)
    if (this.upnpIgd) {
      for (const p of this.mappedPorts) {
        void upnpDeletePortMapping(this.upnpIgd, p, 'TCP').catch(() => { /* ignore */ });
      }
    }
    this.mappedPorts.clear();
    this.networkId = null;
    this.networkName = '';
    this.networkKey = '';
    this.isHost = false;
    this.hostInfo = null;
    this.selfGamePort = null;
    this.hostGamePort = null;
    this.internetMode = 'lan';
    this.publicIp = null;
    this.upnpIgd = null;
    this._hostSkinFromPeer = null;
    this._hostSkinVariantFromPeer = null;
    this._hostCapeFromPeer = null;
    this.chatHistory = [];
    this.connection = 'connected';
    this.connectionError = null;
    this.wasConnected = false;
    this.updateLanAnnouncement();
    this.emit();
  }

  getInfo(): NetworkInfo {
    let selfIp = null;
    if (this.isHost) {
      selfIp = this.hostIp;
    } else if (this.clientSocket && this.clientSocket.localAddress) {
      selfIp = this.clientSocket.localAddress.replace(/^::ffff:/, '');
    }

    return {
      id: this.networkId || '',
      name: this.networkName,
      key: this.networkKey,
      isHost: this.isHost,
      hostIp: this.isHost ? this.hostIp : (this.hostInfo?.ip ?? null),
      hostPort: this.isHost ? this.serverPort : (this.hostInfo?.port ?? null),
      hostGamePort: this.isHost ? this.selfGamePort : this.hostGamePort,
      hostSkin: this.isHost ? this.selfSkin : this._hostSkinFromPeer,
      hostSkinVariant: this.isHost ? this.selfSkinVariant : this._hostSkinVariantFromPeer,
      hostCape: this.isHost ? this.selfCape : this._hostCapeFromPeer,
      selfNick: this.selfNick,
      selfUuid: this.selfUuid,
      selfSkin: this.selfSkin,
      selfSkinVariant: this.selfSkinVariant,
      selfCape: this.selfCape,
      selfGamePort: this.selfGamePort,
      selfIp,
      internetMode: this.internetMode,
      publicIp: this.publicIp,
      peers: this.getPeerList(),
      connection: this.connection,
      connectionError: this.connectionError,
      chatHistory: this.chatHistory,
      createdAt: Date.now(),
    };
  }

  isInNetwork(): boolean {
    return this.networkId !== null;
  }

  setSelfGamePort(port: number) {
    // Port 0 is sent to clear the advertised game port (LAN world closed).
    const next = port > 0 ? port : null;
    // When the world is reachable over the internet, map the game port on
    // the router too, so remote players can connect to publicIp:gamePort.
    if (next && this.internetMode === 'upnp' && this.upnpIgd && next !== this.selfGamePort) {
      void (async () => {
        const ok = await upnpAddPortMapping(this.upnpIgd!, next, next, 'TCP');
        if (ok) {
          this.mappedPorts.add(next);
          this.logger.info('Game port mapped via UPnP', { port: next });
        }
      })();
    } else if (!next && this.selfGamePort && this.upnpIgd) {
      const old = this.selfGamePort;
      if (this.mappedPorts.has(old)) {
        this.mappedPorts.delete(old);
        void upnpDeletePortMapping(this.upnpIgd, old, 'TCP').catch(() => { /* ignore */ });
      }
    }
    this.selfGamePort = next;
    // Notify peers about our game port
    if (this.isHost) {
      this.broadcastToPeers({ type: 'gamePort', port: this.selfGamePort });
    } else if (this.clientSocket) {
      this.sendToHost({ type: 'gamePort', port: this.selfGamePort });
    }
  }

  sendChat(text: string) {
    if (!text.trim()) return;
    const msg: NetworkChatMessage = {
      id: randomUUID(),
      senderNick: this.selfNick,
      senderUuid: this.selfUuid,
      text: text.trim(),
      timestamp: Date.now(),
    };
    if (this.isHost) {
      // Host: deliver to self + broadcast to all peers
      this.pushChatHistory(msg);
      this.onChat?.(msg);
      this.broadcastToPeers({ type: 'chat', ...msg });
    } else if (this.clientSocket) {
      // Client: send to the host, and echo locally so the sender sees
      // their own message immediately (the host only relays to OTHER peers).
      this.onChat?.(msg);
      this.sendToHost({ type: 'chat', ...msg });
    }
  }

  // Keeps a rolling history on the host so peers that join later (or the
  // page reloading) still see recent messages.
  private pushChatHistory(msg: NetworkChatMessage) {
    if (!this.isHost) return;
    this.chatHistory.push(msg);
    if (this.chatHistory.length > 100) {
      this.chatHistory = this.chatHistory.slice(-100);
    }
  }

  setSelfSkin(skin: string | null, variant: string | null, cape: string | null = null) {
    this.selfSkin = skin;
    this.selfSkinVariant = variant;
    this.selfCape = cape;
    if (this.isHost) {
      this.broadcastToPeers({ type: 'skin', skin, variant, cape });
    } else if (this.clientSocket) {
      this.sendToHost({ type: 'skin', skin, variant, cape });
    }
  }

  updateIdentity(nick: string, uuid: string, skin: string | null, skinVariant: string | null, cape: string | null) {
    if (!this.isInNetwork()) return;
    this.selfNick = nick || 'Player';
    this.selfUuid = uuid || offlineUuid(this.selfNick);
    this.selfSkin = skin;
    this.selfSkinVariant = skinVariant;
    this.selfCape = cape;
    this.saveState();
    
    if (this.isHost) {
      this.broadcastToPeers({
        type: 'hostInfo',
        nick: this.selfNick,
        uuid: this.selfUuid,
        skin: this.selfSkin,
        skinVariant: this.selfSkinVariant,
        cape: this.selfCape,
      });
    } else if (this.clientSocket) {
      this.sendToHost({
        type: 'identify',
        nick: this.selfNick,
        uuid: this.selfUuid,
        skin: this.selfSkin,
        skinVariant: this.selfSkinVariant,
        cape: this.selfCape,
      });
    }
    this.emit();
  }

  // ─── Internal: Host side ──────────────────────────────────────────────────

  private handleIncoming(socket: net.Socket) {
    const peerId = randomUUID();
    // On dual-stack sockets IPv4 peers report an IPv4-mapped address
    // (::ffff:10.0.0.34) — strip the prefix so the UI shows a plain IP.
    const ip = (socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const port = socket.remotePort || 0;
    
    let isProxy = false;
    let handshakeDone = false;
    let rawBuffer: Buffer | null = null;

    const peer: PeerConnection = {
      id: peerId,
      nick: '',
      uuid: '',
      socket,
      ip,
      port,
      skin: null,
      skinVariant: null,
      cape: null,
      connectedAt: Date.now(),
      gamePort: null,
      buffer: '',
    };

    const processBuffer = () => {
      let newlineIdx: number;
      while ((newlineIdx = peer.buffer.indexOf('\n')) !== -1) {
        const line = peer.buffer.slice(0, newlineIdx).trim();
        peer.buffer = peer.buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this.handleHostMessage(peer, msg);
        } catch { /* ignore malformed */ }
      }
    };

    const handshakeTimeout = setTimeout(() => {
      if (!handshakeDone && !socket.destroyed) socket.destroy();
    }, 5000);

    const onData = (data: Buffer) => {
      if (handshakeDone) {
        peer.buffer += data.toString('utf-8');
        processBuffer();
        return;
      }

      rawBuffer = rawBuffer ? Buffer.concat([rawBuffer, data]) : data;
      const idx = rawBuffer.indexOf('\n');
      if (idx !== -1) {
        const line = rawBuffer.slice(0, idx).toString('utf-8').trim();
        const remainder = rawBuffer.slice(idx + 1);
        handshakeDone = true;
        clearTimeout(handshakeTimeout);
        rawBuffer = null;

        try {
          const msg = JSON.parse(line);
          if (msg.type === 'proxy') {
            isProxy = true;
            socket.removeListener('data', onData);
            this.handleProxyConnection(socket, remainder);
            return;
          }
          
          // It's a control connection
          this.peers.set(peerId, peer);
          this.logger.info('Peer connected', { id: peerId, ip, port });
          
          this.handleHostMessage(peer, msg);
          if (remainder.length > 0) {
            peer.buffer += remainder.toString('utf-8');
            processBuffer();
          }
        } catch {
          socket.destroy();
        }
      }
    };

    socket.on('data', onData);

    socket.on('close', () => {
      if (isProxy) return;
      if (this.peers.has(peerId)) {
        this.logger.info('Peer disconnected', { id: peerId, nick: peer.nick });
        this.peers.delete(peerId);
        // Only notify if the peer actually completed identification
        if (peer.nick) {
          // Notify remaining peers
          this.broadcastToPeers({ type: 'peerLeave', peerId });
          this.emit();
          this.onPeerLeave?.(peerId);
        }
      }
    });

    socket.on('error', (err) => {
      if (isProxy) return;
      this.logger.warn('Peer socket error', { id: peerId, error: String(err) });
    });
  }

  private handleProxyConnection(socket: net.Socket, remainder: Buffer) {
    if (!this.selfGamePort) {
      socket.destroy();
      return;
    }
    const mcSocket = net.createConnection({ port: this.selfGamePort, host: '127.0.0.1' });
    mcSocket.once('connect', () => {
      if (remainder.length > 0) mcSocket.write(remainder);
      socket.pipe(mcSocket);
      mcSocket.pipe(socket);
    });
    mcSocket.on('error', () => socket.destroy());
    socket.on('error', () => mcSocket.destroy());
    socket.on('close', () => mcSocket.destroy());
    mcSocket.on('close', () => socket.destroy());
  }

  private handleHostMessage(peer: PeerConnection, msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'identify': {
        peer.nick = String(msg.nick || 'Unknown');
        peer.uuid = String(msg.uuid || offlineUuid(peer.nick));
        peer.skin = (msg.skin as string) || null;
        peer.skinVariant = (msg.skinVariant as string) || null;
        peer.cape = (msg.cape as string) || null;
        this.logger.info('Peer identified', { id: peer.id, nick: peer.nick });
        
        // Send host info
        this.sendToPeer(peer, {
          type: 'hostInfo',
          nick: this.selfNick,
          uuid: this.selfUuid,
          skin: this.selfSkin,
          skinVariant: this.selfSkinVariant,
          cape: this.selfCape,
          gamePort: this.selfGamePort,
        });
        
        // Send existing peers
        const existingPeers = this.getPeerList().map((p) => ({
          type: 'peerInfo' as const,
          id: p.id,
          nick: p.nick,
          uuid: p.uuid,
          ip: p.ip,
          port: p.port,
          skin: p.skin,
          skinVariant: p.skinVariant,
          cape: p.cape,
          gamePort: p.gamePort,
        }));
        for (const info of existingPeers) {
          if (info.id !== peer.id) this.sendToPeer(peer, info);
        }
        
        // Send recent chat history so the new peer sees the conversation.
        // Always send (even empty) so the client can drop stale messages from
        // a previous network.
        this.sendToPeer(peer, { type: 'chatHistory', messages: this.chatHistory });
        // Notify all other peers
        this.broadcastToPeersExcept(peer.id, {
          type: 'peerJoin',
          id: peer.id,
          nick: peer.nick,
          uuid: peer.uuid,
          ip: peer.ip,
          port: peer.port,
          skin: peer.skin,
          skinVariant: peer.skinVariant,
          cape: peer.cape,
          gamePort: null,
        });
        this.emit();
        this.onPeerJoin?.({
          id: peer.id,
          nick: peer.nick,
          uuid: peer.uuid,
          ip: peer.ip,
          port: peer.port,
          skin: peer.skin,
          skinVariant: peer.skinVariant,
          cape: peer.cape,
          connectedAt: peer.connectedAt,
          gamePort: null,
        });
        break;
      }
      case 'gamePort':
        peer.gamePort = Number(msg.port) || null;
        this.emit();
        this.onGamePort?.(peer.id, peer.gamePort || 0);
        break;
      case 'skin':
        peer.skin = (msg.skin as string) || null;
        peer.skinVariant = (msg.skinVariant as string) || null;
        peer.cape = (msg.cape as string) || null;
        this.onPeerSkinUpdate?.(peer.id, peer.uuid, peer.nick, peer.skin, peer.skinVariant, peer.cape);
        // Relay to all other peers
        this.broadcastToPeersExcept(peer.id, {
          type: 'skinUpdate',
          peerId: peer.id,
          skin: peer.skin,
          skinVariant: peer.skinVariant,
          cape: peer.cape,
        });
        break;
      case 'chat': {
        const chatMsg: NetworkChatMessage = {
          id: String(msg.id || randomUUID()),
          senderNick: peer.nick,
          senderUuid: peer.uuid,
          text: String(msg.text || ''),
          timestamp: Date.now(),
        };
        // Keep history for peers that join later.
        this.pushChatHistory(chatMsg);
        // Deliver to host
        this.onChat?.(chatMsg);
        // Relay to all other peers
        this.broadcastToPeersExcept(peer.id, { type: 'chat', ...chatMsg });
        break;
      }
    }
  }

  // ─── Internal: Client side ────────────────────────────────────────────────

  private handleClientData(data: Buffer) {
    if (!this.clientSocket) return;
    this.clientBuffer += data.toString();
    let newlineIdx: number;
    while ((newlineIdx = this.clientBuffer.indexOf('\n')) !== -1) {
      const line = this.clientBuffer.slice(0, newlineIdx).trim();
      this.clientBuffer = this.clientBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleClientMessage(msg);
      } catch { /* ignore malformed */ }
    }
  }

  private handleClientMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'hostInfo': {
        // Host is telling us about itself (skin, cape)
        this._hostSkinFromPeer = (msg.skin as string) || null;
        this._hostSkinVariantFromPeer = (msg.skinVariant as string) || null;
        this._hostCapeFromPeer = (msg.cape as string) || null;
        this.hostGamePort = (msg.gamePort as number) || null;
        if (this.hostGamePort) {
          this.startLocalProxy();
        } else {
          this.stopLocalProxy();
        }
        this.onHostInfo?.(
          String(msg.nick || ''),
          String(msg.uuid || ''),
          this._hostSkinFromPeer,
          this._hostSkinVariantFromPeer,
          this._hostCapeFromPeer,
        );
        // Add the host as a visible peer so clients see who they are
        // connected to (the host never appears via peerInfo/peerJoin).
        this.peers.set('host', {
          id: 'host',
          nick: String(msg.nick || ''),
          uuid: String(msg.uuid || ''),
          socket: null as unknown as net.Socket,
          ip: this.hostInfo?.ip ?? '',
          port: this.hostInfo?.port ?? 0,
          skin: this._hostSkinFromPeer,
          skinVariant: this._hostSkinVariantFromPeer,
          cape: this._hostCapeFromPeer,
          connectedAt: Date.now(),
          gamePort: this.hostGamePort,
          buffer: '',
        });
        this.emit();
        break;
      }
      case 'peerInfo':
      case 'peerJoin': {
        const peer: NetworkPeer = {
          id: String(msg.id),
          nick: String(msg.nick),
          uuid: String(msg.uuid),
          ip: String(msg.ip),
          port: Number(msg.port),
          skin: (msg.skin as string) || null,
          skinVariant: (msg.skinVariant as string) || null,
          cape: (msg.cape as string) || null,
          connectedAt: Date.now(),
          gamePort: (msg.gamePort as number) || null,
        };
        this.peers.set(peer.id, { ...peer, socket: null as unknown as net.Socket, buffer: '' } as PeerConnection);
        // Register peer skin in skin server (both existing and new peers)
        this.onPeerRegistered?.(peer);
        if (msg.type === 'peerJoin') {
          this.onPeerJoin?.(peer);
        }
        this.emit();
        break;
      }
      case 'peerLeave': {
        const peerId = String(msg.peerId);
        this.peers.delete(peerId);
        this.onPeerLeave?.(peerId);
        this.emit();
        break;
      }
      case 'gamePort': {
        const port = Number(msg.port) || 0;
        const peerId = String(msg.peerId || '');
        if (peerId) {
          const p = this.peers.get(peerId);
          if (p) {
            p.gamePort = port;
            this.onGamePort?.(peerId, port);
          }
        } else {
          // No peerId means the host is sending its own game port
          this.hostGamePort = port || null;
          if (this.hostGamePort) {
            this.startLocalProxy();
          } else {
            this.stopLocalProxy();
          }
          this.updateLanAnnouncement();
          const hostPeer = this.peers.get('host');
          if (hostPeer) {
            hostPeer.gamePort = this.hostGamePort;
            this.onGamePort?.('host', port);
          }
        }
        this.emit();
        break;
      }
      case 'skinUpdate': {
        const peerId = String(msg.peerId || '');
        const p = this.peers.get(peerId);
        if (p) {
          p.skin = (msg.skin as string) || null;
          p.skinVariant = (msg.skinVariant as string) || null;
          p.cape = (msg.cape as string) || null;
          // Mirror the host-side 'skin' handling: without this the skin
          // server keeps serving the old texture when a peer changes their
          // skin while the network is up.
          this.onPeerSkinUpdate?.(peerId, p.uuid, p.nick, p.skin, p.skinVariant, p.cape);
        }
        this.emit();
        break;
      }
      case 'chat': {
        const chatMsg: NetworkChatMessage = {
          id: String(msg.id || randomUUID()),
          senderNick: String(msg.senderNick || 'Unknown'),
          senderUuid: String(msg.senderUuid || ''),
          text: String(msg.text || ''),
          timestamp: Number(msg.timestamp) || Date.now(),
        };
        this.onChat?.(chatMsg);
        break;
      }
      case 'chatHistory': {
        // The host relays the recent conversation to peers that just joined.
        const history = (Array.isArray(msg.messages) ? msg.messages : []) as NetworkChatMessage[];
        const valid = history.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string');
        this.chatHistory = valid;
        this.onChatHistory?.(valid);
        this.emit();
        break;
      }
    }
  }

  // ─── Internal: Messaging ──────────────────────────────────────────────────

  private sendToHost(msg: Record<string, unknown>) {
    if (!this.clientSocket) return;
    try {
      this.clientSocket.write(JSON.stringify(msg) + '\n');
    } catch { /* ignore */ }
  }

  private sendToPeer(peer: PeerConnection, msg: Record<string, unknown>) {
    if (!peer.socket) return;
    try {
      peer.socket.write(JSON.stringify(msg) + '\n');
    } catch { /* ignore */ }
  }

  private broadcastToPeers(msg: Record<string, unknown>) {
    for (const [, peer] of this.peers) {
      this.sendToPeer(peer, msg);
    }
  }

  private broadcastToPeersExcept(excludeId: string, msg: Record<string, unknown>) {
    for (const [id, peer] of this.peers) {
      if (id !== excludeId) {
        this.sendToPeer(peer, msg);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getPeerList(): NetworkPeer[] {
    return [...this.peers.values()]
      .filter((p) => p.nick) // only identified peers
      .map((p) => ({
        id: p.id,
        nick: p.nick,
        uuid: p.uuid,
        ip: p.ip,
        port: p.port,
        skin: p.skin,
        skinVariant: p.skinVariant,
        cape: p.cape,
        connectedAt: p.connectedAt,
        gamePort: p.gamePort,
      }));
  }

  private detectHostIp(): string {
    // Same LAN-subnet-preferring logic as the skin server, so the Network key
    // and the texture URLs both advertise an IP the peers can reach.
    return detectLanIp();
  }

  // Key format: base64url "ip1|ip2|...:port". IPv6 hosts are bracketed so the
  // port always follows the last colon. Multiple addresses (e.g. ZeroTier and
  // LAN) are tried in order by the client.
  private encodeKey(ips: string[], port: number): string {
    const hosts = ips.map((ip) => (ip.includes(':') ? `[${ip}]` : ip));
    return Buffer.from(`${hosts.join('|')}:${port}`).toString('base64url');
  }

  private decodeKey(key: string): { ips: string[]; port: number } | null {
    try {
      const raw = Buffer.from(key, 'base64url').toString('utf-8');
      const idx = raw.lastIndexOf(':');
      if (idx === -1) return null;
      const hostPart = raw.slice(0, idx);
      const port = parseInt(raw.slice(idx + 1), 10);
      if (!hostPart || !port || port < 1 || port > 65535) return null;
      const ips = hostPart
        .split('|')
        .map((h) => h.trim().replace(/^\[|\]$/g, ''))
        .filter(Boolean);
      if (ips.length === 0) return null;
      return { ips, port };
    } catch {
      return null;
    }
  }

  private emit() {
    this.onUpdate?.();
  }
}