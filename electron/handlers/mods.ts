import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import type { ModEntry } from '../../shared/types.js';
import { notify } from './types.js';
import { CF_API, cfApiKey } from '../services/cf-config.js';

const CF_MINECRAFT = 432;

function mrFetch(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0', 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`Modrinth API error: HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

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

function rowToMod(r: Record<string, unknown>): ModEntry {
  return {
    id: String(r.id),
    instanceId: String(r.instance_id),
    slug: r.slug ? String(r.slug) : '',
    name: String(r.name),
    author: r.author ? String(r.author) : '',
    version: r.version ? String(r.version) : '',
    fileName: String(r.file_name),
    enabled: Number(r.enabled) === 1,
    installedAt: Number(r.installed_at),
    source: String(r.source) as ModEntry['source'],
  };
}

export function registerModHandlers(deps: HandlerDeps) {
  const { db, settingsStore, downloadManager, logger } = deps;

  ipcMain.handle(IPC.MOD_LIST, (_e, instanceId: string) => {
    const rows = db.prepare('SELECT * FROM mods WHERE instance_id = ? ORDER BY installed_at DESC').all(instanceId) as Record<string, unknown>[];
    return rows.map(rowToMod);
  });

  ipcMain.handle(IPC.MOD_SEARCH, async (_e, query: string, facets: string[], page: number, sort?: string, gameVersion?: string) => {
    try {
      const isModpack = facets.includes('project_type:modpack');
      const params = new URLSearchParams();
      params.set('gameId', String(CF_MINECRAFT));
      params.set('classId', isModpack ? '4471' : '6'); // 4471 = Modpacks, 6 = Mods
      params.set('pageSize', '20');
      params.set('index', String(page * 20));
      if (query) params.set('searchFilter', query);
      if (gameVersion) params.set('gameVersion', gameVersion);

      // Convert facet categories to CurseForge category IDs
      const categoryMap: Record<string, number> = {
        'optimization': 6814, 'adventure': 422, 'technology': 412, 'magic': 419,
        'worldgen': 406, 'mobs': 411, 'building': 409, 'decoration': 424,
        'utility': 5191, 'performance': 6814, 'horror': 10775, 'rpg': 422,
      };
      for (const facet of facets) {
        const match = facet.match(/^categories:(.+)$/);
        if (match) {
          const catId = categoryMap[match[1]];
          if (catId) params.set('categoryIds', String(catId));
        }
      }

      // CurseForge sortField: 1=Featured, 2=Popularity, 3=LastUpdated, 4=Name, 5=Downloads
      // For relevance: don't set sortField — API uses default relevance ranking
      const sortFieldMap: Record<string, string> = {
        'downloads': '2',
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
        author: m.authors?.[0]?.name || 'Unknown',
        downloads: m.downloadCount || 0,
        icon_url: m.logo?.thumbnailUrl || null,
        categories: m.categories?.map((c) => c.name) || [],
      }));

      return { hits, total: result.pagination?.totalCount || 0 };
    } catch (e) {
      logger.error('CurseForge mod search failed', { error: String(e) });
      return { hits: [], total: 0 };
    }
  });

  ipcMain.handle(IPC.MOD_VERSIONS, async (_e, slug: string, mcVersion: string, loader: string, projectId?: string) => {
    try {
      // Use projectId if available (from search results), otherwise search by slug
      let modId: number | undefined;
      if (projectId) {
        modId = parseInt(projectId, 10);
      }
      if (!modId) {
        const searchResp = (await cfFetch(`${CF_API}/v1/mods/search?gameId=${CF_MINECRAFT}&searchFilter=${encodeURIComponent(slug)}&pageSize=5`)) as { data: Array<{ id: number; slug: string }> };
        // Try exact slug match first
        const exact = searchResp.data?.find((m) => m.slug === slug);
        modId = exact?.id || searchResp.data?.[0]?.id;
      }
      if (!modId) return [];

      // Get files for this mod — first without loader filter (many mods don't categorize by loader)
      let filesQuery = `${CF_API}/v1/mods/${modId}/files?gameId=${CF_MINECRAFT}&pageSize=50`;
      if (mcVersion) filesQuery += `&gameVersion=${mcVersion}`;

      const filesResp = (await cfFetch(filesQuery)) as {
        data: Array<{
          id: number; displayName: string; fileName: string; downloadUrl: string;
          gameVersions: string[]; fileLength: number; releaseType: number;
        }>;
      };

      let files = (filesResp.data || []);

      // Filter out files without download URLs
      files = files.filter((f) => !!f.downloadUrl);

      // Filter: keep only files that contain the mcVersion in gameVersions
      if (mcVersion) {
        files = files.filter((f) => f.gameVersions?.includes(mcVersion));
      }

      // If we have a loader preference, try to filter further but keep all if none match
      if (loader) {
        const loaderLower = loader.toLowerCase();
        const loaderFiltered = files.filter((f) =>
          f.gameVersions?.some((gv) => gv.toLowerCase() === loaderLower)
        );
        if (loaderFiltered.length > 0) files = loaderFiltered;
      }

      // Sort by release type (release=1 first, then beta=3, then alpha=4) then date
      const typeOrder: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3 };
      files.sort((a, b) => (typeOrder[a.releaseType] ?? 9) - (typeOrder[b.releaseType] ?? 9));

      return files.map((f) => ({
        id: String(f.id),
        name: f.displayName,
        version_number: f.fileName,
        game_versions: f.gameVersions || [],
        loaders: [loader],
        files: [{
          url: f.downloadUrl,
          filename: f.fileName,
          primary: true,
          size: f.fileLength,
        }],
      }));
    } catch (e) {
      logger.error('CurseForge version fetch failed', { error: String(e) });
      return [];
    }
  });

  ipcMain.handle(IPC.MOD_SEARCH_MODRINTH, async (_e, query: string, facets: string[], page: number, sort?: string, gameVersion?: string) => {
    try {
      const url = new URL('https://api.modrinth.com/v2/search');
      url.searchParams.set('query', query || '');
      url.searchParams.set('limit', '20');
      url.searchParams.set('offset', String(page * 20));
      const indexMap: Record<string, string> = { downloads: 'downloads', updated: 'updated' };
      url.searchParams.set('index', indexMap[sort || ''] || 'relevance');

      // Modrinth facet format: an array of arrays — outer = AND, inner = OR.
      // Each facet group must be its own inner array, otherwise the category is
      // OR'd with project_type:mod and the filter silently matches everything.
      const isModpack = facets.includes('project_type:modpack');
      const cfacets: string[][] = [[isModpack ? 'project_type:modpack' : 'project_type:mod']];
      for (const facet of facets) {
        const m = facet.match(/^categories:(.+)$/);
        if (m) cfacets.push([`categories:${m[1]}`]);
      }
      if (gameVersion) cfacets.push([`versions:${gameVersion}`]);
      url.searchParams.set('facets', JSON.stringify(cfacets));

      const result = (await mrFetch(url.toString())) as {
        hits?: Array<{ project_id: string; slug: string; title: string; description: string; author: string; categories: string[]; downloads: number; icon_url: string | null }>;
        total_hits?: number;
      };
      return {
        hits: (result.hits || []).map((m) => ({
          project_id: m.project_id,
          slug: m.slug,
          title: m.title,
          description: m.description,
          author: m.author,
          downloads: m.downloads,
          icon_url: m.icon_url,
          categories: m.categories || [],
        })),
        total: result.total_hits || 0,
      };
    } catch (e) {
      logger.error('Modrinth mod search failed', { error: String(e) });
      return { hits: [], total: 0 };
    }
  });

  ipcMain.handle(IPC.MOD_VERSIONS_MODRINTH, async (_e, slug: string, mcVersion: string, loader: string) => {
    try {
      const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`);
      if (mcVersion) {
        url.searchParams.set('game_versions', JSON.stringify([mcVersion]));
      }
      if (loader) {
        url.searchParams.set('loaders', JSON.stringify([loader]));
      }
      const list = (await mrFetch(url.toString())) as Array<{
        id: string; name: string; version_number: string; game_versions: string[]; loaders: string[];
        files: Array<{ url: string; filename: string; primary: boolean; size: number }>;
      }>;
      return (list || []).map((v) => ({
        id: v.id,
        name: v.name,
        version_number: v.version_number,
        game_versions: v.game_versions || [],
        loaders: v.loaders || [],
        files: v.files || [],
        channel: 'release',
      }));
    } catch (e) {
      logger.error('Modrinth version fetch failed', { error: String(e), slug });
      return [];
    }
  });

  ipcMain.handle(IPC.MOD_INSTALL_MODRINTH, async (_e, data: { instanceId: string; slug: string; name: string; author: string; versionId: string; versionNumber: string; fileUrl: string; fileName: string }) => {
    const inst = db.prepare('SELECT loader FROM instances WHERE id = ?').get(data.instanceId) as { loader: string } | undefined;
    if (!inst) return { ok: false, error: 'Instance not found.' };
    if (inst.loader === 'vanilla') {
      return { ok: false, error: 'Mods can only be installed on loader instances (Fabric, Forge, NeoForge or Quilt).' };
    }
    const settings = settingsStore.load();
    const modsDir = path.join(settings.minecraftDirectory, data.instanceId, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const dest = path.join(modsDir, data.fileName);

    const dlId = downloadManager.enqueue(data.name, data.fileUrl, dest, 'mod');

    const id = randomUUID();
    db.prepare(
      'INSERT INTO mods (id, instance_id, slug, name, author, version, file_name, enabled, installed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, data.instanceId, data.slug, data.name, data.author, data.versionNumber, data.fileName, Date.now(), 'modrinth');

    logger.info('Modrinth mod install started', { id, slug: data.slug, dlId });
    notify(deps, { type: 'info', title: 'Installing mod', message: `${data.name} is downloading...` });
    return { ok: true, modId: id, downloadId: dlId };
  });

  ipcMain.handle(IPC.MOD_INSTALL, async (_e, data: { instanceId: string; slug: string; name: string; author: string; versionId: string; versionNumber: string; fileUrl: string; fileName: string; source: ModEntry['source'] }) => {
    const inst = db.prepare('SELECT loader FROM instances WHERE id = ?').get(data.instanceId) as { loader: string } | undefined;
    if (!inst) return { ok: false, error: 'Instance not found.' };
    if (inst.loader === 'vanilla') {
      return { ok: false, error: 'Mods can only be installed on loader instances (Fabric, Forge, NeoForge or Quilt).' };
    }
    const settings = settingsStore.load();
    const modsDir = path.join(settings.minecraftDirectory, data.instanceId, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const dest = path.join(modsDir, data.fileName);

    const dlId = downloadManager.enqueue(data.name, data.fileUrl, dest, 'mod');

    const id = randomUUID();
    db.prepare(
      'INSERT INTO mods (id, instance_id, slug, name, author, version, file_name, enabled, installed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, data.instanceId, data.slug, data.name, data.author, data.versionNumber, data.fileName, Date.now(), data.source);

    logger.info('Mod install started', { id, slug: data.slug, dlId });
    notify(deps, { type: 'info', title: 'Installing mod', message: `${data.name} is downloading...` });
    return { ok: true, modId: id, downloadId: dlId };
  });

  ipcMain.handle(IPC.MOD_DELETE, (_e, id: string) => {
    const row = db.prepare('SELECT instance_id, file_name FROM mods WHERE id = ?').get(id) as { instance_id: string; file_name: string } | undefined;
    if (row) {
      const settings = settingsStore.load();
      const file = path.join(settings.minecraftDirectory, row.instance_id, 'mods', row.file_name);
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
    db.prepare('DELETE FROM mods WHERE id = ?').run(id);
    return { ok: true };
  });

  ipcMain.handle(IPC.MOD_TOGGLE, (_e, id: string, enabled: boolean) => {
    const row = db.prepare('SELECT instance_id, file_name FROM mods WHERE id = ?').get(id) as { instance_id: string; file_name: string } | undefined;
    if (row) {
      const settings = settingsStore.load();
      const modsDir = path.join(settings.minecraftDirectory, row.instance_id, 'mods');
      const current = path.join(modsDir, row.file_name);
      const target = enabled ? current : path.join(modsDir, row.file_name + '.disabled');
      const source = enabled ? path.join(modsDir, row.file_name + '.disabled') : current;
      if (fs.existsSync(source)) {
        try { fs.renameSync(source, target); } catch { /* ignore */ }
      }
    }
    db.prepare('UPDATE mods SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return { ok: true };
  });

  // Updates every installed mod of an instance to its latest compatible
  // version (Modrinth or CurseForge, depending on where it came from).
  ipcMain.handle(IPC.MOD_UPDATE_ALL, async (_e, instanceId: string) => {
    const inst = db.prepare('SELECT loader, mc_version FROM instances WHERE id = ?').get(instanceId) as { loader: string; mc_version: string } | undefined;
    if (!inst) return { ok: false, error: 'Instance not found.' };
    if (inst.loader === 'vanilla') return { ok: false, error: 'Mods require a loader instance.' };

    const rows = db.prepare('SELECT * FROM mods WHERE instance_id = ? AND slug IS NOT NULL AND slug != \'\'').all(instanceId) as Record<string, unknown>[];
    const settings = settingsStore.load();
    const modsDir = path.join(settings.minecraftDirectory, instanceId, 'mods');

    let updated = 0;
    let upToDate = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const r of rows) {
      const mod = rowToMod(r);
      try {
        // Latest compatible version for this mod's source.
        let latest: { version_number: string; fileUrl: string; fileName: string } | null = null;

        if (mod.source === 'modrinth') {
          const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(mod.slug)}/version`);
          url.searchParams.set('game_versions', JSON.stringify([inst.mc_version]));
          url.searchParams.set('loaders', JSON.stringify([inst.loader]));
          const list = (await mrFetch(url.toString())) as Array<{
            version_number: string; files: Array<{ url: string; filename: string; primary: boolean }>;
          }>;
          const v = list?.[0];
          const file = v?.files.find((f) => f.primary) || v?.files[0];
          if (v && file) latest = { version_number: v.version_number, fileUrl: file.url, fileName: file.filename };
        } else {
          // CurseForge: resolve project by slug, then latest compatible file.
          const searchResp = (await cfFetch(`${CF_API}/v1/mods/search?gameId=${CF_MINECRAFT}&searchFilter=${encodeURIComponent(mod.slug)}&pageSize=5`)) as { data: Array<{ id: number; slug: string }> };
          const exact = searchResp.data?.find((m) => m.slug === mod.slug);
          const modId = exact?.id || searchResp.data?.[0]?.id;
          if (!modId) throw new Error('project not found');
          const filesResp = (await cfFetch(`${CF_API}/v1/mods/${modId}/files?gameId=${CF_MINECRAFT}&pageSize=50&gameVersion=${encodeURIComponent(inst.mc_version)}`)) as {
            data: Array<{ displayName: string; fileName: string; downloadUrl: string; gameVersions: string[]; releaseType: number }>;
          };
          const files = (filesResp.data || []).filter((f) => !!f.downloadUrl && f.gameVersions?.includes(inst.mc_version));
          const typeOrder: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3 };
          files.sort((a, b) => (typeOrder[a.releaseType] ?? 9) - (typeOrder[b.releaseType] ?? 9));
          const f = files[0];
          if (f) latest = { version_number: f.fileName, fileUrl: f.downloadUrl, fileName: f.fileName };
        }

        if (!latest) { failed++; errors.push(`${mod.name}: no compatible version found`); continue; }
        if (latest.version_number === mod.version || latest.fileName === mod.fileName) { upToDate++; continue; }

        // Download new jar first, then swap files and update the DB — a failed
        // download must never leave the old jar deleted.
        await new Promise<void>((resolve, reject) => {
          const client = latest.fileUrl.startsWith('https') ? https : http;
          const doReq = (reqUrl: string) => {
            const req = client.get(reqUrl, { headers: { 'User-Agent': 'SlimeLauncher/1.0.0' } }, (res) => {
              if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return doReq(res.headers.location);
              }
              if (res.statusCode && res.statusCode >= 400) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
              }
              const out = fs.createWriteStream(path.join(modsDir, latest.fileName));
              res.pipe(out);
              out.on('finish', () => out.close(() => resolve()));
              out.on('error', reject);
            });
            req.on('error', reject);
          };
          fs.mkdirSync(modsDir, { recursive: true });
          doReq(latest.fileUrl);
        });

        try { fs.unlinkSync(path.join(modsDir, mod.fileName)); } catch { /* already gone */ }
        try { fs.unlinkSync(path.join(modsDir, mod.fileName + '.disabled')); } catch { /* ignore */ }
        db.prepare('UPDATE mods SET version = ?, file_name = ?, installed_at = ? WHERE id = ?')
          .run(latest.version_number, latest.fileName, Date.now(), mod.id);
        updated++;
      } catch (e) {
        failed++;
        errors.push(`${mod.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    logger.info('Mod update-all finished', { instanceId, updated, upToDate, failed });
    return { ok: true, updated, upToDate, failed, errors };
  });

  ipcMain.handle(IPC.MOD_SCREENS, async (_e, projectId: string, source: 'curseforge' | 'modrinth') => {
    logger.info('Fetching mod screenshots', { projectId, source });
    try {
      if (source === 'modrinth') {
        const result = (await mrFetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`)) as Record<string, unknown>;
        logger.info('Modrinth project raw keys', { keys: Object.keys(result || {}).join(','), projectId });
        const gallery = (result?.gallery ?? result?.images ?? result?.screenshots ?? []) as unknown[];
        logger.info('Modrinth gallery field', { type: typeof result?.gallery, val: JSON.stringify(result?.gallery)?.slice(0, 300) });
        // Modrinth v2 returns objects ({url, title, description}), not strings —
        // the old string-only filter always produced an empty gallery.
        const screens = gallery
          .map((g) => {
            if (typeof g === 'string') return { url: g, caption: '' };
            if (g && typeof g === 'object' && typeof (g as { url?: unknown }).url === 'string') {
              const o = g as { url: string; title?: string; description?: string };
              return { url: o.url, caption: o.title || o.description || '' };
            }
            return null;
          })
          .filter((s): s is { url: string; caption: string } => s !== null);
        logger.info('Modrinth screenshots loaded', { count: screens.length, projectId });
        return screens;
      }
      // CurseForge — projectId is the numeric mod ID
      const result = (await cfFetch(`${CF_API}/v1/mods/${projectId}`)) as {
        data?: { screenshots?: Array<{ url: string; thumbnailUrl: string; caption?: string }> };
      };
      const screens = (result.data?.screenshots || []).map((s) => ({
        url: `cfimg://${encodeURIComponent(s.url)}`,
        caption: s.caption || '',
      }));
      logger.info('CurseForge screenshots loaded', { count: screens.length, projectId });
      return screens;
    } catch (e) {
      logger.error('Failed to fetch mod screenshots', { error: String(e), projectId, source });
      return [];
    }
  });
}