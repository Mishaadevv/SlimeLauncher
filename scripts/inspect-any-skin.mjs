// Поиск URL-констант скинов в любом старом клиент-джар.
// Использование: node scripts/inspect-any-skin.mjs <jar-путь>
import fs from 'node:fs';
import zlib from 'node:zlib';

const jarPath = process.argv[2];
if (!jarPath) { console.error('укажи путь к jar'); process.exit(1); }
const zip = fs.readFileSync(jarPath);

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

const patterns = ['MinecraftSkins', 'MinecraftCloaks', 'skins.minecraft', 's3.amazonaws', 'minecraft.net', 'amazonaws'];
for (const e of walkZip(zip)) {
  if (!e.data || !e.name.endsWith('.class')) continue;
  const s = e.data.toString('latin1');
  const found = patterns.filter((p) => s.includes(p));
  if (!found.length) continue;
  const urls = [...new Set(s.match(/https?:\/\/[A-Za-z0-9./_$%?=&-]+/g) || [])]
    .filter((u) => urlsFilter(u));
  console.log(`--- ${e.name} [${found.join(',')}]`);
  for (const u of urls) console.log('   ', u);
}

function urlsFilter(u) {
  return /amazonaws|minecraft\.net/i.test(u);
}
