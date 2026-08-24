// Финальная проверка: authlib для 1.16.2, 1.17.1, 1.18.2, 1.19 — читает ли
// свойства minecraft.api.* (разжатые байты) и где лежит sessionserver URL.
import https from 'node:https';
import zlib from 'node:zlib';

const UA = { 'User-Agent': 'SlimeLauncher/1.8.4' };
const MC_VERSIONS = ['1.16.2', '1.17.1', '1.18.2', '1.19', '1.21.11', '26.2'];

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
      if (r.statusCode >= 400) { r.resume(); return rej(new Error(`HTTP ${r.statusCode}`)); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}
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

for (const mc of MC_VERSIONS) {
  const metaUrl = byId.get(mc);
  if (!metaUrl) { console.log(`== MC ${mc}: нет в манифесте`); continue; }
  const meta = await fetchJson(metaUrl);
  const authlib = (meta.libraries || []).find((l) => l.name.startsWith('com.mojang:authlib:'));
  if (!authlib) { console.log(`== MC ${mc}: authlib не указан`); continue; }
  const ver = authlib.name.split(':')[2];
  const url = authlib.downloads?.artifact?.url;
  if (!url) { console.log(`== MC ${mc}: authlib ${ver}, нет URL`); continue; }
  try {
    const jar = await fetchBuf(url);
    const classes = walkZip(jar);
    const props = new Set();
    const hardcodeClasses = [];
    for (const e of classes) {
      if (!e.data) continue;
      const s = e.data.toString('latin1');
      for (const m of s.match(/minecraft\.api\.[a-z]+/g) || []) props.add(m);
      if (s.includes('https://sessionserver.mojang.com')) hardcodeClasses.push(e.name.replace('com/mojang/authlib/', ''));
    }
    console.log(`== MC ${mc}: authlib ${ver} → свойства: ${props.size ? [...props].join(',') : 'НЕТ'} | хардкод URL в: ${hardcodeClasses.join(', ') || '—'}`);
  } catch (e) {
    console.log(`== MC ${mc}: authlib ${ver} — ошибка (${String(e).slice(0, 60)})`);
  }
}
