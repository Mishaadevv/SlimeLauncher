// Печатает версию authlib для каждого заданного MC-релиза (из манифеста).
import https from 'node:https';

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

const want = new Set(process.argv.slice(2));
const manifest = JSON.parse((await fetchBuf('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).toString('utf8'));
for (const v of manifest.versions) {
  if (!want.has(v.id)) continue;
  try {
    const meta = JSON.parse((await fetchBuf(v.url)).toString('utf8'));
    const auth = (meta.libraries || []).find((l) => l.name.startsWith('com.mojang:authlib:'));
    console.log(`${v.id.padEnd(8)} authlib ${auth ? auth.name.split(':')[2] : '—'}`);
  } catch { console.log(`${v.id.padEnd(8)} (недоступен)`); }
}
