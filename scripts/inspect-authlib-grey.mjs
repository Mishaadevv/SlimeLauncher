// Ищем, где именно в authlib 1.5.25 / 1.6.25 / 2.1.28 (MC 1.13–1.16) лежит
// URL сессии — в каком классе и в каком виде.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const UA = { 'User-Agent': 'SlimeLauncher/1.8.4' };
const LIBS = {
  '1.5.25': 'https://libraries.minecraft.net/com/mojang/authlib/1.5.25/authlib-1.5.25.jar',
  '1.6.25': 'https://libraries.minecraft.net/com/mojang/authlib/1.6.25/authlib-1.6.25.jar',
  '2.1.28': 'https://libraries.minecraft.net/com/mojang/authlib/2.1.28/authlib-2.1.28.jar',
};

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

for (const [ver, url] of Object.entries(LIBS)) {
  try {
    const jar = await fetchBuf(url);
    console.log(`==== authlib ${ver}`);
    for (const e of walkZip(jar)) {
      if (!e.data || !e.name.endsWith('.class')) continue;
      const s = e.data.toString('latin1');
      if (!s.includes('mojang.com') && !s.includes('minecraft') && !s.includes('amazonaws')) continue;
      const urls = [...new Set(s.match(/https?:\/\/[A-Za-z0-9./_$-]+/g) || [])].filter((u) => /mojang|minecraft|amazonaws/.test(u));
      const hostish = [...new Set(s.match(/[A-Za-z0-9.-]*sessionserver[A-Za-z0-9.-]*/g) || [])];
      if (urls.length || hostish.length) {
        console.log(`--- ${e.name}`);
        for (const u of urls) console.log('   URL:', u);
        for (const h of hostish) console.log('   host:', h);
      }
    }
  } catch (e) {
    console.log(`==== authlib ${ver}: ошибка (${String(e).slice(0, 60)})`);
  }
}
