import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import type { DatabaseService } from './database.js';
import type { SettingsStore } from './settings-store.js';
import type { Logger } from './logger.js';
import { pngDimensions, resizePng } from './png-utils.js';
import { getZeroTierIps } from './zerotier.js';
import type { SkinDirectory } from './skin-directory.js';
import { fetchElyByTextures } from './elyby.js';

// Names of virtual adapters that must not be treated as LAN interfaces.
// VirtualBox Host-Only (192.168.56.x), VMware, Hyper-V vEthernet, ZeroTier
// (10.147.x.x) and VPNs all look like LAN addresses but are unreachable from
// the other machine, so picking them breaks texture fetches and Network
// connections between two real computers.
const VIRTUAL_ADAPTER_HINTS = [
  'virtualbox', 'vbox', 'vmware', 'hyper-v', 'vethernet', 'zerotier',
  'radmin', 'hamachi', 'tailscale', 'wireguard', 'wintun', 'openvpn',
  'npcap', 'tap', 'tun', 'bluetooth', 'loopback', 'vpn',
];

export function isVirtualAdapter(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return VIRTUAL_ADAPTER_HINTS.some((h) => n.includes(h));
}

// Picks the most reachable IPv4 for LAN peers.
// Physical LAN subnets (192.168.x.x / 10.x.x.x / 172.16-31.x.x) are preferred
// over VPN adapters because texture URLs embedded in profile JSON must be
// reachable from peers on the same Wi-Fi/router. VPN IPs like Radmin 26.x
// are not RFC1918 and are unreachable from pure LAN peers, so advertising
// them breaks skin fetches on third-party/Offline LAN servers.
// VPN skins are already shared via the Network TCP channel (peerSkins) and
// via presence broadcast, so LAN HTTP textures should stay on the physical LAN.
export function detectLanIp(): string {
  try {
    const vpn: string[] = [];
    const physical: string[] = [];
    const all: string[] = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      const n = name.toLowerCase();
      // Strictly ignore VirtualBox/Hyper-V/VMware adapters
      if (n.includes('virtualbox') || n.includes('vbox') || n.includes('vmware') || n.includes('hyper-v') || n.includes('vethernet')) {
        continue;
      }
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal && i.address) {
          // VirtualBox sometimes uses 192.168.56.x even if the name doesn't match
          if (i.address.startsWith('192.168.56.')) continue;
           
          all.push(i.address);
          if (n.includes('radmin') || n.includes('hamachi') || n.includes('zerotier') || n.includes('tailscale')) {
            vpn.push(i.address);
          } else if (!isVirtualAdapter(name)) {
            physical.push(i.address);
          }
        }
      }
    }
    const pick = (arr: string[]): string | undefined =>
      arr.find((a) => /^192\.168|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a)) ?? arr[0];
    
    // Prefer physical LAN first; VPN only as fallback when no LAN is present.
    return pick(physical) ?? pick(vpn) ?? pick(all) ?? '127.0.0.1';
  } catch { /* fall through to localhost */ }
  return '127.0.0.1';
}

// Offline player UUID derivation — must match the one used at launch time
// (OfflinePlayer:<name> md5 with version-3/4 bits set).
export function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Matches an incoming dashless offline UUID against a stored (possibly
// lowercased) skin key plus known original-case nicks. Offline UUIDs are
// md5("OfflinePlayer:<EXACT name>") — "Sigmultra452" and "sigmultra452" are
// different players — while skin keys are stored lowercased, so the exact
// case must come from a known source. Returns the nick case that produced
// the match, or null.
export function resolveOfflineUuidMatch(uuidDashless: string, storedUsername: string, knownNicks: string[]): string | null {
  const target = String(uuidDashless).replace(/-/g, '').toLowerCase();
  const tried = new Set<string>();
  for (const cand of [storedUsername, storedUsername.toLowerCase(), ...knownNicks]) {
    const c = String(cand || '');
    if (!c || tried.has(c)) continue;
    tried.add(c);
    if (offlineUuid(c).replace(/-/g, '').toLowerCase() === target) return c;
  }
  return null;
}

interface SkinRow {
  username: string;
  skin_data: string | null;
  cape_data: string | null;
  variant: string | null;
}

// A tiny local HTTP server that stands in for Mojang's session server while the
// launcher runs. Launcher clients are launched with
// `-Dminecraft.api.session.host=http://127.0.0.1:<port>`, so every profile and
// texture request the game makes goes through here. Offline accounts with a
// custom skin get the correct profile JSON back; everything else is proxied to
// the real session server — which means Microsoft players still see their
// genuine skins, and offline skins are only visible to clients started from
// this launcher.
// Skins of friends running this launcher on the same network arrive via the
// LAN presence broadcasts; the skin server resolves them when the game asks
// for a profile that isn't in the local database.
export type FriendSkinResolver = (uuidDashless: string) => {
  username: string;
  skin: string | null;
  variant: string | null;
} | null;export type FriendSkinNameResolver = (nick: string) => {
  username: string;
  skin: string | null;
  variant: string | null;
} | null;

// Network peer skins: when peers connect via the Network tab their skin data
// is sent in the TCP identify message.  The skin server needs this to resolve
// profiles/textures for players on OTHER machines (their local skin server
// doesn't know our offline skins).  Stored keyed by dashless UUID.
interface NetworkPeerSkin {
  username: string;
  uuid: string;
  skin: string | null;
  skinVariant: string | null;
  cape: string | null;
}


export class SkinServer {
  private server: http.Server | null = null;
  private port = 0;
  private friendSkinResolver: FriendSkinResolver | null = null;
  private friendSkinNameResolver: FriendSkinNameResolver | null = null;
  private networkPeerSkins = new Map<string, NetworkPeerSkin>();
  // Downscaled 64x64/64x32 buffers keyed by content hash, so re-uploads
  // naturally invalidate old entries. Kept small (each entry is a few KB).
  private resizeCache = new Map<string, Buffer>();
  // The host's LAN IP — used in texture URLs so remote clients can reach
  // the skin server.  Detected once at startup; safe to cache.
  private hostIp: string = '127.0.0.1';
  private skinDirectory: SkinDirectory | null = null;
  // Cache for ely.by textures (nick lower -> base64) to avoid refetching every profile request
  private elyByCache = new Map<string, { skin: string | null; cape: string | null; variant: string | null; fetchedAt: number }>();
  // Recent nicks seen via hasJoined (username -> uuid mapping) to allow ely.by fallback for uuid-based profile requests
  private recentNicks = new Set<string>();

  constructor(
    private db: DatabaseService,
    private settingsStore: SettingsStore,
    private logger: Logger,
  ) {}

  // "HD textures in-game" setting: serve original-resolution skins/capes
  // instead of the vanilla 64x64/64x32 downscale. Intended for clients that
  // can render HD textures (OptiFine, CustomSkinLoader).
  hdMode(): boolean {
    try {
      return !!this.settingsStore.load().hdTexturesInGame;
    } catch {
      return false;
    }
  }

  // Serves a texture PNG. By default HD files (larger than the vanilla
  // 64x64/64x32 grid) are downscaled so vanilla renders them correctly; when
  // HD mode is on (or the URL asks for ?hd=1) the original file is served.
  private serveTexturePng(
    res: http.ServerResponse,
    base64: string,
    kind: 'skin' | 'cape',
    cacheKey: string,
    params?: URLSearchParams,
  ) {
    let buf: Buffer | null = null;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      /* fall through to 204 */
    }
    if (!buf || buf.length === 0) {
      if (!res.headersSent) {
        res.writeHead(204);
        res.end();
      }
      return;
    }

    const wantHd =
      params?.get('hd') === '1' ? true : params?.get('sd') === '1' ? false : this.hdMode();
    const dims = pngDimensions(buf);
    if (!wantHd && dims) {
      const legacy = kind === 'cape' || dims.width !== dims.height;
      const targetW = 64;
      const targetH = legacy ? 32 : 64;
      if (dims.width > targetW || dims.height > targetH) {
        const key = `${cacheKey}:${createHash('sha1').update(base64).digest('hex').slice(0, 12)}`;
        let resized: Buffer | null = this.resizeCache.get(key) ?? null;
        if (!resized) {
          resized = resizePng(buf, targetW, targetH);
          if (resized) {
            if (this.resizeCache.size > 1000) this.resizeCache.clear();
            this.resizeCache.set(key, resized);
          }
        }
        if (resized) buf = resized;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(buf);
  }

  setFriendSkinResolver(resolver: FriendSkinResolver | null) {
    this.friendSkinResolver = resolver;
  }

  setFriendSkinNameResolver(resolver: FriendSkinNameResolver | null) {
    this.friendSkinNameResolver = resolver;
  }

  setSkinDirectory(dir: SkinDirectory | null) {
    this.skinDirectory = dir;
  }

  // Called by the Network service when a peer joins or updates their skin.
  setNetworkPeerSkin(uuidDashless: string, username: string, skin: string | null, skinVariant: string | null, cape: string | null) {
    this.networkPeerSkins.set(uuidDashless, { username, uuid: uuidDashless, skin, skinVariant, cape });
  }

  removeNetworkPeerSkin(uuidDashless: string) {
    this.networkPeerSkins.delete(uuidDashless);
  }

  start() {
    if (this.server) return;
    this.detectHostIp();
    this.server = http.createServer((req, res) => void this.handle(req, res));
    // Bind to 0.0.0.0 so LAN clients can reach the texture endpoints.
    this.server.listen(0, '0.0.0.0', () => {
      const addr = this.server?.address() as AddressInfo | null;
      this.port = addr ? addr.port : 0;
      this.logger.info('Skin server started', { port: this.port, hostIp: this.hostIp });
    });
    this.server.on('error', (err) => {
      this.logger.error('Skin server error', { error: String(err) });
    });
    // Texture URLs embedded in profiles must point at an IP the peers can
    // reach. When this machine is on a ZeroTier network, that IP works for
    // players on other networks (the Network tab), otherwise the LAN IP is
    // advertised. Refresh again whenever a network is created/joined.
    void this.refreshHostIp();
  }

  // Picks the IP advertised in texture URLs: the first IPv4 ZeroTier address
  // (reachable from players on other networks via the Network tab), falling
  // back to the real LAN IP (reachable from players on the same Wi-Fi/router).
  async refreshHostIp(): Promise<void> {
    try {
      const zt = await getZeroTierIps();
      const ipv4 = zt.find((ip) => !ip.includes(':'));
      if (ipv4) {
        this.hostIp = ipv4;
        this.logger.info('Skin server advertising ZeroTier IP', { hostIp: this.hostIp });
        return;
      }
    } catch { /* ZeroTier not available */ }
    this.detectHostIp();
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.port = 0;
    }
  }

  getSessionHost(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  getPort(): number {
    return this.port;
  }

  getHostIp(): string {
    return this.hostIp;
  }

  isRunning(): boolean {
    return this.server !== null && this.port > 0;
  }

  // Detect the host's LAN IP — prefer LAN subnets so remote machines on the
  // same network can actually reach the texture endpoints (a VPN adapter's
  // 26.x address would be unreachable from a peer on the LAN).
  private detectHostIp() {
    this.hostIp = detectLanIp();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const url = new URL(req.url || '/', this.getSessionHost());
      const pathname = url.pathname;

      // /session/minecraft/profile/<uuid>[/hasJoined] — profile lookup
      const profileMatch = pathname.match(/^\/session\/minecraft\/profile\/([0-9a-fA-F-]{32,36})(?:\/(hasJoined))?$/);
      if (profileMatch) {
        const uuid = profileMatch[1].replace(/-/g, '').toLowerCase();
        const row = this.findOfflineSkinByUuid(uuid);
        if (row && (row.skin_data || row.cape_data)) {
          this.serveProfile(res, row, uuid);
          return;
        }
        // Remote skin directory (third-party servers): two launcher users on a
        // foreign offline-mode server have no LAN / Network link. Try the
        // directory by UUID before falling back to Mojang.
        if (this.skinDirectory?.isEnabled()) {
          const remote = await this.skinDirectory.lookupByUuid(uuid);
          if (remote && (remote.skin || remote.cape)) {
            this.serveProfile(res, { username: remote.username || uuid, skin_data: remote.skin, cape_data: remote.cape, variant: remote.variant }, uuid);
            return;
          }
        }
        // Ely.by fallback (like TLauncher) — try to resolve offline uuid via ely.by
        // by reverse-mapping uuid -> nick from known DB nicks, then fetching ely.by textures.
        // This makes skins work "out of the box" on any server without manual skinDirectoryUrl.
        const elyRow = await this.tryElyByForUuid(uuid);
        if (elyRow && (elyRow.skin_data || elyRow.cape_data)) {
          this.serveProfile(res, elyRow, uuid);
          return;
        }
        // No custom skin — forward to the real session server (returns 204 for
        // unknown offline uuids, real skins for Microsoft accounts).
        this.proxy(req, res, pathname, url.search);
        return;
      }

      // /textures/<uuid> — the actual skin PNG
      const textureMatch = pathname.match(/^\/textures\/([0-9a-fA-F-]{32,36})$/);
      if (textureMatch) {
        const uuid = textureMatch[1].replace(/-/g, '').toLowerCase();
        const row = this.findOfflineSkinByUuid(uuid);
        if (row && row.skin_data) {
          this.serveTexturePng(res, row.skin_data, 'skin', `skin:${uuid}`, url.searchParams);
          return;
        }
        if (this.skinDirectory?.isEnabled()) {
          const remote = await this.skinDirectory.lookupByUuid(uuid);
          if (remote?.skin) {
            this.serveTexturePng(res, remote.skin, 'skin', `skin:${uuid}`, url.searchParams);
            return;
          }
        }
        const elyRow = await this.tryElyByForUuid(uuid);
        if (elyRow?.skin_data) {
          this.serveTexturePng(res, elyRow.skin_data, 'skin', `skin:${uuid}`, url.searchParams);
          return;
        }
        // No local skin: this may be a premium (Microsoft) player — resolve
        // their real skin through Mojang's session server so friend heads and
        // in-game skins of premium players still appear.
        this.proxyPremiumTexture(res, uuid, false);
        return;
      }

      // /MinecraftSkins/<name>.png — legacy skin-by-name endpoint used by
      // pre-1.7 clients (1.0–1.6.4) after the launcher rewrites their hardcoded
      // skin host to this server.
      const legacySkinMatch = pathname.match(/^\/MinecraftSkins\/([A-Za-z0-9_-]{1,32})\.png$/);
      if (legacySkinMatch) {
        this.serveLegacyTexture(res, legacySkinMatch[1], false);
        return;
      }

      // /MinecraftCloaks/<name>.png — legacy cape-by-name endpoint (1.0–1.6.4).
      const legacyCloakMatch = pathname.match(/^\/MinecraftCloaks\/([A-Za-z0-9_-]{1,32})\.png$/);
      if (legacyCloakMatch) {
        this.serveLegacyTexture(res, legacyCloakMatch[1], true);
        return;
      }

      // /textures/<uuid>/cape — the custom cape PNG
      const capeMatch = pathname.match(/^\/textures\/([0-9a-fA-F-]{32,36})\/cape$/);
      if (capeMatch) {
        const uuid = capeMatch[1].replace(/-/g, '').toLowerCase();
        const row = this.findOfflineSkinByUuid(uuid);
        if (row && row.cape_data) {
          this.serveTexturePng(res, row.cape_data, 'cape', `cape:${uuid}`, url.searchParams);
          return;
        }
        if (this.skinDirectory?.isEnabled()) {
          const remote = await this.skinDirectory.lookupByUuid(uuid);
          if (remote?.cape) {
            this.serveTexturePng(res, remote.cape, 'cape', `cape:${uuid}`, url.searchParams);
            return;
          }
        }
        const elyRow = await this.tryElyByForUuid(uuid);
        if (elyRow?.cape_data) {
          this.serveTexturePng(res, elyRow.cape_data, 'cape', `cape:${uuid}`, url.searchParams);
          return;
        }
        this.proxyPremiumTexture(res, uuid, true);
        return;
      }

      // /session/minecraft/join — client-side session registration. When a
      // player connects to a LAN/integrated server the client calls this
      // endpoint with its accessToken + serverId.  Mojang rejects offline
      // tokens ("0") with a 204, which causes "Недействительная сессия" on
      // the connecting client.  Accept every join request so offline players
      // can connect to LAN worlds launched from this launcher.
      // For premium (JWT) tokens we MUST proxy to Mojang so external
      // online-mode servers can validate the session (hasJoined). Fake 204
      // is only for offline tokens ("0") which Mojang would reject anyway.
      if (pathname === '/session/minecraft/join' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          if (res.headersSent) return;
          let isPremium = false;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            isPremium = typeof body.accessToken === 'string' && /^eyJ/.test(body.accessToken);
          } catch { /* treat as offline */ }
          if (isPremium) {
            // Proxy the premium join to the real session server so Mojang
            // records the serverId — required for hasJoined on external
            // online-mode servers (Hypixel etc).
            const upstreamHost = this.upstreamFor(pathname);
            const target = `https://${upstreamHost}${pathname}${url.search}`;
            const bodyBuf = Buffer.concat(chunks);
            const proxyReq = https.request(
              target,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': bodyBuf.length,
                  'User-Agent': 'SlimeLauncher/1.0.0',
                  host: upstreamHost,
                },
              },
              (upstream) => {
                if (!res.headersSent) res.writeHead(upstream.statusCode || 500, upstream.headers);
                upstream.pipe(res);
              },
            );
            proxyReq.on('error', (err) => {
              this.logger.debug('Session join proxy failed', { error: String(err) });
              if (!res.headersSent) { res.writeHead(204); res.end(); }
              else res.destroy();
            });
            proxyReq.write(bodyBuf);
            proxyReq.end();
            return;
          }
          res.writeHead(204);
          res.end();
        });
        return;
      }

      // /session/minecraft/hasJoined?username=X&serverId=Y — session validation
      // endpoint used by the integrated server to verify joining players in
      // online-mode.  For offline accounts Mojang would return 204 (unknown),
      // which prevents LAN joins.  Intercept the request and return a valid
      // profile for every player we know about (offline accounts, Microsoft
      // accounts, friends via presence, plus ely.by like TLauncher).
      // For Microsoft (premium) accounts we proxy to Mojang first so external
      // online-mode servers can validate the real Mojang session (otherwise
      // "You are not logged into your Minecraft account" on Hypixel etc).
      if (pathname === '/session/minecraft/hasJoined') {
        const username = url.searchParams.get('username');
        if (username) {
          // Cache for later uuid -> nick ely.by lookups
          if (this.recentNicks.size > 200) this.recentNicks.clear();
          this.recentNicks.add(username);
          // Microsoft accounts -> proxy to real session server
          let isMs = false;
          if (this.db.isReady()) {
            try {
              const row = this.db.prepare('SELECT 1 FROM microsoft_accounts WHERE lower(username)=lower(?)').get(username) as unknown;
              if (row) isMs = true;
            } catch { /* ignore */ }
          }
          if (isMs) {
            this.proxy(req, res, pathname, url.search);
            return;
          }
          // Try sync first (fast path), then async ely.by fallback
          const profile = this.resolveHasJoined(username);
          if (profile) {
            // If profile has no textures, try ely.by before returning
            if (!profile.properties) {
              const ely = await fetchElyByTextures(username, this.logger);
              if (ely && (ely.skin || ely.cape)) {
                const uuid = offlineUuid(username).replace(/-/g, '').toLowerCase();
                const texProp = this.buildTextureProperty(uuid, ely.skin, ely.cape, ely.variant);
                const full = { id: uuid, name: username, ...(texProp ? { properties: [texProp] } : {}) };
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' });
                res.end(JSON.stringify(full));
                return;
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' });
            res.end(JSON.stringify(profile));
            return;
          }
        }
        // Unknown user — proxy to Mojang (returns 204 for real offline names).
        this.proxy(req, res, pathname, url.search);
        return;
      }

      // Anything else — proxy (join requests etc.)
      this.proxy(req, res, pathname, url.search);
    } catch (err) {
      this.logger.error('Skin server handler error', { error: String(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  // Fetches a premium player's real skin/cape from Mojang and pipes the PNG
  // back. Returns 204 for uuids with no profile or no texture (the same
  // semantics as the session server) so the client treats it as "no skin".
  private proxyPremiumTexture(res: http.ServerResponse, uuidDashless: string, cape: boolean) {
    const dashed = uuidDashless.replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5');
    const profileUrl = `https://sessionserver.mojang.com/session/minecraft/profile/${dashed}?unsigned=true`;
    const fail = () => {
      if (!res.headersSent) {
        res.writeHead(204);
        res.end();
      }
    };
    const req = https.get(profileUrl, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (profileRes) => {
      if (profileRes.statusCode !== 200) {
        profileRes.resume();
        fail();
        return;
      }
      let data = '';
      profileRes.on('data', (c) => (data += c));
      profileRes.on('end', () => {
        try {
          const profile = JSON.parse(data) as { properties?: Array<{ name: string; value: string }> };
          const texturesProp = (profile.properties || []).find((p) => p.name === 'textures');
          if (!texturesProp?.value) {
            fail();
            return;
          }
          const textures = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8')) as {
            textures?: { SKIN?: { url?: string }; CAPE?: { url?: string } };
          };
          const url = cape ? textures?.textures?.CAPE?.url : textures?.textures?.SKIN?.url;
          if (!url) {
            fail();
            return;
          }
          // Mojang serves textures over plain http.
          const texClient = url.startsWith('https') ? https : http;
          const texReq = texClient.get(url, (texRes) => {
            res.writeHead(texRes.statusCode || 200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=3600',
            });
            texRes.pipe(res);
          });
          texReq.on('error', fail);
        } catch {
          fail();
        }
      });
    });
    req.on('error', fail);
  }

  // Legacy name-based skin lookup: local database first, then a friend's
  // broadcast skin, then ely.by (like TLauncher) then Mojang's old s3 bucket.
  private async serveLegacyTextureAsync(res: http.ServerResponse, name: string, cape: boolean) {
    const kind: 'skin' | 'cape' = cape ? 'cape' : 'skin';
    const serve = (data: string | null | undefined) => {
      if (!data) {
        if (!res.headersSent) {
          res.writeHead(204);
          res.end();
        }
        return;
      }
      this.serveTexturePng(res, data, kind, `legacy:${kind}:${name}`);
    };

    try {
      if (this.db.isReady()) {
        const row = this.db.prepare(
          cape
            ? 'SELECT cape_data FROM offline_skins WHERE lower(username) = lower(?) AND cape_data IS NOT NULL'
            : 'SELECT skin_data, variant FROM offline_skins WHERE lower(username) = lower(?) AND skin_data IS NOT NULL'
        ).get(name) as { skin_data?: string; cape_data?: string } | undefined;
        if (cape) {
          if (row?.cape_data) { serve(row.cape_data); return; }
        } else {
          if (row?.skin_data) { serve(row.skin_data); return; }
        }
      }
      // Friend running the same launcher on the LAN?
      if (this.friendSkinNameResolver) {
        const friend = this.friendSkinNameResolver(name);
        if (friend) {
          if (cape) { serve(null); return; }
          if (friend.skin) { serve(friend.skin); return; }
        }
      }
      // Ely.by fallback (TLauncher-style) — nick-based, works out of the box
      const ely = await fetchElyByTextures(name, this.logger);
      if (ely) {
        if (cape && ely.cape) { serve(ely.cape); return; }
        if (!cape && ely.skin) { serve(ely.skin); return; }
      }
    } catch (e) {
      this.logger.error('Legacy skin lookup failed', { error: String(e) });
    }
    // Fallback to sync version for remaining s3 proxy
    this.serveLegacyTextureSync(res, name, cape);
  }

  private serveLegacyTexture(res: http.ServerResponse, name: string, cape: boolean) {
    void this.serveLegacyTextureAsync(res, name, cape);
  }

  // Sync fallback for s3 proxy (kept for compatibility, called by async above)
  private serveLegacyTextureSync(res: http.ServerResponse, name: string, cape: boolean) {
    const serve = (data: string | null | undefined) => {
      if (!data) {
        if (!res.headersSent) { res.writeHead(204); res.end(); }
        return;
      }
      const kind: 'skin' | 'cape' = cape ? 'cape' : 'skin';
      this.serveTexturePng(res, data as string, kind, `legacy:${kind}:${name}`);
    };

    // Not a launcher user — try Mojang's legacy s3 bucket so old premium
    // accounts still show their (legacy) skin/cape.
    const s3Host = cape ? 's3.amazonaws.com/MinecraftCloaks' : 's3.amazonaws.com/MinecraftSkins';
    const req = https.get(`https://${s3Host}/${encodeURIComponent(name)}.png`, (s3res) => {
      if (s3res.statusCode && s3res.statusCode >= 400) {
        s3res.resume();
        serve(null);
        return;
      }
      res.writeHead(s3res.statusCode || 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      s3res.pipe(res);
    });
    req.on('error', () => serve(null));
  }

  // Resolves a hasJoined check for a given username.  Returns a Mojang-style
  // profile JSON (including the `properties` array with texture data) when the
  // player is known to the launcher (offline account, Microsoft account, or
  // LAN friend) so the integrated server accepts the connection.
  // Returns null only for truly unknown names, falling through to the real
  // session server.
  private resolveHasJoined(username: string): { id: string; name: string; properties?: Array<{ name: string; value: string }> } | null {
    // 1. Microsoft account — use the real UUID.
    if (this.db.isReady()) {
      try {
        const ms = this.db.prepare(
          'SELECT uuid, username FROM microsoft_accounts WHERE lower(username) = lower(?)'
        ).get(username) as { uuid: string; username: string } | undefined;
        if (ms) {
          const dashless = ms.uuid.replace(/-/g, '');
          const texProp = this.buildTextureProperty(dashless);
          return { id: dashless, name: ms.username, ...(texProp ? { properties: [texProp] } : {}) };
        }
      } catch { /* ignore */ }
    }
    // 2. Offline skin entry — derive UUID from the name.
    if (this.db.isReady()) {
      try {
        const row = this.db.prepare(
          'SELECT username, skin_data, cape_data, variant FROM offline_skins WHERE lower(username) = lower(?)'
        ).get(username) as { username: string; skin_data: string | null; cape_data: string | null; variant: string | null } | undefined;
        if (row) {
          // Derive from the REQUESTED name (exact case): offline UUIDs are
          // md5("OfflinePlayer:<exact name>"). Deriving from the lowercased DB
          // key would hand the server a UUID that doesn't match the joining
          // player (kick / skin bound to a phantom uuid).
          const uuid = offlineUuid(username).replace(/-/g, '');
          const texProp = this.buildTextureProperty(uuid, row.skin_data, row.cape_data, row.variant);
          return { id: uuid, name: username, ...(texProp ? { properties: [texProp] } : {}) };
        }
      } catch { /* ignore */ }
    }
    // 3. Any other name: still allow the join by returning a derived offline UUID.
    //    This covers SlimeLauncher accounts that haven't set a custom skin and
    //    friends discovered via LAN presence whose skins haven't been cached yet.
    const uuid = offlineUuid(username).replace(/-/g, '');
    const texProp = this.buildTextureProperty(uuid);
    return { id: uuid, name: username, ...(texProp ? { properties: [texProp] } : {}) };
  }

  // Builds a Mojang-style `textures` property entry for the given UUID.
  // Returns null when there is no skin data to serve (profile still works,
  // just without a texture).
  private buildTextureProperty(
    uuidDashless: string,
    skinData?: string | null,
    capeData?: string | null,
    variant?: string | null,
  ): { name: string; value: string } | null {
    const row = skinData !== undefined
      ? { skin_data: skinData, cape_data: capeData ?? null, variant: variant ?? null }
      : this.findOfflineSkinByUuid(uuidDashless);
    if (!row || (!row.skin_data && !row.cape_data)) return null;
    const texHost = this.hostIp !== '127.0.0.1' ? `http://${this.hostIp}:${this.port}` : this.getSessionHost();
    const hd = this.hdMode();
    const texSuffix = hd ? '?hd=1' : '?sd=1';
    const textures: Record<string, unknown> = {
      timestamp: Date.now(),
      profileId: uuidDashless,
      profileName: '',
      textures: {} as Record<string, unknown>,
    };
    if (row.skin_data) {
      (textures.textures as Record<string, unknown>).SKIN = {
        url: `${texHost}/textures/${uuidDashless}${texSuffix}`,
        metadata: row.variant === 'slim' ? { model: 'slim' } : undefined,
      };
    }
    if (row.cape_data) {
      (textures.textures as Record<string, unknown>).CAPE = {
        url: `${texHost}/textures/${uuidDashless}/cape${texSuffix}`,
      };
    }
    return { name: 'textures', value: Buffer.from(JSON.stringify(textures)).toString('base64') };
  }

  // Nicknames in original case from every source this machine knows (recently
  // seen players, saved offline accounts, active user). Needed because skin
  // keys are stored lowercased while UUID matching requires the exact case.
  private knownNickCases(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (n: unknown) => {
      const s = String(n || '').trim();
      if (!s || s.length > 24 || seen.has(s.toLowerCase())) return;
      seen.add(s.toLowerCase());
      out.push(s);
    };
    for (const n of this.recentNicks) add(n);
    if (this.db.isReady()) {
      try {
        const rows = this.db.prepare("SELECT nick FROM saved_accounts WHERE kind = 'offline'").all() as Array<{ nick: string }>;
        for (const r of rows) add(r.nick);
      } catch { /* ignore */ }
      try {
        const tokenRow = this.db.prepare("SELECT value FROM settings WHERE key = 'slime_session_token'").get() as { value?: string } | undefined;
        if (tokenRow?.value) {
          const token = JSON.parse(tokenRow.value) as string;
          const sess = this.db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id?: string } | undefined;
          if (sess?.user_id) {
            const u = this.db.prepare('SELECT username FROM users WHERE id = ?').get(sess.user_id) as { username?: string } | undefined;
            add(u?.username);
          }
        }
      } catch { /* ignore */ }
    }
    return out;
  }

  private findOfflineSkinByUuid(uuidDashless: string): SkinRow | null {
    if (!this.db.isReady()) return null;
    try {
      // 1. Custom skin stored directly under this uuid (Microsoft accounts).
      const direct = this.db.prepare('SELECT username, skin_data, cape_data, variant FROM offline_skins WHERE username = ?').get(uuidDashless) as
        | { username: string; skin_data: string | null; cape_data: string | null; variant: string | null }
        | undefined;
      if (direct) {
        return {
          username: direct.username,
          skin_data: direct.skin_data,
          cape_data: direct.cape_data,
          variant: direct.variant,
        };
      }
      // 2. Offline skins: match the offline uuid derived from the nick.
      // (Include cape-only rows too — a player may set a cape without a skin.)
      // Stored keys are lowercased but the game derives UUIDs from the EXACT
      // typed name, so known original-case nicks are tried as well — otherwise
      // any nick with a capital letter ("Sigmultra452") never resolves and the
      // player renders as Steve. The matched case is returned so profile names
      // keep their original spelling.
      const knownCases = this.knownNickCases();
      const rows = this.db.prepare('SELECT username, skin_data, cape_data, variant FROM offline_skins WHERE skin_data IS NOT NULL OR cape_data IS NOT NULL').all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const username = String(r.username);
        if (/^[0-9a-f]{32}$/i.test(username)) continue; // uuid-keyed MS rows: step 1
        const matched = resolveOfflineUuidMatch(uuidDashless, username, knownCases);
        if (matched) {
          return {
            username: matched,
            skin_data: r.skin_data ? String(r.skin_data) : null,
            cape_data: r.cape_data ? String(r.cape_data) : null,
            variant: r.variant ? String(r.variant) : null,
          };
        }
      }
      // 3. Friends on the LAN (same launcher + mod): their skins are relayed
      // through the presence broadcasts, so look them up there too.
      if (this.friendSkinResolver) {
        const friend = this.friendSkinResolver(uuidDashless);
        if (friend) {
          return {
            username: friend.username,
            skin_data: friend.skin,
            cape_data: null,
            variant: friend.variant,
          };
        }
      }
      // 4. Network peers: skins sent via the Network TCP channel.
      const netPeer = this.networkPeerSkins.get(uuidDashless);
      if (netPeer && (netPeer.skin || netPeer.cape)) {
        return {
          username: netPeer.username,
          skin_data: netPeer.skin,
          cape_data: netPeer.cape,
          variant: netPeer.skinVariant,
        };
      }
    } catch (e) {
      this.logger.error('Skin lookup failed', { error: String(e) });
    }
    return null;
  }

  // Ely.by fallback (TLauncher-style) — try to fetch skin/cape from
  // https://skinsystem.ely.by/skins/<nick>.png / cloaks/<nick>.png
  // This makes skins work "out of the box" on any server without needing
  // skinDirectoryUrl. Lookup is nick-based, so for uuid-based profile
  // requests we reverse-map the offline uuid to a nick from known sources.
  private async tryElyByForUuid(uuidDashless: string): Promise<SkinRow | null> {
    try {
      // Collect candidate nicks that could produce this uuid
      const candidates = new Set<string>();
      // Recent hasJoined nicks (most relevant for remote players on current server)
      for (const n of this.recentNicks) candidates.add(n);
      // 1. All saved offline accounts
      if (this.db.isReady()) {
        try {
          const rows = this.db.prepare("SELECT nick FROM saved_accounts WHERE kind='offline'").all() as Array<{ nick: string }>;
          for (const r of rows) if (r.nick) candidates.add(String(r.nick));
        } catch { /* ignore */ }
        try {
          const rows2 = this.db.prepare('SELECT username FROM offline_skins').all() as Array<{ username: string }>;
          for (const r of rows2) if (r.username && !/^[0-9a-f]{32}$/i.test(r.username)) candidates.add(String(r.username));
        } catch { /* ignore */ }
        // active offline user
        try {
          const tokenRow = this.db.prepare("SELECT value FROM settings WHERE key='slime_session_token'").get() as { value?: string } | undefined;
          if (tokenRow?.value) {
            const token = JSON.parse(tokenRow.value) as string;
            const sess = this.db.prepare('SELECT user_id FROM sessions WHERE token=?').get(token) as { user_id?: string } | undefined;
            if (sess?.user_id) {
              const u = this.db.prepare('SELECT username FROM users WHERE id=?').get(sess.user_id) as { username?: string } | undefined;
              if (u?.username) candidates.add(String(u.username));
            }
          }
        } catch { /* ignore */ }
      }
      // 2. Recent hasJoined nicks (already added above via this.recentNicks)

      let targetNick: string | null = null;
      for (const nick of candidates) {
        const d = offlineUuid(nick).replace(/-/g, '').toLowerCase();
        const d2 = offlineUuid(nick.toLowerCase()).replace(/-/g, '').toLowerCase();
        if (d === uuidDashless || d2 === uuidDashless) { targetNick = nick; break; }
      }
      // If we still don't know the nick, we can't query ely.by by uuid.
      // Try a direct hasJoined cache if available (resolveHasJoined populates via username param)
      // For now, skip if no candidate.
      if (!targetNick) return null;

      const ely = await fetchElyByTextures(targetNick, this.logger);
      if (!ely || (!ely.skin && !ely.cape)) return null;
      return {
        username: targetNick,
        skin_data: ely.skin,
        cape_data: ely.cape,
        variant: ely.variant,
      };
    } catch (e) {
      this.logger.debug('ely.by uuid lookup failed', { uuid: uuidDashless, error: String(e) });
      return null;
    }
  }

  private serveProfile(res: http.ServerResponse, row: SkinRow, uuid: string) {
    // Use the host's LAN IP for texture URLs so remote clients on the same
    // network can reach them; fall back to localhost for the local client.
    const texHost = this.hostIp !== '127.0.0.1' ? `http://${this.hostIp}:${this.port}` : this.getSessionHost();
    // Rows keyed by uuid (Microsoft custom skins) don't carry the gamertag —
    // resolve the real name from the linked account so the profile is correct.
    let profileName = row.username;
    if (/^[0-9a-f]{32}$/i.test(row.username)) {
      try {
        const acc = this.db.prepare('SELECT username FROM microsoft_accounts WHERE uuid = ?').get(row.username) as { username?: string } | undefined;
        if (acc?.username) profileName = acc.username;
      } catch {
        /* keep uuid as fallback */
      }
    }
    // The ?hd=1/?sd=1 marker makes the texture URL change when the user toggles
    // HD mode, so the game's texture cache can't serve a stale resolution.
    const hd = this.hdMode();
    const texSuffix = hd ? '?hd=1' : '?sd=1';
    const textures: Record<string, unknown> = {
      timestamp: Date.now(),
      profileId: uuid,
      profileName,
      textures: {} as Record<string, unknown>,
    };
    if (row.skin_data) {
      (textures.textures as Record<string, unknown>).SKIN = {
        url: `${texHost}/textures/${uuid}${texSuffix}`,
        metadata: row.variant === 'slim' ? { model: 'slim' } : undefined,
      };
    }
    if (row.cape_data) {
      (textures.textures as Record<string, unknown>).CAPE = { url: `${texHost}/textures/${uuid}/cape${texSuffix}` };
    }
    const value = Buffer.from(JSON.stringify(textures)).toString('base64');
    const body = JSON.stringify({
      id: uuid,
      name: row.username,
      properties: [{ name: 'textures', value }],
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    res.end(body);
  }

  // Everything that isn't a skin/profile response is proxied to Mojang. Since
  // the launcher now points the game at this server through ALL of the
  // minecraft.api.*.host properties (authlib needs the full set), requests for
  // every service land here — pick the right upstream host per path so e.g.
  // services/playerattributes still reaches api.minecraftservices.com.
  private upstreamFor(pathname: string): string {
    if (pathname.startsWith('/session/')) return 'sessionserver.mojang.com';
    if (pathname.startsWith('/authserver/')) return 'authserver.mojang.com';
    if (
      pathname.startsWith('/users/') ||
      pathname.startsWith('/user/') ||
      pathname.startsWith('/profiles/') ||
      pathname.startsWith('/minecraft/')
    ) {
      return 'api.mojang.com';
    }
    if (
      pathname.startsWith('/services/') ||
      pathname.startsWith('/publickeys') ||
      pathname.startsWith('/player/') ||
      pathname.startsWith('/privacy/') ||
      pathname.startsWith('/v1/')
    ) {
      return 'api.minecraftservices.com';
    }
    return 'sessionserver.mojang.com';
  }

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: string) {
    const upstreamHost = this.upstreamFor(pathname);
    const target = `https://${upstreamHost}${pathname}${search}`;
    const proxyReq = https.request(
      target,
      {
        method: req.method || 'GET',
        headers: { ...req.headers, host: upstreamHost },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode || 500, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      this.logger.debug('Session proxy failed', { error: String(err), pathname });
      if (!res.headersSent) {
        res.writeHead(204); // session-server "no such profile" semantics
        res.end();
      } else {
        res.destroy();
      }
    });
    req.pipe(proxyReq);
  }
}