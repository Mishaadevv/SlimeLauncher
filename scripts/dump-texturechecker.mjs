// Ищет, в каком классе и как именно authlib проверяет URL текстур: для
// поколений, где TextureUrlChecker не найден патчем (9.x), и для промежуточных
// версий 1.19.x.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const UA = { 'User-Agent': 'SlimeLauncher/1.8.6' };
function fetchBuf(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: UA }, (r) => {
      if (r.statusCode >= 400) { r.resume(); return rej(new Error(`HTTP ${r.statusCode}`)); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authlib-dump-'));
execSync(`npx tsc electron/services/skin-patch.ts --outDir ${tmp} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck`, { stdio: 'pipe' });
const { listZipEntries } = await import(pathToFileURL(path.join(tmp, 'skin-patch.js')).href);

function utf8Constants(cls) {
  const out = [];
  let pos = 8;
  const poolCount = cls.readUInt16BE(pos); pos += 2;
  let i = 1;
  while (i < poolCount) {
    const tag = cls[pos];
    if (tag === 1) {
      const len = cls.readUInt16BE(pos + 1);
      out.push(cls.toString('latin1', pos + 3, pos + 3 + len));
      pos += 3 + len; i++;
    } else {
      switch (tag) {
        case 3: case 4: pos += 5; i++; break;
        case 5: case 6: pos += 9; i += 2; break;
        case 7: case 8: case 16: case 19: case 20: pos += 3; i++; break;
        case 9: case 10: case 11: case 12: case 17: case 18: pos += 5; i++; break;
        case 15: pos += 4; i++; break;
        default: throw new Error(`unknown tag ${tag}`);
      }
    }
  }
  return out;
}

const versions = process.argv.slice(2); // e.g. 9.0.75 3.18.38 3.19.40
for (const v of versions) {
  const jar = path.join(tmp, `authlib-${v}.jar`);
  try { fs.writeFileSync(jar, await fetchBuf(`https://libraries.minecraft.net/com/mojang/authlib/${v}/authlib-${v}.jar`)); }
  catch (e) { console.log(`== authlib ${v}: скачать не удалось: ${String(e).slice(0, 60)}`); continue; }
  const zip = fs.readFileSync(jar);
  const hits = [];
  for (const e of listZipEntries(zip)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    if (s.includes('minecraft.net') || s.includes('Textures payload url is invalid') || s.includes('texture url')) {
      const strings = utf8Constants(e.data);
      const interesting = strings.filter((x) =>
        x.includes('minecraft.net') || x.includes('mojang.com') || x.includes('127.0.0.1') ||
        x.includes('isAllowedTextureDomain') || x.includes('Textures payload') || x.includes('http') ||
        x.includes('https') || x.includes('payload') || x.includes('texture'));
      hits.push({ cls: e.name, interesting });
    }
  }
  console.log(`\n== authlib ${v}: классов с интересными строками: ${hits.length}`);
  for (const h of hits) {
    console.log(`  ${h.cls}`);
    for (const s of h.interesting.slice(0, 25)) console.log(`      "${s}"`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
