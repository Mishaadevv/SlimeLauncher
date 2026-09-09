import { ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { UserAccount } from '../../shared/types.js';
import { ensureSavedAccount, activateOfflineUser, MAX_ACCOUNTS } from './accounts.js';
import { updateNetworkIdentity } from './network.js';

const req = createRequire(import.meta.url);
const bcrypt = req('bcryptjs');

const SALT_ROUNDS = 10;
const SESSION_KEY = 'slime_session_token';

function rowToUser(r: Record<string, unknown>): UserAccount {
  return {
    id: String(r.id),
    username: String(r.username),
    email: String(r.email),
    avatar: r.avatar ? String(r.avatar) : null,
    createdAt: Number(r.created_at),
    launchCount: Number(r.launch_count) || 0,
  };
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(name: string): boolean {
  return typeof name === 'string' && name.length >= 1 && name.length <= 24 && /^[a-zA-Z0-9_-]+$/.test(name);
}

export function registerAuthHandlers(deps: HandlerDeps) {
  const { db, logger } = deps;

  ipcMain.handle(IPC.AUTH_REGISTER, async (_e, username: string, email: string, password: string) => {
    if (typeof username === 'string') username = username.trim();
    if (!validateUsername(username)) {
      return { ok: false, error: 'Username must be 1-24 chars (letters, numbers, _ or -).' };
    }
    if (!validateEmail(email)) {
      return { ok: false, error: 'Invalid email address.' };
    }
    if (typeof password !== 'string' || password.length < 4) {
      return { ok: false, error: 'Password must be at least 4 characters.' };
    }

    // Check if user already exists with this email
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) {
      // User exists — try to log in instead
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined;
      if (row) {
        const valid = bcrypt.compareSync(password, String(row.password_hash));
        if (valid) {
          activateOfflineUser(db, String(row.id));
          ensureSavedAccount(deps, { kind: 'offline', nick: String(row.username), userId: String(row.id) });
          const user = rowToUser(row);
          logger.info('User logged in (existing)', { id: user.id });
          return { ok: true, user };
        }
      }
      return { ok: false, error: 'Account already exists with this email.' };
    }

    if (Number((db.prepare('SELECT COUNT(*) AS c FROM saved_accounts').get() as { c: number }).c) >= MAX_ACCOUNTS) {
      return { ok: false, error: `Maximum ${MAX_ACCOUNTS} accounts. Remove one first.` };
    }

    const id = randomUUID();
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, avatar, created_at, launch_count) VALUES (?, ?, ?, ?, NULL, ?, 0)'
    ).run(id, username, email, hash, Date.now());

    // auto-login + save in the multi-account list
    activateOfflineUser(db, id);
    ensureSavedAccount(deps, { kind: 'offline', nick: username, userId: id });
    void updateNetworkIdentity(db);

    const user = rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>);
    logger.info('User registered', { id, username });
    return { ok: true, user };
  });

  ipcMain.handle(IPC.AUTH_LOGIN, async (_e, email: string, password: string) => {
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: 'No account found with that email.' };

    const valid = bcrypt.compareSync(password, String(row.password_hash));
    if (!valid) return { ok: false, error: 'Incorrect password.' };

    activateOfflineUser(db, String(row.id));
    ensureSavedAccount(deps, { kind: 'offline', nick: String(row.username), userId: String(row.id) });
    void updateNetworkIdentity(db);

    const user = rowToUser(row);
    logger.info('User logged in', { id: user.id });
    return { ok: true, user };
  });

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
    if (tokenRow) {
      try {
        const token = JSON.parse(tokenRow.value) as string;
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      } catch { /* ignore */ }
      db.prepare('DELETE FROM settings WHERE key = ?').run(SESSION_KEY);
    }
    void updateNetworkIdentity(db);
    return { ok: true };
  });

  ipcMain.handle(IPC.AUTH_CURRENT, async () => {
    const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
    if (!tokenRow) return null;
    let token: string;
    try { token = JSON.parse(tokenRow.value) as string; } catch { return null; }
    const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
    if (!session) return null;
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as Record<string, unknown> | undefined;
    return row ? rowToUser(row) : null;
  });

  ipcMain.handle(IPC.AUTH_UPDATE_PROFILE, async (_e, patch: { username?: string; avatar?: string | null }) => {
    const current = await getCurrentUser(db);
    if (!current) return { ok: false, error: 'Not authenticated.' };
    if (patch.username !== undefined) {
      if (!validateUsername(patch.username)) return { ok: false, error: 'Invalid username.' };
      const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(patch.username, current.id);
      if (clash) return { ok: false, error: 'Username already taken.' };
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(patch.username, current.id);
      // Propagate the rename: the Accounts list (saved_accounts.nick) and the
      // offline skin key (offline_skins.username) are nick-based, so without
      // this the list keeps showing the stale name and the skin "disappears".
      // Guarded so a skin-key collision can never fail the rename itself.
      try {
        db.prepare('UPDATE saved_accounts SET nick = ? WHERE user_id = ?').run(patch.username, current.id);
        const lowerSame = patch.username.toLowerCase() === current.username.toLowerCase();
        const targetTaken = db.prepare('SELECT 1 AS one FROM offline_skins WHERE lower(username) = lower(?)').get(patch.username) as unknown;
        if (lowerSame || !targetTaken) {
          db.prepare('UPDATE offline_skins SET username = ?, updated_at = ? WHERE lower(username) = lower(?)')
            .run(patch.username, Date.now(), current.username);
        }
      } catch { /* cosmetic propagation — the rename itself already succeeded */ }
    }
    if (patch.avatar !== undefined) {
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(patch.avatar, current.id);
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(current.id) as Record<string, unknown>;
    return { ok: true, user: rowToUser(row) };
  });

  ipcMain.handle(IPC.AUTH_CHANGE_PASSWORD, async (_e, currentPw: string, nextPw: string) => {
    const current = await getCurrentUser(db);
    if (!current) return { ok: false, error: 'Not authenticated.' };
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(current.id) as { password_hash: string };
    if (!bcrypt.compareSync(currentPw, row.password_hash)) return { ok: false, error: 'Current password is incorrect.' };
    if (nextPw.length < 4) return { ok: false, error: 'New password must be at least 4 characters.' };
    const hash = bcrypt.hashSync(nextPw, SALT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, current.id);
    return { ok: true };
  });
}

function getCurrentUser(db: HandlerDeps['db']): Promise<UserAccount | null> {
  const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
  if (!tokenRow) return Promise.resolve(null);
  let token: string;
  try { token = JSON.parse(tokenRow.value) as string; } catch { return Promise.resolve(null); }
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
  if (!session) return Promise.resolve(null);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as Record<string, unknown> | undefined;
  return Promise.resolve(row ? rowToUser(row) : null);
}