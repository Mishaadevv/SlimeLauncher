// Глубокий разбор 1.6.4: как строится URL скина и что именно уходит
// на session.minecraft.net.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2];
if (!dir) { console.error('укажи temp-папку с jar'); process.exit(1); }

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

const jarPath = path.join(dir, '1.6.4.jar');
const zip = fs.readFileSync(jarPath);
console.log('=== 1.6.4: все классы, где есть "MinecraftSkins" или "session.minecraft.net" ===');
for (const e of walkZip(zip)) {
  if (!e.data || !e.name.endsWith('.class')) continue;
  const s = e.data.toString('latin1');
  if (s.includes('MinecraftSkins') || s.includes('session.minecraft.net') || s.includes('skins.minecraft')) {
    const urls = [...new Set(s.match(/https?:\/\/[A-Za-z0-9./_$%-]+/g) || [])];
    const skinish = s.match(/[A-Za-z0-9./_-]{0,40}MinecraftSkins[A-Za-z0-9./_-]{0,40}/g) || [];
    console.log(`--- ${e.name}`);
    console.log('   URLs:', urls.filter((u) => u.includes('minecraft') || u.includes('amazon')).join(' | '));
    console.log('   MinecraftSkins ctx:', [...new Set(skinish)].slice(0, 5).join('  ||  '));
  }
}
