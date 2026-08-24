import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { MicrosoftAccount } from '../../shared/types.js';
import { notify } from './types.js';
import { ensureSavedAccount, activateMsAccount, MAX_ACCOUNTS } from './accounts.js';

// Public OAuth client used for the device-code flow. The old well-known ID
// (00000000-0000-0000-0000-0000d130377c) was de-registered by Microsoft and
// now returns AADSTS700016, so we default to a public client from Prism
// Launcher (a widely-used open-source launcher) that is still registered as a
// public (native) app. The client_id only labels the app in Microsoft's
// consent page; all tokens flow directly to Microsoft/Xbox/Mojang services.
//
// You can set your own app id — either via the SLIME_MS_CLIENT_ID environment
// variable or the "Microsoft client ID" setting — to see YOUR app name on the
// consent page instead of Prism Launcher's. It must be an app registered in
// Azure AD as a public/native client with the "XboxLive.signin" and
// "offline_access" permissions.
const DEFAULT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

function postJson(url: string, body: string, contentType = 'application/x-www-form-urlencoded', headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': data.length,
          'User-Agent': 'SlimeLauncher/1.0.0',
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function rowToMs(r: Record<string, unknown>): MicrosoftAccount {
  return {
    id: String(r.id),
    username: String(r.username),
    uuid: String(r.uuid),
    accessToken: String(r.access_token),
    expiresAt: Number(r.expires_at),
    linkedAt: Number(r.linked_at),
    isActive: Number(r.is_active) === 1,
  };
}

// Device flows can be long-running; remember the polling schedule per code so a
// later `ms:complete` call can resume it without re-requesting from Microsoft.
const deviceStore = new Map<string, { interval: number; expiresIn: number }>();

export function getClientId(deps: HandlerDeps): string {
  const custom = deps.settingsStore.get().msClientId?.trim();
  return custom || process.env.SLIME_MS_CLIENT_ID || DEFAULT_CLIENT_ID;
}

// Exchanges a Microsoft OAuth access token for a Minecraft (Mojang) access
// token via the Xbox Live → XSTS → Minecraft chain. The MC token is what the
// Minecraft APIs (profile, skin upload, game auth) actually accept.
async function getMcToken(msAccessToken: string): Promise<string> {
  // XBL
  const xblResp = (await postJson(
    XBL_URL,
    JSON.stringify({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }),
    'application/json'
  )) as { Token: string; DisplayClaims: { xui: { uhs: string }[] } };
  const xblToken = xblResp.Token;
  const uhs = xblResp.DisplayClaims.xui[0].uhs;

  // XSTS
  const xstsResp = (await postJson(
    XSTS_URL,
    JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }),
    'application/json'
  )) as { Token: string };
  const xstsToken = xstsResp.Token;

  // Minecraft token
  const mcResp = (await postJson(
    MC_AUTH_URL,
    JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` }),
    'application/json'
  )) as { access_token?: string };
  if (!mcResp.access_token) {
    throw new Error('Minecraft token exchange failed: no access_token in response.');
  }
  return mcResp.access_token;
}

// Returns a valid Minecraft access token for a stored account row, silently
// refreshing it with the stored Microsoft refresh token when necessary (or when
// the stored token does not look like a Minecraft JWT — a corrupted row, e.g.
// one that was accidentally overwritten with a raw Microsoft token). Used by
// the profile handler and by the game launcher so that online play actually
// authenticates with a real token instead of "0".
export async function refreshMsTokenIfExpired(deps: HandlerDeps, row: Record<string, unknown>): Promise<string> {
  const { db, logger } = deps;
  let token = String(row.access_token || '');
  const expiresAt = Number(row.expires_at) || 0;
  const looksValid = /^eyJ/.test(token); // Minecraft access tokens are JWTs
  if ((expiresAt && Date.now() > expiresAt) || !looksValid) {
    if (!row.refresh_token) {
      logger.warn('Microsoft token invalid but no refresh token stored', { username: String(row.username || '') });
      return token;
    }
    try {
      const refreshed = (await postJson(
        TOKEN_URL,
        `client_id=${getClientId(deps)}&grant_type=refresh_token&refresh_token=${encodeURIComponent(String(row.refresh_token))}`
      )) as { access_token?: string; refresh_token?: string; error?: string };
      if (refreshed.access_token) {
        // The OAuth refresh gives a *Microsoft* access token; the Minecraft
        // APIs need a Minecraft token, so exchange it before storing.
        token = await getMcToken(refreshed.access_token);
        const newExpires = Date.now() + 3600 * 1000;
        db.prepare('UPDATE microsoft_accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?')
          .run(token, refreshed.refresh_token || row.refresh_token, newExpires, row.id);
        logger.info('Microsoft token refreshed', { username: String(row.username || '') });
      } else if (refreshed.error) {
        logger.warn('Microsoft token refresh rejected', { error: refreshed.error });
      }
    } catch (e) {
      logger.error('Microsoft token refresh failed', { error: String(e) });
    }
  }
  return token;
}

async function completeMsLogin(deps: HandlerDeps, msAccessToken: string, msRefreshToken: string | null) {
  const { db, logger } = deps;

  const savedCount = Number((db.prepare('SELECT COUNT(*) AS c FROM saved_accounts').get() as { c: number }).c);
  if (savedCount >= MAX_ACCOUNTS) {
    throw new Error(`Maximum ${MAX_ACCOUNTS} accounts. Remove one first.`);
  }

  const mcToken = await getMcToken(msAccessToken);
  // Profile — this is where login usually fails. fetchProfile rejects when the
  // account has no Minecraft Java Edition profile ("NOT_FOUND"), but guard here
  // too so a malformed/empty response can never produce a broken DB row
  // ("NOT NULL constraint failed: microsoft_accounts.username").
  const profile = (await fetchProfile(mcToken)) as { id?: string; name?: string };
  if (!profile.id || !profile.name) {
    throw new Error('This Microsoft account does not own Minecraft Java Edition, so it has no game profile to link. Make sure you purchased Minecraft Java Edition on this account.');
  }

  const id = randomUUID();
  const expiresAt = Date.now() + 3600 * 1000;
  db.prepare('UPDATE microsoft_accounts SET is_active = 0').run();
  db.prepare(
    'INSERT INTO microsoft_accounts (id, username, uuid, access_token, refresh_token, expires_at, linked_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  ).run(id, profile.name, profile.id, mcToken, msRefreshToken, expiresAt, Date.now());
  ensureSavedAccount(deps, { kind: 'microsoft', nick: profile.name, msId: id });

  logger.info('Microsoft account linked', { username: profile.name });
  notify(deps, { type: 'success', title: 'Microsoft account linked', message: `Logged in as ${profile.name}` });
  return rowToMs(db.prepare('SELECT * FROM microsoft_accounts WHERE id = ?').get(id) as Record<string, unknown>);
}

export function registerMsHandlers(deps: HandlerDeps) {
  const { db, logger } = deps;

  // Returns the device code so the renderer can show it prominently while the
  // user authorizes in their browser. The login itself is completed later via
  // MS_COMPLETE once the user has finished.
  ipcMain.handle(IPC.MS_DEVICE_CODE, async () => {
    try {
      const deviceResp = (await postJson(
        DEVICE_CODE_URL,
        `client_id=${getClientId(deps)}&scope=XboxLive.signin+offline_access`
      )) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; interval: number; expires_in: number };
      if (!deviceResp.device_code) {
        return { ok: false, error: 'Failed to get device code from Microsoft.' };
      }
      deviceStore.set(deviceResp.device_code, { interval: deviceResp.interval || 5, expiresIn: deviceResp.expires_in || 900 });
      return {
        ok: true,
        device: {
          user_code: deviceResp.user_code,
          verification_uri: deviceResp.verification_uri,
          verification_uri_complete: deviceResp.verification_uri_complete || `${deviceResp.verification_uri}?user_code=${deviceResp.user_code}`,
          device_code: deviceResp.device_code,
          expires_in: deviceResp.expires_in,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Microsoft device code failed', { error: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.MS_COMPLETE, async (_e, deviceCode: string) => {
    try {
      const info = deviceStore.get(deviceCode);
      const token = await pollForToken(deviceCode, info?.interval || 5, info?.expiresIn || 900, getClientId(deps));
      const msAccessToken = (token as { access_token: string }).access_token;
      const msRefreshToken = (token as { refresh_token?: string }).refresh_token || null;
      const account = await completeMsLogin(deps, msAccessToken, msRefreshToken);
      deviceStore.delete(deviceCode);
      return { ok: true, account };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Microsoft login failed', { error: msg });
      return { ok: false, error: msg };
    }
  });

  // Legacy single-call login (still used as fallback): starts the device flow,
  // shows the code as a notification and polls until the user finishes.
  ipcMain.handle(IPC.MS_LOGIN, async () => {
    try {
      const deviceResp = (await postJson(
        DEVICE_CODE_URL,
        `client_id=${getClientId(deps)}&scope=XboxLive.signin+offline_access`
      )) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
      if (!deviceResp.device_code) {
        return { ok: false, error: 'Failed to get device code from Microsoft.' };
      }
      notify(deps, {
        type: 'info',
        title: 'Authenticate with Microsoft',
        message: `Open ${deviceResp.verification_uri} and enter code: ${deviceResp.user_code}`,
        duration: Math.min(deviceResp.expires_in, 900) * 1000,
      });
      const token = await pollForToken(deviceResp.device_code, deviceResp.interval, deviceResp.expires_in, getClientId(deps));
      const account = await completeMsLogin(deps, (token as { access_token: string }).access_token, (token as { refresh_token?: string }).refresh_token || null);
      return { ok: true, account };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Microsoft login failed', { error: msg });
      notify(deps, { type: 'error', title: 'Microsoft login failed', message: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.MS_LOGOUT, (_e, id: string) => {
    db.prepare('DELETE FROM microsoft_accounts WHERE id = ?').run(id);
    db.prepare('DELETE FROM saved_accounts WHERE ms_id = ?').run(id);
    return { ok: true };
  });

  ipcMain.handle(IPC.MS_LIST, () => {
    const rows = db.prepare('SELECT * FROM microsoft_accounts ORDER BY is_active DESC, linked_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToMs);
  });

  ipcMain.handle(IPC.MS_SET_ACTIVE, (_e, id: string) => {
    activateMsAccount(db, id);
    return { ok: true };
  });

  ipcMain.handle(IPC.MS_PROFILE, async () => {
    const row = db.prepare('SELECT * FROM microsoft_accounts WHERE is_active = 1').get() as Record<string, unknown> | undefined;
    if (!row) {
      return { ok: false, error: 'No Microsoft account linked.' };
    }
    // Access tokens only live ~1 hour. Silently refresh with the stored
    // refresh token so linked accounts keep working across sessions.
    let token = await refreshMsTokenIfExpired(deps, row);
    if (!token) {
      return { ok: false, error: 'Microsoft session expired. Re-link your account.' };
    }
    try {
      const profile = (await fetchProfile(token)) as {
        id: string;
        name: string;
        skins?: Array<{ id: string; state: string; url: string; variant: string }>;
        capes?: Array<{ id: string; state: string; url: string }>;
      };
      const activeSkin = profile.skins?.find((s) => s.state === 'ACTIVE');
      const activeCape = profile.capes?.find((c) => c.state === 'ACTIVE');
      return {
        ok: true,
        profile: {
          uuid: profile.id,
          username: profile.name,
          skinUrl: activeSkin?.url || null,
          skinVariant: activeSkin?.variant || null,
          capeUrl: activeCape?.url || null,
          skins: profile.skins || [],
          capes: profile.capes || [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to fetch Microsoft profile', { error: msg });
      return { ok: false, error: msg };
    }
  });
}

function pollForToken(deviceCode: string, interval: number, expires: number, clientId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      if (Date.now() - start > expires * 1000) {
        reject(new Error('Device code expired. Please try again.'));
        return;
      }
      try {
        const resp = (await postJson(
          TOKEN_URL,
          `client_id=${clientId}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode}`
        )) as { access_token?: string; error?: string; error_description?: string };
        if (resp.access_token) { resolve(resp); return; }
        if (resp.error && resp.error !== 'authorization_pending') {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        setTimeout(tick, (interval || 5) * 1000);
      } catch (e) {
        reject(e);
      }
    };
    tick();
  });
}

function fetchProfile(token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(MC_PROFILE_URL, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        // A non-2xx status means the token is rejected (401/403) or the API
        // is unhappy. The error body has no reliable shape (a 401 may be
        // `{"path": ...}` with no `error` field), so never treat it as a
        // valid profile — otherwise the UI would silently show "no skin".
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`Minecraft profile request failed (HTTP ${res.statusCode}).`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            // NOT_FOUND means the account has no Java Edition profile.
            if (parsed.error === 'NOT_FOUND') {
              reject(new Error('This Microsoft account does not own Minecraft Java Edition.'));
            } else {
              reject(new Error(parsed.error_message || parsed.error));
            }
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
