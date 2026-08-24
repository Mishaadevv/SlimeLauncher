// Deep-inspects client jars for the texture validation: finds SkinManager /
// PlayerSkin classes, checks them for the error string and trusted-host
// constants, and greps raw jar bytes too.
import fs from 'node:fs';
import path from 'node:path';
import { listZipEntries } from '../dist-electron/electron/services/skin-patch.js';

const jars = process.argv.slice(2);
const NEEDLES = ['Textures payload url is invalid', 'textures.minecraft.net'];

for (const jarPath of jars) {
  const zip = fs.readFileSync(jarPath);
  console.log('=== Jar:', path.basename(jarPath), `(${zip.length} bytes)`);

  // raw (compressed) grep — cheap sanity check the string exists at all
  for (const n of NEEDLES) {
    console.log('  raw bytes contains', JSON.stringify(n), ':', zip.includes(Buffer.from(n, 'latin1')));
  }

  let classes = 0;
  const hits = [];
  for (const e of listZipEntries(zip)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    classes++;
    const s = e.data.toString('latin1');
    for (const n of NEEDLES) {
      if (s.includes(n)) hits.push(`${e.name} :: ${n}`);
    }
    if (e.name.includes('PlayerSkin') || e.name.includes('SkinManager')) {
      console.log(`  [class] ${e.name} (${e.data.length} bytes)`);
    }
  }
  console.log(`  classes scanned: ${classes}, hits: ${hits.length}`);
  for (const h of hits.slice(0, 20)) console.log('  HIT', h);
}
console.log('--- done ---');
