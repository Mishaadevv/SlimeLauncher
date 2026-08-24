// SlimeLauncher skin directory server.
//
// A tiny rendezvous service that lets two SlimeLauncher users see each
// other's custom skins while playing on ANY third-party Minecraft server.
// The launcher publishes the active account's skin here (keyed by nickname)
// and resolves other players' skins by their offline UUID — which is a
// deterministic function of the nickname (md5("OfflinePlayer:<nick>")), so a
// UUID lookup can be reversed to the nick's stored skin without knowing the
// nick in advance.
//
// Zero dependencies — Node.js stdlib only. Deploy anywhere (VPS, Fly.io,
// Render, a systemd unit behind nginx…):
//   node server.mjs            # PORT=8080 by default
//
// API:
//   PUT  /api/skins/<nick>     { skin: base64png, variant: "classic"|"slim", cape?: base64png }
//   GET  /api/skins/<nick>     -> { nick, skin, variant, cape, updatedAt } | 404
//   GET  /api/skins/byuuid/<dashless-uuid> -> same shape | 404
//   GET  /health               -> "ok"
//
// Storage is a single JSON file (data.json next to this script) written
// atomically. Fine for thousands of skins; swap for SQLite/Postgres if the
// directory ever grows big.
//
// NOTE ON TRUST: v1 has no authentication — whoever knows a nick can replace
// its skin (last write wins). Acceptable for a friends-scale directory; add
// per-nick tokens before running anything public.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const MAX_JSON_BYTES = 12 * 1024 * 1024; // ~8 MB PNG + base64 overhead + cape
const MAX_PNG_BYTES = 8 * 1024 * 1024;   // mirrors the launcher's own limit
const NICK_RE = /^[A-Za-z0-9_-]{1,24}$/;

// Per-IP rate limit for writes: 10 publishes per minute.
const WRITE_WINDOW_MS = 60_000;
const WRITES_PER_WINDOW = 10;
const writeCounts = new Map(); // ip -> [timestamps]

function offlineUuid(nick) {
  const hash = createHash('md5').update(`OfflinePlayer:${nick}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- storage ---------------------------------------------------------------

let db = { byNick: {} }; // nick(lowercase) -> entry

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.byNick === 'object') db = parsed;
  } catch {
    /* first run / corrupt file — start empty */
  }
}

let saveTimer = null;
function scheduleSave() {
  // Coalesce bursts of publishes into one disk write.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('Failed to persist data:', e);
    }
  }, 500);
}

load();

// --- helpers ----------------------------------------------------------------

function pngOk(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return false;
  if (base64.length > Math.ceil(MAX_PNG_BYTES * 4 / 3) + 4) return false;
  let buf;
  try { buf = Buffer.from(base64, 'base64'); } catch { return false; }
  if (buf.length < 8 || buf.length > MAX_PNG_BYTES) return false;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buf.subarray(0, 8).equals(sig);
}

function publicEntry(e) {
  return { nick: e.nick, skin: e.skin, variant: e.variant, cape: e.cape ?? null, updatedAt: e.updatedAt };
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (writeCounts.get(ip) || []).filter((t) => now - t < WRITE_WINDOW_MS);
  if (arr.length >= WRITES_PER_WINDOW) {
    writeCounts.set(ip, arr);
    return true;
  }
  arr.push(now);
  writeCounts.set(ip, arr);
  // Opportunistic cleanup so the map can't grow forever.
  if (writeCounts.size > 10_000) writeCounts.clear();
  return false;
}

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// --- routes -----------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/health') {
    send(res, 200, 'ok', 'text/plain');
    return;
  }

  const putMatch = pathname.match(/^\/api\/skins\/([^/]+)$/);
  if (putMatch && req.method === 'PUT') {
    const nick = putMatch[1];
    if (!NICK_RE.test(nick)) {
      send(res, 400, { error: 'Invalid nickname.' });
      return;
    }
    if (rateLimited(req.socket.remoteAddress || '?')) {
      send(res, 429, { error: 'Too many requests.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_JSON_BYTES));
    } catch {
      send(res, 400, { error: 'Invalid JSON or payload too large.' });
      return;
    }
    if (!pngOk(body.skin)) {
      send(res, 400, { error: 'skin must be a base64 PNG up to 8 MB.' });
      return;
    }
    if (body.cape !== undefined && body.cape !== null && !pngOk(body.cape)) {
      send(res, 400, { error: 'cape must be a base64 PNG up to 8 MB.' });
      return;
    }
    const variant = body.variant === 'slim' ? 'slim' : 'classic';
    const key = nick.toLowerCase();
    db.byNick[key] = {
      nick,
      skin: body.skin,
      variant,
      cape: typeof body.cape === 'string' ? body.cape : null,
      uuid: offlineUuid(nick).replace(/-/g, ''),
      updatedAt: Date.now(),
    };
    scheduleSave();
    send(res, 200, { ok: true });
    return;
  }

  const getMatch = pathname.match(/^\/api\/skins\/([^/]+)$/);
  if (getMatch && req.method === 'GET') {
    const key = getMatch[1].toLowerCase();
    const e = db.byNick[key];
    if (!e) { send(res, 404, { error: 'Not found.' }); return; }
    send(res, 200, publicEntry(e));
    return;
  }

  const uuidMatch = pathname.match(/^\/api\/skins\/byuuid\/([0-9a-fA-F]{32})$/);
  if (uuidMatch && req.method === 'GET') {
    const target = uuidMatch[1].toLowerCase();
    const e = Object.values(db.byNick).find((x) => x.uuid === target);
    if (!e) { send(res, 404, { error: 'Not found.' }); return; }
    send(res, 200, publicEntry(e));
    return;
  }

  send(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, { error: 'Internal error.' });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`SlimeLauncher skin directory listening on :${PORT}`);
});
