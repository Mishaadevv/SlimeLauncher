import https from 'node:https';
import http from 'node:http';
import type { Logger } from './logger.js';

// Ely.by skinsystem — free central skin/cape service compatible with TLauncher.
// Docs: https://docs.ely.by/en/skins-system.html
//   GET https://skinsystem.ely.by/skins/{nick}.png  -> 200 PNG or 404
//   GET https://skinsystem.ely.by/cloaks/{nick}.png -> 200 PNG or 404
// Both are case-insensitive and may 301-redirect to a CDN URL.

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min for positive, longer for negative via separate map
const NEG_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6000;

interface CacheEntry {
  skin: string | null;
  cape: string | null;
  variant: string | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function fetchPngBase64(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const doGet = (u: string, redirects = 0) => {
      if (redirects > 4) return resolve(null);
      const client = u.startsWith('https://') ? https : http;
      const req = client.get(u, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          res.resume();
          const next = loc.startsWith('http') ? loc : new URL(loc, u).toString();
          doGet(next, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length < 8) return resolve(null);
          const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          if (!buf.subarray(0, 8).equals(sig)) return resolve(null);
          resolve(buf.toString('base64'));
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    };
    doGet(url);
  });
}

// Lightweight textures JSON endpoint: https://skinsystem.ely.by/textures/{nick}
// Returns { SKIN:{url,metadata}, CAPE:{url} } — we can use it to detect slim variant
async function fetchTexturesMeta(nick: string): Promise<{ variant: string | null } | null> {
  return new Promise((resolve) => {
    const url = `https://skinsystem.ely.by/textures/${encodeURIComponent(nick)}`;
    const req = https.get(url, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data) as { SKIN?: { metadata?: { model?: string } } };
          const model = j?.SKIN?.metadata?.model;
          resolve({ variant: model === 'slim' ? 'slim' : 'classic' });
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

export async function fetchElyByTextures(nick: string, logger?: Logger): Promise<{ skin: string | null; cape: string | null; variant: string | null } | null> {
  const key = nick.toLowerCase();
  const cached = cache.get(key);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    const ttl = cached.skin || cached.cape ? CACHE_TTL_MS : NEG_TTL_MS;
    if (age < ttl) return cached;
  }
  try {
    const [skin, cape, meta] = await Promise.all([
      fetchPngBase64(`https://skinsystem.ely.by/skins/${encodeURIComponent(nick)}.png`),
      fetchPngBase64(`https://skinsystem.ely.by/cloaks/${encodeURIComponent(nick)}.png`),
      fetchTexturesMeta(nick),
    ]);
    const entry: CacheEntry = {
      skin,
      cape,
      variant: meta?.variant || (skin ? 'classic' : null),
      fetchedAt: Date.now(),
    };
    // keep cache small
    if (cache.size > 500) cache.clear();
    cache.set(key, entry);
    if (!skin && !cape) {
      logger?.debug('ely.by miss', { nick });
      return null;
    }
    logger?.info('ely.by hit', { nick, hasSkin: !!skin, hasCape: !!cape });
    return entry;
  } catch (e) {
    logger?.debug('ely.by fetch failed', { nick, error: String(e) });
    return null;
  }
}

export function clearElyByCache() {
  cache.clear();
}
