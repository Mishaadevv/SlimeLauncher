import { ipcMain } from 'electron';
import fs from 'node:fs';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { DatabaseService } from '../services/database.js';
import { pngDimensions } from '../services/png-utils.js';
import { updateNetworkIdentity } from './network.js';

function publishToDirectory(deps: HandlerDeps, nick: string) {
  try {
    const row = deps.db.prepare('SELECT skin_data, cape_data, variant FROM offline_skins WHERE username = ?').get(nick) as
      | { skin_data: string | null; cape_data: string | null; variant: string }
      | undefined;
    if (row?.skin_data) {
      void deps.skinDirectory.publish(nick, row.skin_data, row.variant, row.cape_data ?? null);
    }
  } catch { /* best effort */ }
}

// The active Microsoft account (the one the game launches with). Custom skins
// for Microsoft accounts are stored in the same offline_skins table but keyed
// by the account's dashless uuid so the local skin server can serve them.
function getActiveMsAccount(db: DatabaseService): { id: string; username: string; uuid: string } | null {
  const row = db.prepare('SELECT * FROM microsoft_accounts WHERE is_active = 1').get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return { id: String(row.id), username: String(row.username), uuid: String(row.uuid) };
}

// Resolve the currently signed-in SlimeLauncher user from the session token.
function getSessionUser(db: DatabaseService): { id: string; username: string } | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'slime_session_token'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const token = JSON.parse(row.value) as string;
    const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
    if (!session) return null;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(session.user_id) as { id: string; username: string } | undefined;
    return user || null;
  } catch {
    return null;
  }
}

// PNG signature + sanity size check. HD skins/capes are accepted (up to
// 1024 px on the long edge); anything larger or not a PNG is rejected.
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PNG_DIM = 1024;

function validatePng(buf: Buffer): string | null {
  if (buf.length < 8) return 'File is too small to be a PNG.';
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) return 'Only PNG skins are supported.';
  if (buf.length > MAX_PNG_BYTES) return `File is too large (max ${MAX_PNG_BYTES / 1024 / 1024} MB).`;
  return null;
}

// Skins: square (64x64 ... 1024x1024) or legacy 2:1 (64x32 ... 1024x512).
function validateSkinPng(buf: Buffer): string | null {
  const base = validatePng(buf);
  if (base) return base;
  const dims = pngDimensions(buf);
  if (!dims) return 'Could not read PNG dimensions.';
  if (dims.width < 64 || dims.width > MAX_PNG_DIM) {
    return `Skin width must be between 64 and ${MAX_PNG_DIM} px.`;
  }
  if (dims.height !== dims.width && dims.height !== dims.width / 2) {
    return 'Skin must be square (e.g. 64×64, 128×128) or legacy 2:1 (e.g. 64×32). HD skins up to 1024×1024 are supported.';
  }
  return null;
}

// Capes: always 2:1 (64x32 ... 1024x512).
function validateCapePng(buf: Buffer): string | null {
  const base = validatePng(buf);
  if (base) return base;
  const dims = pngDimensions(buf);
  if (!dims) return 'Could not read PNG dimensions.';
  if (dims.width < 64 || dims.width > MAX_PNG_DIM) {
    return `Cape width must be between 64 and ${MAX_PNG_DIM} px.`;
  }
  if (dims.height !== dims.width / 2) {
    return 'Cape must be 2:1 (e.g. 64×32, 128×64, 256×128). HD capes up to 1024×512 are supported.';
  }
  return null;
}

// Reads a PNG file as base64, validating signature, size and dimensions.
function readPngBase64(filePath: string, kind: 'skin' | 'cape'): { ok: true; base64: string } | { ok: false; error: string } {
  try {
    const buf = fs.readFileSync(filePath);
    const err = kind === 'skin' ? validateSkinPng(buf) : validateCapePng(buf);
    if (err) return { ok: false, error: err };
    return { ok: true, base64: buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: `Could not read file: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Texture dimensions (for the UI badge) from a stored base64 PNG, if any.
function pngSizeOf(base64: string | null): { width: number | null; height: number | null } {
  if (!base64) return { width: null, height: null };
  try {
    const dims = pngDimensions(Buffer.from(base64, 'base64'));
    return dims ? { width: dims.width, height: dims.height } : { width: null, height: null };
  } catch {
    return { width: null, height: null };
  }
}

export function registerSkinHandlers(deps: HandlerDeps) {
  const { db, logger } = deps;

  ipcMain.handle(IPC.SKIN_PORT, () => deps.skinServer.getPort());

  ipcMain.handle(IPC.SKIN_GET, () => {
    const user = getSessionUser(db);
    if (!user) return { ok: false, error: 'Not signed in.' };
    const row = db.prepare('SELECT skin_data, cape_data, variant, updated_at FROM offline_skins WHERE lower(username) = lower(?)').get(user.username) as
      | { skin_data: string | null; cape_data: string | null; variant: string; updated_at: number }
      | undefined;
    const skinSize = pngSizeOf(row?.skin_data ?? null);
    const capeSize = pngSizeOf(row?.cape_data ?? null);
    return {
      ok: true,
      skin: row
        ? {
            username: user.username,
            variant: row.variant,
            hasSkin: !!row.skin_data,
            hasCape: !!row.cape_data,
            skinData: row.skin_data || null,
            capeData: row.cape_data || null,
            skinWidth: skinSize.width,
            skinHeight: skinSize.height,
            capeWidth: capeSize.width,
            capeHeight: capeSize.height,
            updatedAt: row.updated_at,
          }
        : { username: user.username, variant: 'classic', hasSkin: false, hasCape: false, skinData: null, capeData: null, skinWidth: null, skinHeight: null, capeWidth: null, capeHeight: null, updatedAt: 0 },
    };
  });

  ipcMain.handle(IPC.SKIN_SET, (_e, data: { path?: string; base64?: string; variant?: 'classic' | 'slim' }) => {
    const user = getSessionUser(db);
    if (!user) return { ok: false, error: 'Not signed in.' };
    let base64 = data.base64 || '';
    if (data.path) {
      const read = readPngBase64(data.path, 'skin');
      if (!read.ok) return read;
      base64 = read.base64;
    }
    if (!base64) return { ok: false, error: 'No skin data provided.' };
    const variant = data.variant === 'slim' ? 'slim' : 'classic';
    const err = validateSkinPng(Buffer.from(base64, 'base64'));
    if (err) return { ok: false, error: err };
    const canonical = user.username.toLowerCase();
    // Migrate legacy uppercase keys: update case-insensitive match, else insert
    const updated = db.prepare('UPDATE offline_skins SET username = ?, skin_data = ?, variant = ?, updated_at = ? WHERE lower(username) = lower(?)').run(canonical, base64, variant, Date.now(), canonical);
    if (updated.changes === 0) {
      db.prepare(
        'INSERT INTO offline_skins (username, skin_data, variant, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET skin_data = excluded.skin_data, variant = excluded.variant, updated_at = excluded.updated_at'
      ).run(canonical, base64, variant, Date.now());
    }
    void updateNetworkIdentity(db);
    publishToDirectory(deps, canonical);
    logger.info('Offline skin saved', { username: canonical, variant });
    return { ok: true };
  });

  ipcMain.handle(IPC.SKIN_SET_CAPE, (_e, data: { path?: string; base64?: string }) => {
    const user = getSessionUser(db);
    if (!user) return { ok: false, error: 'Not signed in.' };
    let base64 = data.base64 || '';
    if (data.path) {
      const read = readPngBase64(data.path, 'cape');
      if (!read.ok) return read;
      base64 = read.base64;
    }
    if (!base64) return { ok: false, error: 'No cape data provided.' };
    const err = validateCapePng(Buffer.from(base64, 'base64'));
    if (err) return { ok: false, error: err };
    const canonical = user.username.toLowerCase();
    const updated = db.prepare('UPDATE offline_skins SET username = ?, cape_data = ?, updated_at = ? WHERE lower(username) = lower(?)').run(canonical, base64, Date.now(), canonical);
    if (updated.changes === 0) {
      db.prepare(
        'INSERT INTO offline_skins (username, cape_data, variant, updated_at) VALUES (?, ?, \'classic\', ?) ON CONFLICT(username) DO UPDATE SET cape_data = excluded.cape_data, updated_at = excluded.updated_at'
      ).run(canonical, base64, Date.now());
    }
    void updateNetworkIdentity(db);
    publishToDirectory(deps, canonical);
    logger.info('Offline cape saved', { username: canonical });
    return { ok: true };
  });

  ipcMain.handle(IPC.SKIN_REMOVE_CAPE, () => {
    const user = getSessionUser(db);
    if (!user) return { ok: false, error: 'Not signed in.' };
    db.prepare('UPDATE offline_skins SET cape_data = NULL, updated_at = ? WHERE lower(username) = lower(?)').run(Date.now(), user.username);
    void updateNetworkIdentity(db);
    logger.info('Offline cape removed', { username: user.username });
    return { ok: true };
  });

  ipcMain.handle(IPC.SKIN_REMOVE, () => {
    const user = getSessionUser(db);
    if (!user) return { ok: false, error: 'Not signed in.' };
    db.prepare('UPDATE offline_skins SET skin_data = NULL, updated_at = ? WHERE lower(username) = lower(?)').run(Date.now(), user.username);
    void updateNetworkIdentity(db);
    logger.info('Offline skin removed', { username: user.username });
    return { ok: true };
  });

  // ---- Custom skin/cape for the active Microsoft account ----
  ipcMain.handle(IPC.MS_SKIN_GET, () => {
    const acc = getActiveMsAccount(db);
    if (!acc) return { ok: false, error: 'No Microsoft account linked.' };
    const row = db.prepare('SELECT skin_data, cape_data, variant, updated_at FROM offline_skins WHERE username = ?').get(acc.uuid) as
      | { skin_data: string | null; cape_data: string | null; variant: string; updated_at: number }
      | undefined;
    const skinSize = pngSizeOf(row?.skin_data ?? null);
    const capeSize = pngSizeOf(row?.cape_data ?? null);
    return {
      ok: true,
      account: { username: acc.username, uuid: acc.uuid },
      custom: row
        ? {
            hasSkin: !!row.skin_data,
            hasCape: !!row.cape_data,
            skinData: row.skin_data || null,
            capeData: row.cape_data || null,
            variant: row.variant || 'classic',
            skinWidth: skinSize.width,
            skinHeight: skinSize.height,
            capeWidth: capeSize.width,
            capeHeight: capeSize.height,
            updatedAt: row.updated_at,
          }
        : { hasSkin: false, hasCape: false, skinData: null, capeData: null, variant: 'classic', skinWidth: null, skinHeight: null, capeWidth: null, capeHeight: null, updatedAt: 0 },
    };
  });

  ipcMain.handle(IPC.MS_SKIN_SET, (_e, data: { path?: string; base64?: string; variant?: 'classic' | 'slim' }) => {
    const acc = getActiveMsAccount(db);
    if (!acc) return { ok: false, error: 'No Microsoft account linked.' };
    let base64 = data.base64 || '';
    if (data.path) {
      const read = readPngBase64(data.path, 'skin');
      if (!read.ok) return read;
      base64 = read.base64;
    }
    if (!base64) return { ok: false, error: 'No skin data provided.' };
    const err = validateSkinPng(Buffer.from(base64, 'base64'));
    if (err) return { ok: false, error: err };
    const variant = data.variant === 'slim' ? 'slim' : 'classic';
    db.prepare(
      "INSERT INTO offline_skins (username, skin_data, variant, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET skin_data = excluded.skin_data, variant = excluded.variant, updated_at = excluded.updated_at"
    ).run(acc.uuid, base64, variant, Date.now());
    void updateNetworkIdentity(db);
    publishToDirectory(deps, acc.username);
    logger.info('Microsoft custom skin saved', { username: acc.username });
    return { ok: true };
  });

  ipcMain.handle(IPC.MS_SKIN_SET_CAPE, (_e, data: { path?: string; base64?: string }) => {
    const acc = getActiveMsAccount(db);
    if (!acc) return { ok: false, error: 'No Microsoft account linked.' };
    let base64 = data.base64 || '';
    if (data.path) {
      const read = readPngBase64(data.path, 'cape');
      if (!read.ok) return read;
      base64 = read.base64;
    }
    if (!base64) return { ok: false, error: 'No cape data provided.' };
    const err = validateCapePng(Buffer.from(base64, 'base64'));
    if (err) return { ok: false, error: err };
    db.prepare(
      "INSERT INTO offline_skins (username, cape_data, variant, updated_at) VALUES (?, ?, 'classic', ?) ON CONFLICT(username) DO UPDATE SET cape_data = excluded.cape_data, updated_at = excluded.updated_at"
    ).run(acc.uuid, base64, Date.now());
    void updateNetworkIdentity(db);
    publishToDirectory(deps, acc.username);
    logger.info('Microsoft custom cape saved', { username: acc.username });
    return { ok: true };
  });

  ipcMain.handle(IPC.MS_SKIN_REMOVE, () => {
    const acc = getActiveMsAccount(db);
    if (!acc) return { ok: false, error: 'No Microsoft account linked.' };
    db.prepare('UPDATE offline_skins SET skin_data = NULL, updated_at = ? WHERE username = ?').run(Date.now(), acc.uuid);
    void updateNetworkIdentity(db);
    logger.info('Microsoft custom skin removed', { username: acc.username });
    return { ok: true };
  });

  ipcMain.handle(IPC.MS_SKIN_REMOVE_CAPE, () => {
    const acc = getActiveMsAccount(db);
    if (!acc) return { ok: false, error: 'No Microsoft account linked.' };
    db.prepare('UPDATE offline_skins SET cape_data = NULL, updated_at = ? WHERE username = ?').run(Date.now(), acc.uuid);
    void updateNetworkIdentity(db);
    logger.info('Microsoft custom cape removed', { username: acc.username });
    return { ok: true };
  });
}