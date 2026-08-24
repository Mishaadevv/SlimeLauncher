// Полная проверка патча скинов: проходит по ВСЕМ релизам MC от 1.7.2 (первая
// версия с authlib) до самой новой (26.2), собирает каждый уникальный authlib,
// скачивает его, патчит и валидирует:
//   * zip результата валиден
//   * sessionserver.mojang.com полностью убран
//   * если в оригинале был allow-лист URL текстур (в любом классе: 3.x — в
//     YggdrasilMinecraftSessionService, 4.x–7.x — в TextureUrlChecker,
//     9.x — одиночная textures.minecraft.net), то в результате не осталось
//     ни одной allow-константы (они заменяются на пустую строку: authlib
//     проверяет host.endsWith(domain), а endsWith("") истинно для любого
//     хоста — так клиенты других машин принимают texture URL с LAN-IP
//     своего скин-сервера), а локальный хост присутствует.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

function verNum(id) {
  const m = id.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])];
}

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-all-test-'));
execSync(`npx tsc electron/services/skin-patch.ts --outDir ${tmp} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck`, { stdio: 'pipe' });
const { patchAuthlibForLocalServer, listZipEntries } = await import(pathToFileURL(path.join(tmp, 'skin-patch.js')).href);

const host = 'http://127.0.0.1:54321';
const hostOnly = '127.0.0.1';

const manifest = JSON.parse((await fetchBuf('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).toString('utf8'));

// Все релизы с authlib (>= 1.7.2).
const releases = manifest.versions
  .filter((v) => v.type === 'release')
  .map((v) => ({ id: v.id, n: verNum(v.id), url: v.url }))
  .filter((v) => v.n && v.n[0] >= 1 && (v.n[0] > 1 || v.n[1] > 7 || (v.n[1] === 7 && v.n[2] >= 2)));

let failed = false;
const checked = new Map(); // authlib version -> summary
const mcByAuth = new Map(); // authlib version -> first MC that uses it

for (const rel of releases) {
  let vj;
  try { vj = JSON.parse((await fetchBuf(rel.url)).toString('utf8')); }
  catch { continue; }
  const auth = (vj.libraries || []).find((l) => l.name.startsWith('com.mojang:authlib:'));
  if (!auth) continue;
  const ver = auth.name.split(':')[2];
  if (!mcByAuth.has(ver)) mcByAuth.set(ver, rel.id);
}

const authVersions = [...mcByAuth.keys()];
console.log(`Релизов с authlib: ${releases.length} | уникальных authlib: ${authVersions.length}`);
console.log('Покрытие:', [...mcByAuth.entries()].map(([a, mc]) => `${mc}→${a}`).join(', '), '\n');

for (const ver of authVersions) {
  const mc = mcByAuth.get(ver);
  const jarPath = path.join(tmp, `authlib-${ver}.jar`);
  try { fs.writeFileSync(jarPath, await fetchBuf(`https://libraries.minecraft.net/com/mojang/authlib/${ver}/authlib-${ver}.jar`)); }
  catch (e) { console.log(`== MC ${mc}: authlib ${ver}: СКАЧАТЬ НЕ УДАЛОСЬ (${String(e).slice(0, 50)})`); failed = true; continue; }

  // Какие allow-константы есть в оригинале? И какие sessionserver-URL с путями?
  const orig = fs.readFileSync(jarPath);
  let origAllow = false;
  const sessExpected = []; // host + остаток каждого оригинального sessionserver-константа
  for (const e of listZipEntries(orig)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    if ((s.includes('.minecraft.net') && s.includes('.mojang.com')) || s.includes('textures.minecraft.net')) origAllow = true;
    if (s.includes('https://sessionserver.mojang.com')) {
      for (const c of utf8Constants(e.data)) {
        if (c.startsWith('https://sessionserver.mojang.com')) sessExpected.push(host + c.slice('https://sessionserver.mojang.com'.length));
      }
    }
  }

  const outJar = path.join(tmp, `authlib-${ver}-skins.jar`);
  const ok = patchAuthlibForLocalServer(jarPath, outJar, host);

  let localCount = 0, oldSess = false, allowLeft = false, sessOk = true, fullCopy = false;
  const outStrings = [];
  if (ok) {
    const zip = fs.readFileSync(outJar);
    // Zip integrity: re-parsing the output must yield the same entry count
    // as the original (a valid zip round-trips through listZipEntries).
    const outEntries = listZipEntries(zip);
    // Must be a FULL copy of the original (same entries) so the classpath has
    // exactly one authlib jar — modern Forge (JPMS) rejects split packages.
    fullCopy = outEntries.filter((e) => e.data).length === listZipEntries(orig).filter((e) => e.data).length;
    for (const e of outEntries) {
      if (!e.data || !e.name.endsWith('.class')) continue;
      const s = e.data.toString('latin1');
      if (s.includes(host)) localCount++;
      if (s.includes('https://sessionserver.mojang.com')) oldSess = true;
      if (origAllow) {
        const strings = utf8Constants(e.data);
        if (strings.includes('.minecraft.net') || strings.includes('.mojang.com') || strings.includes('textures.minecraft.net')) allowLeft = true;
      }
      outStrings.push(...utf8Constants(e.data));
    }
    // Каждый sessionserver-URL должен превратиться в локальный хост С ТЕМ ЖЕ
    // ПУТЁМ (префикс-патч не должен выбрасывать /session/minecraft/...).
    for (const exp of sessExpected) {
      if (!outStrings.includes(exp)) sessOk = false;
    }
  }

  const status = ok && localCount > 0 && !oldSess && !allowLeft && sessOk && fullCopy ? 'OK' : 'FAIL';
  if (status === 'FAIL') failed = true;
  console.log(`== MC ${mc}: authlib ${ver} | ${status} | allow-list:${origAllow ? 'был' : '—'} | патч:${ok} | локальных:${localCount} | sessionserver остался:${oldSess} | allow остался:${allowLeft} | путь сохранён:${sessOk} | полная копия:${fullCopy}`);
  checked.set(ver, status);
}

const failList = [...checked.entries()].filter(([, s]) => s === 'FAIL');
if (failList.length) {
  console.error(`ПРОВЕРКА НЕ ПРОЙДЕНА (${failList.length}):`, failList.map(([v]) => v).join(', '));
  process.exit(1);
}
console.log(`\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (${checked.size} поколений authlib)`);
fs.rmSync(tmp, { recursive: true, force: true });
