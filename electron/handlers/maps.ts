import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { MapEntry } from '../../shared/types.js';
import { notify } from './types.js';
import { CF_API, cfApiKey } from '../services/cf-config.js';

const CF_MINECRAFT = 432; // classId for Minecraft

function cfFetch(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'x-api-key': cfApiKey(), 'Accept': 'application/json', 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`CurseForge API error: HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function rowToMap(r: Record<string, unknown>): MapEntry {
  return {
    id: String(r.id),
    instanceId: String(r.instance_id),
    name: String(r.name),
    author: r.author ? String(r.author) : '',
    mapType: r.map_type ? String(r.map_type) : '',
    fileName: String(r.file_name),
    installedAt: Number(r.installed_at),
  };
}

export function registerMapHandlers(deps: HandlerDeps) {
  const { db, settingsStore, downloadManager, logger } = deps;

  ipcMain.handle(IPC.MAP_LIST, (_e, instanceId: string) => {
    const rows = db.prepare('SELECT * FROM maps WHERE instance_id = ? ORDER BY installed_at DESC').all(instanceId) as Record<string, unknown>[];
    return rows.map(rowToMap);
  });

  ipcMain.handle(IPC.MAP_SEARCH, async (_e, query: string, category: string, page: number, sort?: string, gameVersion?: string) => {
    try {
      const params = new URLSearchParams();
      params.set('gameId', String(CF_MINECRAFT));
      params.set('classId', '17'); // Maps & Resources
      params.set('pageSize', '20');
      params.set('index', String(page * 20));
      if (query) params.set('searchFilter', query);
      if (gameVersion) params.set('gameVersion', gameVersion);
      const categoryMap: Record<string, number> = {
        'adventure': 248, 'quests': 250, 'puzzle': 252, 'challenge': 250,
        'redstone': 250, 'survival': 253, 'creative': 249, 'parkour': 251,
        'minigame': 250, 'texture-pack': 12,
      };
      if (category && categoryMap[category]) {
        params.set('categoryIds', String(categoryMap[category]));
      }

      // CurseForge sortField: 1=Featured, 2=Popularity, 3=LastUpdated, 4=Name, 5=Downloads
      // For relevance: don't set sortField — API uses default relevance ranking
      const sortFieldMap: Record<string, string> = {
        'popularity': '2',
        'updated': '3',
      };
      if (sort && sortFieldMap[sort]) {
        params.set('sortField', sortFieldMap[sort]);
        params.set('sortOrder', 'desc');
      }

      const url = `${CF_API}/v1/mods/search?${params.toString()}`;
      const result = (await cfFetch(url)) as { data: Array<{ id: number; name: string; slug: string; summary: string; downloadCount: number; logo?: { thumbnailUrl: string }; authors?: Array<{ name: string }>; categories?: Array<{ name: string }> }>; pagination: { totalCount: number } };

      const hits = (result.data || []).map((m) => ({
        project_id: String(m.id),
        slug: m.slug,
        title: m.name,
        description: m.summary || '',
        author: m.authors?.[0]?.name || 'Community',
        downloads: m.downloadCount || 0,
        icon_url: m.logo?.thumbnailUrl || null,
        image_url: m.logo?.thumbnailUrl || null,
        categories: m.categories?.map((c) => c.name) || [],
      }));

      return { hits, total: result.pagination?.totalCount || 0 };
    } catch (e) {
      logger.error('CurseForge map search failed', { error: String(e) });
      return { hits: [], total: 0 };
    }
  });

  ipcMain.handle(IPC.MAP_INSTALL, async (_e, data: { instanceId: string; name: string; author?: string; mapType?: string; fileUrl?: string; fileName?: string; mapId?: string }) => {
    const settings = settingsStore.load();
    let fileUrl = data.fileUrl;
    let fileName = data.fileName;

    if ((!fileUrl || !fileName) && data.mapId) {
      try {
        const versionsResp = (await cfFetch(`${CF_API}/v1/mods/${data.mapId}/files?gameId=${CF_MINECRAFT}`)) as { data: Array<{ downloadUrl: string; fileName: string }> };
        const file = versionsResp.data?.[0];
        if (file) { fileUrl = file.downloadUrl; fileName = file.fileName; }
      } catch (e) {
        logger.error('Failed to fetch map files from CurseForge', { error: String(e) });
      }
    }

    if (!fileUrl || !fileName) return { ok: false, error: 'Map file information is missing.' };

    const instanceDir = path.join(settings.minecraftDirectory, data.instanceId);
    const downloadsDir = path.join(instanceDir, 'downloads');
    const savesDir = path.join(instanceDir, 'saves');
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.mkdirSync(savesDir, { recursive: true });
    // The archive name comes from the network — strip any directory parts.
    const safeFileName = path.basename(String(fileName));
    const dest = path.join(downloadsDir, safeFileName);

    const dlId = downloadManager.enqueue(data.name, fileUrl, dest, 'map');

    // Fire-and-forget: the DB row is created only after the download AND the
    // extraction succeed, so a failed/cancelled/timed-out download can never
    // leave a phantom map in the installed list.
    void finishMapInstall(deps, {
      dlId,
      archivePath: dest,
      savesDir,
      instanceId: data.instanceId,
      name: data.name,
      author: data.author || 'Community',
      mapType: data.mapType || 'Adventure',
      fileName: safeFileName,
    });

    logger.info('Map install started', { name: data.name, dlId });
    notify(deps, { type: 'info', title: 'Installing map', message: `${data.name} is downloading...` });
    return { ok: true, downloadId: dlId };
  });

  ipcMain.handle(IPC.MAP_OPEN_FOLDER, (_e, id: string) => {
    const row = db.prepare('SELECT instance_id FROM maps WHERE id = ?').get(id) as { instance_id: string } | undefined;
    if (!row) return { ok: false, error: 'Map not found.' };
    const savesDir = path.join(settingsStore.load().minecraftDirectory, row.instance_id, 'saves');
    fs.mkdirSync(savesDir, { recursive: true });
    void shell.openPath(savesDir);
    return { ok: true };
  });

  ipcMain.handle(IPC.MAP_DELETE, (_e, id: string) => {
    const row = db.prepare('SELECT instance_id, file_name, name FROM maps WHERE id = ?').get(id) as { instance_id: string; file_name: string; name: string } | undefined;
    if (row) {
      const settings = settingsStore.load();
      // Delete the downloaded archive
      const file = path.join(settings.minecraftDirectory, row.instance_id, 'downloads', path.basename(row.file_name));
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      // Delete the extracted world folder (all hoisted worlds live inside it).
      const safeName = row.name.replace(/[<>:"/\\|?*]+/g, '').trim();
      if (safeName) {
        const savesDir = path.join(settings.minecraftDirectory, row.instance_id, 'saves', safeName);
        try { fs.rmSync(savesDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    db.prepare('DELETE FROM maps WHERE id = ?').run(id);
    return { ok: true };
  });

  ipcMain.handle(IPC.MAP_SCREENS, async (_e, projectId: string) => {
    try {
      // CurseForge — projectId is the numeric mod/map ID
      const result = (await cfFetch(`${CF_API}/v1/mods/${projectId}`)) as {
        data?: { screenshots?: Array<{ url: string; thumbnailUrl: string; caption?: string }> };
      };
      return (result.data?.screenshots || []).map((s) => ({
        url: `cfimg://${encodeURIComponent(s.url)}`,
        caption: s.caption || '',
      }));
    } catch (e) {
      logger.error('Failed to fetch map screenshots', { error: String(e), projectId });
      return [];
    }
  });
}

interface MapInstallJob {
  dlId: string;
  archivePath: string;
  savesDir: string;
  instanceId: string;
  name: string;
  author: string;
  mapType: string;
  fileName: string;
}

// Waits for the queued download, unpacks it into saves/ and only then records
// the map in the DB. Every failure path notifies with the concrete reason and
// leaves no trace (no phantom list entries, no half-extracted folders).
async function finishMapInstall(deps: HandlerDeps, job: MapInstallJob): Promise<void> {
  const { downloadManager, db, logger } = deps;
  const fail = (message: string) => {
    logger.warn('Map install failed', { name: job.name, message });
    notify(deps, { type: 'error', title: 'Map install failed', message: `${job.name}: ${message}` });
  };

  // 1. Wait for the download (3 min cap).
  let completed = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const task = downloadManager.list().find((item) => item.id === job.dlId);
    if (!task) {
      // Task row gone (pruned/cleared): continue only if the file is there.
      try {
        if (fs.statSync(job.archivePath).size > 0) { completed = true; break; }
      } catch { /* missing */ }
      return fail('the download was cancelled.');
    }
    if (task.status === 'error') return fail(`the download failed${task.error ? `: ${task.error}` : '.'}`);
    if (task.status === 'cancelled') return fail('the download was cancelled.');
    if (task.status === 'completed') { completed = true; break; }
  }
  if (!completed) return fail('the download timed out. Check your connection and try again.');
  if (!fs.existsSync(job.archivePath)) return fail('the downloaded file is missing.');

  // 2. Extract.
  const safeName = job.name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'World';
  const target = path.join(job.savesDir, safeName);
  const isZip = /\.zip$/i.test(job.archivePath) || /\.mcworld$/i.test(job.archivePath);
  try {
    fs.mkdirSync(target, { recursive: true });
    if (isZip) {
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${job.archivePath.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`]);
      } else {
        await execFileAsync('unzip', ['-o', job.archivePath, '-d', target]);
      }
      hoistNestedWorld(target, logger);
      // The world must actually be visible to the game now.
      if (findWorldDirs(target).length === 0) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
        return fail('the archive contains no world (level.dat not found).');
      }
    } else {
      // Unknown archive type (e.g. .rar) — keep the file for manual unpacking.
      fs.copyFileSync(job.archivePath, path.join(target, path.basename(job.archivePath)));
    }
  } catch (e) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    return fail(`could not unpack the archive (${e instanceof Error ? e.message : String(e)}).`);
  }

  // 3. Record + cleanup.
  try { fs.unlinkSync(job.archivePath); } catch { /* keep the archive if cleanup fails */ }
  db.prepare(
    'INSERT INTO maps (id, instance_id, name, author, map_type, file_name, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), job.instanceId, job.name, job.author, job.mapType, job.fileName, Date.now());
  logger.info('Map installed into saves', { name: job.name, target });
  notify(deps, { type: 'success', title: 'Map installed', message: `${job.name} is ready in saves.` });
}

// Finds world folders under a directory: relative paths of dirs containing
// level.dat ('' = the directory itself), max 4 levels deep, skipping
// junk like __MACOSX and dot-folders.
function findWorldDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 4) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'level.dat')) out.push(rel);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
      walk(path.join(dir, e.name), rel ? `${rel}${path.sep}${e.name}` : e.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  let i = 2;
  while (fs.existsSync(`${p} (${i})`)) i += 1;
  return `${p} (${i})`;
}

// Removes empty directories upwards from `dir` (exclusive) to `root`.
function pruneEmptyParents(root: string, dir: string): void {
  let cur = dir;
  while (cur !== root && cur.startsWith(root)) {
    let empty = false;
    try {
      empty = fs.readdirSync(cur).length === 0;
      if (empty) fs.rmdirSync(cur);
    } catch {
      return;
    }
    if (!empty) return;
    cur = path.dirname(cur);
  }
}

// Map zips usually wrap the world in a top-level folder, e.g.
// saves/<name>/<World>/level.dat — the game only reads saves/<dir>/level.dat
// one level deep, so such worlds show up under a wrong name (or not at all
// when nested deeper). Hoist nested worlds into <name>/ itself: a single
// world is merged in (its folder takes the map's name), several worlds each
// become a direct child ("<World1>", "<World2>", …). Direct children are
// already visible and are left alone.
function hoistNestedWorld(target: string, logger: HandlerDeps['logger']): void {
  const worlds = findWorldDirs(target).filter((d) => d !== '');
  if (worlds.length === 0) return; // caller reports "no level.dat"
  for (const rel of worlds) {
    const src = path.join(target, rel);
    try {
      if (worlds.length === 1) {
        // Single world: merge its contents into the target root.
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
          fs.renameSync(path.join(src, entry), uniquePath(path.join(target, entry)));
        }
        pruneEmptyParents(target, src);
        logger.info('Hoisted nested map world', { from: rel, to: '.' });
      } else if (rel.includes(path.sep)) {
        // Several worlds, nested deeper: move each whole folder up so every
        // world becomes a direct (visible) child of the target.
        const dest = uniquePath(path.join(target, path.basename(rel)));
        fs.renameSync(src, dest);
        pruneEmptyParents(target, path.dirname(src));
        logger.info('Hoisted nested map world', { from: rel, to: path.basename(dest) });
      }
      // Several worlds as direct children: already visible, leave them.
    } catch (e) {
      logger.warn('Failed to hoist nested map world', { from: rel, error: String(e) });
    }
  }
}
