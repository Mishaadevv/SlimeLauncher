// Точная проверка authlib для MC 1.13–1.16: версия библиотеки берётся из
// version.json каждой версии, затем ищем minecraft.api.*.host / URL.
import https from 'node:https';

const UA = { 'User-Agent': 'SlimeLauncher/1.8.4' };
const MC_VERSIONS = ['1.13.2', '1.14.4', '1.15.2', '1.16.1', '1.16.5'];

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
  if (!url) { console.log(`== MC ${mc}: authlib ${ver}, нет URL загрузки`); continue; }
  try {
    const jar = await fetchBuf(url);
    const s = jar.toString('latin1');
    const props = [...new Set(s.match(/minecraft\.api\.[a-z]+/g) || [])];
    const hardcoded = s.includes('sessionserver.mojang.com');
    console.log(`== MC ${mc}: authlib ${ver} (${(jar.length / 1024).toFixed(0)} КБ) → свойства: ${props.length ? props.join(', ') : 'НЕТ'}, хардкод URL: ${hardcoded}`);
  } catch (e) {
    console.log(`== MC ${mc}: authlib ${ver} — ошибка загрузки (${String(e).slice(0, 70)})`);
  }
}
