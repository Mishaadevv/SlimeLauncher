import { ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { SavedAccount } from '../../shared/types.js';

const req = createRequire(import.meta.url);
const bcrypt = req('bcryptjs');

export const MAX_ACCOUNTS = 8;
const SESSION_KEY = 'slime_session_token';
const SALT_ROUNDS = 10;

function rowToSaved(r: Record<string, unknown>): SavedAccount {
  return {
    id: String(r.id),
    kind: String(r.kind) === 'microsoft' ? 'microsoft' : 'offline',
    nick: String(r.nick),
    isActive: Number(r.is_active) === 1,
    createdAt: Number(r.created_at),
  };
}

// The "active" flag is derived from the legacy state that the rest of the app
// already trusts: the current offline session token and the Microsoft
// is_active flag. saved_accounts itself stores no active column, so this can
// never drift out of sync.
function isSavedActive(db: HandlerDeps['db'], r: Record<string, unknown>): boolean {
  if (String(r.kind) === 'microsoft' && r.ms_id) {
    const m = db.prepare('SELECT is_active FROM microsoft_accounts WHERE id = ?').get(r.ms_id) as { is_active: number } | undefined;
    return !!m && Number(m.is_active) === 1;
  }
  if (r.user_id) {
    const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
    if (!tokenRow) return false;
    try {
      const token = JSON.parse(tokenRow.value) as string;
      const s = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
      return !!s && String(s.user_id) === String(r.user_id);
    } catch { return false; }
  }
  return false;
}

function clearOfflineSession(db: HandlerDeps['db']) {
  const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
  if (tokenRow) {
    try {
      const token = JSON.parse(tokenRow.value) as string;
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    } catch { /* ignore */ }
    db.prepare('DELETE FROM settings WHERE key = ?').run(SESSION_KEY);
  }
}

// Makes an offline user the single active identity: deactivates any Microsoft
// account, replaces the session token and writes it where legacy consumers
// (presence, network, launch, skins) read it.
export function activateOfflineUser(db: HandlerDeps['db'], userId: string) {
  db.prepare('UPDATE microsoft_accounts SET is_active = 0').run();
  clearOfflineSession(db);
  const token = randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SESSION_KEY, JSON.stringify(token));
}

export function activateMsAccount(db: HandlerDeps['db'], msId: string) {
  clearOfflineSession(db);
  db.prepare('UPDATE microsoft_accounts SET is_active = 0').run();
  db.prepare('UPDATE microsoft_accounts SET is_active = 1 WHERE id = ?').run(msId);
}

// Registers the saved-account row if missing (used by register/login and the
// Microsoft link flow so every account creation lands in the same list).
// Guards against duplicates by user_id/ms_id (not just random PK) so repeated
// login/register calls for the same user never create a visual duplicate in
// the Accounts list.
export function ensureSavedAccount(
  deps: HandlerDeps,
  input: { kind: 'offline' | 'microsoft'; nick: string; userId?: string; msId?: string }
) {
  const { db } = deps;
  if (input.kind === 'offline' && input.userId) {
    const exists = db.prepare('SELECT id FROM saved_accounts WHERE user_id = ?').get(input.userId);
    if (exists) return;
    // Also guard against stale backfill duplicates by nick+user coupling
    db.prepare('INSERT OR IGNORE INTO saved_accounts (id, kind, nick, user_id, ms_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(randomUUID(), 'offline', input.nick, input.userId, Date.now());
  } else if (input.kind === 'microsoft' && input.msId) {
    const exists = db.prepare('SELECT id FROM saved_accounts WHERE ms_id = ?').get(input.msId);
    if (exists) return;
    db.prepare('INSERT OR IGNORE INTO saved_accounts (id, kind, nick, user_id, ms_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(randomUUID(), 'microsoft', input.nick, input.msId, Date.now());
  }
}

function savedCount(db: HandlerDeps['db']): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM saved_accounts').get() as { c: number }).c);
}

export function registerAccountsHandlers(deps: HandlerDeps) {
  const { db, logger } = deps;

  ipcMain.handle(IPC.ACCOUNTS_LIST, () => {
    const rows = db.prepare('SELECT * FROM saved_accounts ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...rowToSaved(r), isActive: isSavedActive(db, r) }));
  });

  ipcMain.handle(IPC.ACCOUNTS_ADD_OFFLINE, (_e, nick: string) => {
    if (typeof nick !== 'string') return { ok: false, error: 'Nickname must be 1-24 chars (letters, numbers, _ or -).' };
    const cleanNick = nick.trim();
    if (cleanNick.length < 1 || cleanNick.length > 24 || !/^[a-zA-Z0-9_-]+$/.test(cleanNick)) {
      return { ok: false, error: 'Nickname must be 1-24 chars (letters, numbers, _ or -).' };
    }
    // Preserve exact case the user typed — cracked servers (AuthMe/nLogin)
    // are case-sensitive for offline UUIDs and kick with
    // "Неверный регистр ника! Используйте: <Case>".
    if (savedCount(db) >= MAX_ACCOUNTS) {
      return { ok: false, error: `Maximum ${MAX_ACCOUNTS} accounts. Remove one first.` };
    }
    const clash = db.prepare('SELECT id FROM saved_accounts WHERE lower(nick) = lower(?)').get(cleanNick);
    if (clash) return { ok: false, error: 'An account with this nickname already exists.' };

    const userId = randomUUID();
    const hash = bcrypt.hashSync(`${randomUUID()}${Date.now()}`, SALT_ROUNDS);
    db.prepare('INSERT INTO users (id, username, email, password_hash, avatar, created_at, launch_count) VALUES (?, ?, ?, ?, NULL, ?, 0)')
      .run(userId, cleanNick, `${userId}@offline.slime`, hash, Date.now());
    const savedId = randomUUID();
    db.prepare('INSERT INTO saved_accounts (id, kind, nick, user_id, ms_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(savedId, 'offline', cleanNick, userId, Date.now());
    activateOfflineUser(db, userId);

    logger.info('Offline account added', { nick: cleanNick });
    return {
      ok: true,
      account: {
        id: savedId,
        kind: 'offline',
        nick: cleanNick,
        isActive: true,
        createdAt: Date.now(),
      } as SavedAccount,
    };
  });

  ipcMain.handle(IPC.ACCOUNTS_SET_ACTIVE, async (_e, id: string) => {
    const row = db.prepare('SELECT * FROM saved_accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: 'Account not found.' };
    if (String(row.kind) === 'microsoft' && row.ms_id) {
      activateMsAccount(db, String(row.ms_id));
      // Proactively refresh the Microsoft token so the next launch doesn't use an expired JWT.
      // Without this, switching via Accounts kept the old token (1h lifetime) and premium
      // servers rejected it with "Invalid session", while Sign In always fetched a fresh one.
      // Never block the switch itself -- a failed refresh will be retried at launch
      // and surfaced there with a clear "session expired" message.
      try {
        const msRow = db.prepare('SELECT * FROM microsoft_accounts WHERE id = ?').get(String(row.ms_id)) as Record<string, unknown> | undefined;
        if (msRow) {
          const { refreshMsTokenIfExpired } = await import('./microsoft.js');
          const fresh = await refreshMsTokenIfExpired({ db, settingsStore: deps.settingsStore, logger } as unknown as import('./types.js').HandlerDeps, msRow);
          if (!fresh || !/^eyJ/.test(fresh)) {
            logger.warn('MS token still invalid after refresh - user will need to re-login at launch', { id: String(row.ms_id) });
          } else {
            logger.info('MS token refreshed on account switch', { id: String(row.ms_id) });
          }
        }
      } catch (e) {
        logger.warn('MS token refresh on switch failed', { error: String(e) });
      }
    } else if (row.user_id) {
      activateOfflineUser(db, String(row.user_id));
    } else {
      return { ok: false, error: 'This account has no linked identity.' };
    }
    // Push the switched identity to an active Network session (dynamic import
    // avoids a module cycle); no-op when not in a network.
    try {
      const { updateNetworkIdentity } = await import('./network.js');
      await updateNetworkIdentity(db);
    } catch { /* best effort */ }
    logger.info('Account switched', { id, kind: String(row.kind) });
    return { ok: true };
  });

  ipcMain.handle(IPC.ACCOUNTS_REMOVE, (_e, id: string) => {
    const row = db.prepare('SELECT * FROM saved_accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: 'Account not found.' };
    const wasActive = isSavedActive(db, row);

    if (String(row.kind) === 'microsoft' && row.ms_id) {
      db.prepare('DELETE FROM microsoft_accounts WHERE id = ?').run(row.ms_id);
    } else if (row.user_id) {
      clearOfflineSession(db);
      db.prepare('DELETE FROM users WHERE id = ?').run(row.user_id); // cascades sessions
    }
    db.prepare('DELETE FROM saved_accounts WHERE id = ?').run(id);

    // If the removed account was active, fall back to the oldest remaining one.
    if (wasActive) {
      const next = db.prepare('SELECT * FROM saved_accounts ORDER BY created_at ASC LIMIT 1').get() as Record<string, unknown> | undefined;
      if (next) {
        if (String(next.kind) === 'microsoft' && next.ms_id) activateMsAccount(db, String(next.ms_id));
        else if (next.user_id) activateOfflineUser(db, String(next.user_id));
      }
    }
    logger.info('Account removed', { id, kind: String(row.kind) });
    return { ok: true };
  });
}