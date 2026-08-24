// Скачивает клиенты старых версий (1.0–1.6.4) и ищет, в каких классах
// зашит URL скинов (s3.amazonaws.com/MinecraftSkins) и session.minecraft.net.
// Нужно, чтобы точно знать, какие классы патчить для оффлайн-скинов.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';

const UA = { 'User-Agent': 'SlimeLauncher/1.7.4' };
const VERSIONS = ['1.6.4', '1.5.2', '1.4.7', '1.2.5', '1.0'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-legacy-skins-'));

function fetchJson(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: UA }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function fetchBuf(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: UA }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

// Перебор всех записей zip/jar с распаковкой
function walkZip(zip) {
  const out = [];
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const n = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    const method = zip.readUInt16LE(pos + 10);
    const compSize = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLen);
    const lnameLen = zip.readUInt16LE(localOffset + 26);
    const lextraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lnameLen + lextraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    let data = null;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
    } catch { data = null; }
    out.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
const byId = new Map(manifest.versions.map((v) => [v.id, v.url]));

for (const v of VERSIONS) {
  const metaUrl = byId.get(v);
  if (!metaUrl) { console.log(`== ${v}: нет в манифесте`); continue; }
  const meta = await fetchJson(metaUrl);
  const clientUrl = meta.downloads?.client?.url;
  if (!clientUrl) { console.log(`== ${v}: нет client URL`); continue; }
  const jar = await fetchBuf(clientUrl);
  const jarPath = path.join(dir, `${v}.jar`);
  fs.writeFileSync(jarPath, jar);
  console.log(`== ${v} (${jar.length} байт)`);
  const hits = [];
  for (const e of walkZip(jar)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    const hasS3 = s.includes('s3.amazonaws.com/MinecraftSkins');
    const hasSession = s.includes('session.minecraft.net');
    if (hasS3 || hasSession) {
      hits.push(`${e.name}  s3=${hasS3} session=${hasSession}`);
      if (hasS3) {
        const m = s.match(/https?:\/\/[A-Za-z0-9./_$-]+/g) || [];
        hits.push(`    URLs: ${[...new Set(m)].filter((u) => u.includes('s3') || u.includes('session')).join(' | ')}`);
      }
    }
  }
  console.log(hits.join('\n') || '    (констант скинов не найдено)');
}
console.log('temp:', dir);
