import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { FriendRow } from '../../shared/types.js';
import { offlineUuid } from '../services/skin-server.js';

function rowToFriend(r: Record<string, unknown>): FriendRow {
  const nick = String(r.nick);
  return {
    id: String(r.id),
    nick,
    note: r.note ? String(r.note) : null,
    // Offline players are always identified by the offline uuid of their nick,
    // so the skin head can be resolved from the local skin server even when
    // the friend is offline. Microsoft players get their real uuid from the
    // presence packet while online.
    uuid: offlineUuid(nick),
    createdAt: Number(r.created_at),
  };
}

export function registerFriendsHandlers(deps: HandlerDeps) {
  const { db, presence, logger } = deps;

  ipcMain.handle(IPC.FRIENDS_LIST, () => {
    const rows = db.prepare('SELECT * FROM friends ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToFriend);
  });

  ipcMain.handle(IPC.FRIENDS_ADD, (_e, nick: string) => {
    const clean = String(nick || '').trim();
    if (!clean) return { ok: false, error: 'Enter a nickname to add.' };
    if (clean.length > 32) return { ok: false, error: 'Nickname is too long (max 32 characters).' };
    const exists = db.prepare('SELECT id FROM friends WHERE lower(nick) = lower(?)').get(clean);
    if (exists) return { ok: false, error: `${clean} is already in your friends list.` };
    const id = randomUUID();
    db.prepare('INSERT INTO friends (id, nick, created_at) VALUES (?, ?, ?)').run(id, clean, Date.now());
    logger.info('Friend added', { id, nick: clean });
    return { ok: true, friend: { id, nick: clean, note: null, uuid: offlineUuid(clean), createdAt: Date.now() } };
  });

  ipcMain.handle(IPC.FRIENDS_REMOVE, (_e, id: string) => {
    db.prepare('DELETE FROM friends WHERE id = ?').run(id);
    return { ok: true };
  });

  // Which instances of mine could join this friend's LAN world
  // (same MC version + identical mods set).
  ipcMain.handle(IPC.FRIENDS_COMPAT, (_e, game: string, mods: string) => {
    return presence.compatibleInstances(String(game || ''), String(mods || ''));
  });
}
