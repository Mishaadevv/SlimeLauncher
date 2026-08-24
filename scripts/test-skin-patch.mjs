// Проверка патча authlib: скачивает все поколения с хардкодом URL сессии и
// убеждается, что классы пропатчены, zip валиден, sessionserver не остался.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UA = { 'User-Agent': 'SlimeLauncher/1.8.6' };
const AUTH_VERSIONS = ['1.5.21', '1.5.25', '1.6.25', '2.1.28', '4.0.43', '7.0.61'];

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-patch-test-'));
execSync(`npx tsc electron/services/skin-patch.ts --outDir ${tmp} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck`, { stdio: 'pipe' });
const { patchAuthlibForLocalServer, listZipEntries } = await import(pathToFileURL(path.join(tmp, 'skin-patch.js')).href);

const host = 'http://127.0.0.1:54321';
let failed = false;

for (const v of AUTH_VERSIONS) {
  const jarPath = path.join(tmp, `authlib-${v}.jar`);
  try {
    fs.writeFileSync(jarPath, await fetchBuf(`https://libraries.minecraft.net/com/mojang/authlib/${v}/authlib-${v}.jar`));
  } catch (e) {
    console.log(`== authlib ${v}: скачать не удалось (${String(e).slice(0, 50)})`);
    continue;
  }
  const outJar = path.join(tmp, `authlib-${v}-skins.jar`);
  const ok = patchAuthlibForLocalServer(jarPath, outJar, host);
  console.log(`== authlib ${v}: патч = ${ok}`);

  let localCount = 0;
  let oldLeft = false;
  let allowLeft = false;
  let sessOk = true;
  const sessExpected = [];
  // Оригинальные sessionserver-константы (с путями) → ожидаемый локальный вид.
  const orig = fs.readFileSync(jarPath);
  for (const e of listZipEntries(orig)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    for (const c of utf8Constants(e.data)) {
      if (c.startsWith('https://sessionserver.mojang.com')) sessExpected.push(host + c.slice('https://sessionserver.mojang.com'.length));
    }
  }
  const outStrings = [];
  if (ok) {
    const zip = fs.readFileSync(outJar);
    for (const e of listZipEntries(zip)) {
      if (!e.data || !e.name.endsWith('.class')) continue;
      const s = e.data.toString('latin1');
      if (s.includes(host)) localCount++;
      if (s.includes('https://sessionserver.mojang.com')) oldLeft = true;
      // The allow-list lives in TextureUrlChecker (4.x–7.x), in
      // YggdrasilMinecraftSessionService (3.x) or as textures.minecraft.net
      // (9.x) — so compare exact constant-pool strings of every patched
      // class, not the class name. BLOCKED_DOMAINS (bugs.mojang.com, ...)
      // legitimately contain those substrings but as different constants.
      const strings = utf8Constants(e.data);
      if (strings.includes('.minecraft.net') || strings.includes('.mojang.com') || strings.includes('textures.minecraft.net')) allowLeft = true;
      outStrings.push(...strings);
    }
    for (const exp of sessExpected) {
      if (!outStrings.includes(exp)) sessOk = false;
    }
  }
  console.log(`   классов с локальным хостом: ${localCount} | sessionserver остался: ${oldLeft} | allow-list остался: ${allowLeft} | путь сохранён: ${sessOk}`);
  if (!ok || localCount === 0 || oldLeft || allowLeft || !sessOk) failed = true;
}

if (failed) { console.error('ПРОВЕРКА НЕ ПРОЙДЕНА'); process.exit(1); }
console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
fs.rmSync(tmp, { recursive: true, force: true });

// Extracts every CONSTANT_Utf8 string from a class file.
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