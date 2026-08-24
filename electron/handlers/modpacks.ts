import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, execSync } from 'node:child_process';
import https from 'node:https';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';
import { notify } from './types.js';
import type { LoaderType } from '../../shared/types.js';

const CF_API = 'https://api.curseforge.com';
const CF_KEY = '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEjQnPnm';

function cfFetch(url: string, method = 'GET', body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        'x-api-key': CF_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'SlimeLauncher/1.0.0',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`CurseForge API error: HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      try {
        execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { windowsHide: true, timeout: 60000 });
        resolve();
      } catch {
        // Fallback to powershell if tar fails
        execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`], { windowsHide: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }
    } else {
      execFile('unzip', ['-o', zipPath, '-d', destDir], (err) => {
        if (err) reject(err);
        else resolve();
      });
    }
  });
}

// Searches for a file by name recursively in a directory tree.
// Some modpack zips wrap everything in a top-level folder, so the
// manifest ends up at e.g. tmpDir/SomeModpackName/manifest.json.
function findFileRecursive(dir: string, fileName: string): string | null {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) return full;
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, fileName);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function registerModpackHandlers(deps: HandlerDeps) {
  const { db, settingsStore, downloadManager, logger } = deps;

  ipcMain.handle(IPC.MODPACK_INSTALL, async (_e, data: {
    source: 'curseforge' | 'modrinth';
    name: string;
    fileUrl: string;
  }) => {
    logger.info('Starting modpack install', data);
    notify(deps, { type: 'info', title: 'Installing Modpack', message: `Downloading ${data.name}...`, duration: 4000 });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slime-modpack-'));
    const zipPath = path.join(tmpDir, 'modpack.zip');

    try {
      // 1. Download zip
      await downloadFile(data.fileUrl, zipPath);
      notify(deps, { type: 'info', title: 'Installing Modpack', message: `Extracting ${data.name}...`, duration: 4000 });

      // 2. Extract zip
      await extractZip(zipPath, tmpDir);

      const settings = settingsStore.load();
      const instId = randomUUID();
      const instDir = path.join(settings.minecraftDirectory, instId);
      
      let mcVersion = '1.20.1';
      let loader: LoaderType = 'vanilla';
      let loaderVersion: string | null = null;
      let overridesDir = '';
      
      const filesToDownload: { url: string; dest: string; name: string; slug: string; author: string }[] = [];

      // 3. Parse manifest
      // Some zips wrap everything in a top-level folder, so search recursively.
      if (data.source === 'modrinth') {
        const idxPath = findFileRecursive(tmpDir, 'modrinth.index.json') || path.join(tmpDir, 'modrinth.index.json');
        if (!fs.existsSync(idxPath)) throw new Error('modrinth.index.json not found in the modpack archive. Make sure this is a valid Modrinth modpack zip.');
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        
        mcVersion = idx.dependencies?.minecraft || '1.20.1';
        if (idx.dependencies?.fabricLoader || idx.dependencies?.['fabric-loader']) {
          loader = 'fabric';
          loaderVersion = idx.dependencies.fabricLoader || idx.dependencies['fabric-loader'];
        } else if (idx.dependencies?.forge) {
          loader = 'forge';
          loaderVersion = idx.dependencies.forge;
        } else if (idx.dependencies?.neoforge) {
          loader = 'neoforge';
          loaderVersion = idx.dependencies.neoforge;
        } else if (idx.dependencies?.quiltLoader || idx.dependencies?.['quilt-loader']) {
          loader = 'quilt';
          loaderVersion = idx.dependencies.quiltLoader || idx.dependencies['quilt-loader'];
        }
        
        // overrides might be inside the found index's directory or at the top level
        const idxDir = path.dirname(idxPath);
        const overridesCandidate = path.join(idxDir, 'overrides');
        overridesDir = fs.existsSync(overridesCandidate) ? overridesCandidate : path.join(tmpDir, 'overrides');
        
        for (const file of idx.files || []) {
          if (!file.downloads || !file.downloads[0]) continue;
          const relPath = file.path; // e.g. "mods/sodium.jar"
          filesToDownload.push({
            url: file.downloads[0],
            dest: path.join(instDir, relPath),
            name: path.basename(relPath),
            slug: path.basename(relPath, '.jar'),
            author: 'Modrinth',
          });
        }
      } else {
        // CurseForge
        const manifestPath = findFileRecursive(tmpDir, 'manifest.json') || path.join(tmpDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found in the modpack archive. Make sure this is a valid CurseForge modpack zip.');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        
        mcVersion = manifest.minecraft?.version || '1.20.1';
        const primaryLoader = manifest.minecraft?.modLoaders?.find((l: any) => l.primary) || manifest.minecraft?.modLoaders?.[0];
        if (primaryLoader) {
          const lId = primaryLoader.id;
          if (lId.startsWith('fabric')) { loader = 'fabric'; loaderVersion = lId.split('-')[1]; }
          else if (lId.startsWith('forge')) { loader = 'forge'; loaderVersion = lId.split('-')[1]; }
          else if (lId.startsWith('neoforge')) { loader = 'neoforge'; loaderVersion = lId.split('-')[1]; }
          else if (lId.startsWith('quilt')) { loader = 'quilt'; loaderVersion = lId.split('-')[1]; }
        }
        
        const overridesCandidate = path.join(path.dirname(manifestPath), manifest.overrides || 'overrides');
        overridesDir = fs.existsSync(overridesCandidate) ? overridesCandidate : path.join(tmpDir, manifest.overrides || 'overrides');
        
        // Fetch URLs for all file IDs
        const fileIds = (manifest.files || []).map((f: any) => f.fileID);
        if (fileIds.length > 0) {
          notify(deps, { type: 'info', title: 'Installing Modpack', message: `Resolving ${fileIds.length} mods...`, duration: 4000 });
          // Fetch in batches of 50
          for (let i = 0; i < fileIds.length; i += 50) {
            const batch = fileIds.slice(i, i + 50);
            const resp = await cfFetch(`${CF_API}/v1/mods/files`, 'POST', { fileIds: batch }) as { data: any[] };
            let skippedCount = 0;
            for (const f of resp.data || []) {
              if (f.downloadUrl) {
                // CF puts mods in "mods/" by default
                filesToDownload.push({
                  url: f.downloadUrl,
                  dest: path.join(instDir, 'mods', f.fileName),
                  name: f.displayName || f.fileName,
                  slug: f.fileName.replace('.jar', ''),
                  author: 'CurseForge',
                });
              } else {
                skippedCount++;
              }
            }
            if (skippedCount > 0) {
              logger.warn('Some CurseForge mods have no download URL (author disabled third-party distribution)', { skipped: skippedCount });
            }
          }
        }
      }

      // 4. Create Instance
      fs.mkdirSync(instDir, { recursive: true });
      for (const sub of ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots']) {
        fs.mkdirSync(path.join(instDir, sub), { recursive: true });
      }
      
      db.prepare(
        `INSERT INTO instances (id, name, icon, mc_version, loader, loader_version, java_path, ram_mb, jvm_args, created_at, last_played_at, play_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
      ).run(instId, data.name, null, mcVersion, loader, loaderVersion, settings.defaultJavaPath || null, settings.defaultRamMB, settings.jvmArguments, Date.now());

      // 5. Copy Overrides
      if (fs.existsSync(overridesDir)) {
        notify(deps, { type: 'info', title: 'Installing Modpack', message: `Applying overrides...`, duration: 4000 });
        const copyRecursive = (src: string, dest: string) => {
          if (!fs.existsSync(src)) return;
          const stat = fs.statSync(src);
          if (stat.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            for (const child of fs.readdirSync(src)) {
              copyRecursive(path.join(src, child), path.join(dest, child));
            }
          } else {
            fs.copyFileSync(src, dest);
          }
        };
        copyRecursive(overridesDir, instDir);
      }

      // 6. Enqueue Downloads & DB entries
      if (filesToDownload.length > 0) {
        notify(deps, { type: 'info', title: 'Installing Modpack', message: `Downloading ${filesToDownload.length} mods...`, duration: 4000 });
        for (const file of filesToDownload) {
          downloadManager.enqueue(file.name, file.url, file.dest, 'mod');
          
          const modId = randomUUID();
          db.prepare(
            'INSERT INTO mods (id, instance_id, slug, name, author, version, file_name, enabled, installed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
          ).run(modId, instId, file.slug, file.name, file.author, '1.0', path.basename(file.dest), Date.now(), data.source);
        }
      }

      const dlMsg = filesToDownload.length > 0
        ? `${filesToDownload.length} mods queued for download.`
        : 'Overrides applied. (Some mods could not be downloaded — CurseForge may have restricted their distribution.)';
      notify(deps, { type: 'success', title: 'Modpack Ready', message: `${data.name} has been added to your Instances! ${dlMsg}`, duration: 8000 });
      return { ok: true, instanceId: instId };

    } catch (e) {
      logger.error('Modpack install failed', { error: String(e) });
      return { ok: false, error: String(e) };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}