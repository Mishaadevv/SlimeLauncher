import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { MapEntry } from '../../shared/types.js';
import { notify } from './types.js';

const CF_API = 'https://api.curseforge.com';
const CF_KEY = '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEjQnPnm';
const CF_MINECRAFT = 432; // classId for Minecraft

function cfFetch(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'x-api-key': CF_KEY, 'Accept': 'application/json', 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
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

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const doReq = (reqUrl: string) => {
      const c = reqUrl.startsWith('https') ? https : http;
      c.get(reqUrl, { headers: { 'x-api-key': CF_KEY, 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res: any) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doReq(res.headers.location);
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => { out.close(); resolve(); });
        out.on('error', reject);
      }).on('error', reject);
    };
    doReq(url);
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
    const dest = path.join(downloadsDir, fileName);

    const dlId = downloadManager.enqueue(data.name, fileUrl, dest, 'map');
    waitForDownload(downloadManager, dlId, dest, savesDir, data.name, logger).catch((err) => {
      notify(deps, { type: 'error', title: 'Map install failed', message: String(err) });
    });

    const id = randomUUID();
    db.prepare(
      'INSERT INTO maps (id, instance_id, name, author, map_type, file_name, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, data.instanceId, data.name, data.author || 'Community', data.mapType || 'Adventure', fileName, Date.now());

    logger.info('Map install started', { id, name: data.name, dlId });
    notify(deps, { type: 'info', title: 'Installing map', message: `${data.name} is downloading...` });
    return { ok: true, mapId: id, downloadId: dlId };
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
      const file = path.join(settings.minecraftDirectory, row.instance_id, 'downloads', row.file_name);
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      // Delete the extracted saves folder
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

async function waitForDownload(downloadManager: HandlerDeps['downloadManager'], id: string, archivePath: string, savesDir: string, name: string, logger: HandlerDeps['logger']) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const task = downloadManager.list().find((item) => item.id === id);
    if (!task) return;
    if (task.status === 'error' || task.status === 'cancelled') return;
    if (task.status !== 'completed') continue;
    try {
      const safeName = name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'World';
      const target = path.join(savesDir, safeName);
      fs.mkdirSync(target, { recursive: true });
      if (archivePath.toLowerCase().endsWith('.zip')) {
        await execFileAsync(process.platform === 'win32' ? 'powershell.exe' : 'unzip', process.platform === 'win32' ? ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`] : ['-o', archivePath, '-d', target]);
      } else {
        fs.copyFileSync(archivePath, path.join(target, path.basename(archivePath)));
      }
      logger.info('Map installed into saves', { id, target });
      try { fs.unlinkSync(archivePath); } catch { /* keep download if cleanup fails */ }
      return;
    } catch (error) {
      logger.error('Map extraction failed', { id, error: String(error) });
      return;
    }
  }
}
