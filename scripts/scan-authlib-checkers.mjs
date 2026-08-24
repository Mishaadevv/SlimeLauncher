// Scans every authlib jar under the launcher data folder and reports which
// versions contain the texture-URL domain check (TextureUrlChecker) that
// rejects non-Mojang hosts.
import fs from 'node:fs';
import path from 'node:path';
import { listZipEntries } from '../dist-electron/electron/services/skin-patch.js';

const root = process.argv[2] || 'C:/Users/Misha Krutoj/.slimelauncher/minecraft';

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/authlib-.*\.jar$/.test(e.name)) out.push(p);
  }
  return out;
}

for (const j of walk(root)) {
  let zip;
  try { zip = fs.readFileSync(j); } catch { continue; }
  let checker = false, errMsg = false, domains = false, sessionserver = false;
  for (const e of listZipEntries(zip)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    if (e.name.includes('TextureUrlChecker')) checker = true;
    if (s.includes('Textures payload url is invalid')) errMsg = true;
    if (s.includes('.minecraft.net')) domains = true;
    if (s.includes('https://sessionserver.mojang.com')) sessionserver = true;
  }
  const ver = j.split(path.sep).slice(-2).join('/');
  console.log(`${ver.padEnd(30)} checker:${checker ? 'Y' : 'n'} errMsg:${errMsg ? 'Y' : 'n'} .minecraft.net:${domains ? 'Y' : 'n'} sesserver:${sessionserver ? 'Y' : 'n'}`);
}
