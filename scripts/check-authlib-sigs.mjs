import https from 'node:https';
import zlib from 'node:zlib';

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

function fetchBuf(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'test' } }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

for (const ver of ['1.5.25', '2.1.28', '3.16.29', '6.0.55']) {
  const jar = await fetchBuf('https://libraries.minecraft.net/com/mojang/authlib/' + ver + '/authlib-' + ver + '.jar');
  console.log('=== AUTHLIB ' + ver);
  for (const e of walkZip(jar)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    if (s.includes('withRSA') || s.includes('Signature') || s.includes('yggdrasil_session_pubkey')) {
      const sigs = s.match(/[A-Za-z0-9]+withRSA/g);
      if (sigs) console.log('  ', e.name, sigs);
    }
  }
}
