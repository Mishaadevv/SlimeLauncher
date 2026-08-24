// Проверка патча клиент-джар для 1.0–1.6.4: в каждом классе с URL скинов
// s3/skins.minecraft.net должен появиться локальный хост.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const srcDir = process.argv[2];
if (!srcDir) { console.error('укажи temp-папку с jar (из inspect-legacy-skins)'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-client-patch-'));
execSync(`npx tsc electron/services/skin-patch.ts --outDir ${tmp} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck`, { stdio: 'pipe' });
const { patchClientJarForLegacySkins, readZipEntry, listZipEntries } = await import(pathToFileURL(path.join(tmp, 'skin-patch.js')).href);

const host = 'http://127.0.0.1:54321';
let failed = false;
for (const v of ['1.6.4', '1.5.2', '1.4.7', '1.2.5', '1.0']) {
  const jar = path.join(srcDir, `${v}.jar`);
  if (!fs.existsSync(jar)) { console.log(`${v}: jar нет — пропуск`); continue; }
  const outJar = path.join(tmp, `${v}-skins.jar`);
  const ok = patchClientJarForLegacySkins(jar, outJar, host);
  console.log(`== ${v}: патч = ${ok}`);

  // валидность zip
  execSync(`unzip -t ${JSON.stringify(outJar)}`, { stdio: 'pipe' });
  console.log('   zip валиден');

  const zip = fs.readFileSync(outJar);
  const entries = listZipEntries(zip);
  let patchedCount = 0;
  let stillOld = false;
  for (const e of entries) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    if (s.includes('s3.amazonaws.com/MinecraftSkins') || s.includes('skins.minecraft.net/MinecraftSkins') ||
        s.includes('s3.amazonaws.com/MinecraftCloaks') || s.includes('skins.minecraft.net/MinecraftCloaks')) {
      stillOld = true;
    }
    if (s.includes(host)) patchedCount++;
  }
  console.log(`   классов с локальным хостом: ${patchedCount} | старых URL осталось: ${stillOld}`);
  if (!ok || patchedCount === 0 || stillOld) failed = true;
}
if (failed) { console.error('ПРОВЕРКА НЕ ПРОЙДЕНА'); process.exit(1); }
console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
fs.rmSync(tmp, { recursive: true, force: true });
