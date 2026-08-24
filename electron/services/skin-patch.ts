import fs from 'node:fs';
import zlib from 'node:zlib';

// Offline-skins "mod" for old Minecraft versions.
//
// Minecraft 1.7.2–1.12.2 ship authlib 1.5.x, which hardcodes the session
// server URL (`https://sessionserver.mojang.com/...`) inside
// `YggdrasilMinecraftSessionService` and IGNORES the `minecraft.api.*.host`
// system properties that newer authlib versions honour. That means the game
// never talks to the launcher's local skin server, so offline skins can't be
// shown. Newer versions (1.13+) read the properties and work already.
//
// This module patches a COPY of that single class — swapping the hardcoded
// host for the launcher's local skin server (a plain-string constant-pool
// rewrite, safe because the replacement is shorter and pool entries are
// referenced by index, not byte offset) — and packs it into a tiny jar. The
// launcher prepends that jar to the game's classpath, so the patched class
// wins and every profile/skin request goes through the local server. This is
// effectively a per-version mod injected at launch.

// Matches any authlib jar on the classpath.
const AUTH_PATTERN = /authlib-[0-9].*\.jar$/;

// Pre-1.7 clients fetch skins directly from these hardcoded hosts by name
// (e.g. http://skins.minecraft.net/MinecraftSkins/<name>.png). The launcher
// rewrites them to the local skin server, which serves skins by name.
function legacySkinPatchPairs(host: string): Array<[string, string]> {
  return [
    ['http://s3.amazonaws.com/MinecraftSkins', `${host}/MinecraftSkins`],
    ['http://s3.amazonaws.com/MinecraftCloaks', `${host}/MinecraftCloaks`],
    ['http://skins.minecraft.net/MinecraftSkins', `${host}/MinecraftSkins`],
    ['http://skins.minecraft.net/MinecraftCloaks', `${host}/MinecraftCloaks`],
  ];
}

function containsSkinUrl(data: Buffer): boolean {
  const s = data.toString('latin1');
  return s.includes('MinecraftSkins') || s.includes('MinecraftCloaks');
}

// --- Minimal zip reader / writer (jars are zips) ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Lists all entries of a zip/jar (name + decompressed data). Supports stored
// (0) and deflate (8) entries; skips extra fields and comment data.
export function listZipEntries(zip: Buffer): Array<{ name: string; data: Buffer | null }> {
  const out: Array<{ name: string; data: Buffer | null }> = [];
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const cdEntries = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  for (let n = 0; n < cdEntries; n++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) return out;
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
    let data: Buffer | null = null;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
    } catch {
      data = null;
    }
    out.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Extracts a single entry from a zip/jar buffer.
export function readZipEntry(zip: Buffer, entryName: string): Buffer | null {
  return listZipEntries(zip).find((e) => e.name === entryName)?.data ?? null;
}

function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed to extract
    local.writeUInt16LE(0x0800, 6);  // flags: UTF-8 names
    local.writeUInt16LE(8, 8);       // method: deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);      // extra len
    chunks.push(local, name, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);        // version made by
    cen.writeUInt16LE(20, 6);        // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);        // method
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);        // extra len
    cen.writeUInt16LE(0, 32);        // comment len
    cen.writeUInt16LE(0, 34);        // disk start
    cen.writeUInt32LE(0, 38);        // external attrs
    cen.writeUInt32LE(offset, 42);   // local header offset
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);         // comment len
  return Buffer.concat([...chunks, cd, eocd]);
}

// --- Class-file constant pool patcher ---

// Replaces every CONSTANT_Utf8 entry whose text starts with any of the `from`
// prefixes by rewriting that prefix to the matching `to`, KEEPING whatever
// followed the prefix (e.g. authlib 1.5.x stores the whole session URL as
// "https://sessionserver.mojang.com/session/minecraft/" — dropping the path
// would produce an invalid URL and silently break profile fetches). The pool
// is walked length-prefixed, so shrinking an entry only shifts bytes after it
// — constant pool references are by index, never by byte offset, so the rest
// of the class stays valid. Every `to` MUST be shorter than or equal to its
// `from` (the result is then never longer than the original entry).
export function patchClassConstantPoolPrefixes(
  classBytes: Buffer,
  replacements: Array<[string, string]>,
): Buffer {
  if (classBytes.length < 10 || classBytes.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error('Not a valid class file');
  }
  let buf = Buffer.from(classBytes);
  let pos = 8;
  const poolCount = buf.readUInt16BE(pos);
  pos += 2;
  let i = 1;
  while (i < poolCount) {
    const tag = buf[pos];
    if (tag === 1) { // CONSTANT_Utf8
      const len = buf.readUInt16BE(pos + 1);
      const start = pos + 3;
      const str = buf.toString('latin1', start, start + len);
      const hit = replacements.find(([from]) => str.startsWith(from));
      if (hit) {
        const rest = str.slice(hit[0].length);
        const toBuf = Buffer.from(hit[1] + rest, 'latin1');
        const newEntry = Buffer.alloc(3 + toBuf.length);
        newEntry.writeUInt8(1, 0);
        newEntry.writeUInt16BE(toBuf.length, 1);
        toBuf.copy(newEntry, 3);
        buf = Buffer.concat([buf.subarray(0, pos), newEntry, buf.subarray(start + len)]);
        pos += newEntry.length;
      } else {
        pos += 3 + len;
      }
      i += 1;
      continue;
    }
    switch (tag) {
      case 3: case 4: pos += 5; i += 1; break;                        // Integer, Float
      case 5: case 6: pos += 9; i += 2; break;                        // Long, Double (take 2 slots)
      case 7: case 8: case 16: case 19: case 20: pos += 3; i += 1; break; // Class, String, MethodType, Module, Package
      case 9: case 10: case 11: case 12: case 17: case 18: pos += 5; i += 1; break; // refs, NameAndType, Dynamic, InvokeDynamic
      case 15: pos += 4; i += 1; break;                               // MethodHandle
      default: throw new Error(`Unknown constant pool tag ${tag} at index ${i}`);
    }
  }
  return buf;
}

export function patchClassConstantPoolPrefix(classBytes: Buffer, from: string, to: string): Buffer {
  return patchClassConstantPoolPrefixes(classBytes, [[from, to]]);
}

// Builds the offline-skins jar for one instance: scans the authlib jar and
// patches EVERY class that hardcodes the production session server URL. This
// covers all hardcoded-URL generations:
//   * authlib 1.5.x (MC 1.7–1.15)  → YggdrasilMinecraftSessionService
//   * authlib 1.6.x/2.x/3.x (1.16+) → YggdrasilEnvironment
// Authlib versions that read the minecraft.api.*.host properties (1.16.2+)
// already work through the launch arguments, so the patched constants are
// simply never used there — the patch is a no-op fallback. Returns true when
// at least one class was changed.
// Where the texture-URL allow-list lives varies by authlib generation:
//   * 1.5.x (MC 1.7–1.15): no URL validation at all
//   * 3.x (MC 1.16–1.19.3): inline in YggdrasilMinecraftSessionService
//     as {".minecraft.net", ".mojang.com"}
//   * 4.x–7.x (MC 1.20–1.21): dedicated TextureUrlChecker class with the
//     same two constants
//   * 9.x (MC 26.2): TextureUrlChecker with a single "textures.minecraft.net"
// Instead of keying on class names, we scan EVERY class for the allow-list
// constants and rewrite them to an EMPTY string. authlib checks a texture
// URL's host with `host.endsWith(domain)`, so an empty domain accepts every
// host — required because texture URLs advertise this machine's LAN IP (not
// 127.0.0.1), and clients on OTHER machines must accept URLs served by their
// own skin servers. A fixed localhost allow-list stripped every remote
// texture ("Textures payload url is invalid: http://<peerIp>:<port>/...").
// Blocked domains (bugs.mojang.com, education.minecraft.net,
// feedback.minecraft.net) are separate constants that don't START with these
// prefixes, so they survive.
export function patchAuthlibForLocalServer(authlibJarPath: string, destJarPath: string, host: string): boolean {
  const zip = fs.readFileSync(authlibJarPath);
  const patchedClasses = new Map<string, Buffer>();
  for (const e of listZipEntries(zip)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    const s = e.data.toString('latin1');
    let patched: Buffer | null = null;

    // 1) Hardcoded session-server URL (authlib 1.5.x–3.x that ignore the
    //    minecraft.api.*.host properties).
    if (s.includes('https://sessionserver.mojang.com')) {
      patched = patchClassConstantPoolPrefixes(e.data, [['https://sessionserver.mojang.com', host]]);
    }

    // 2) Texture-URL allow-list constants → empty string (see module comment).
    const domainRewrites: Array<[string, string]> = [];
    if (s.includes('.minecraft.net')) {
      domainRewrites.push(['.minecraft.net', '']);
    }
    if (s.includes('.mojang.com')) {
      domainRewrites.push(['.mojang.com', '']);
    }
    if (s.includes('textures.minecraft.net')) {
      domainRewrites.push(['textures.minecraft.net', '']);
    }
    if (domainRewrites.length > 0) {
      patched = patchClassConstantPoolPrefixes(patched ?? e.data, domainRewrites);
    }

    if (patched && !patched.equals(e.data)) {
      patchedClasses.set(e.name, patched);
    }
  }
  if (patchedClasses.size === 0) return false;

  // Rebuild the ENTIRE jar with the patched classes swapped in. The caller
  // replaces the original authlib jar on the classpath with this copy, so the
  // classpath holds exactly ONE jar exporting com.mojang.authlib.*. Modern
  // Forge launches the game as a JPMS module (the "patchy" bootstrap); a
  // supplementary mini-jar would split that package across two modules
  // (authlib + authlib.skins) and die with a ResolutionException.
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const e of listZipEntries(zip)) {
    const p = patchedClasses.get(e.name);
    if (p) { out.push({ name: e.name, data: p }); continue; }
    if (e.data === null) return false; // can't recompress — bail rather than ship a broken jar
    out.push({ name: e.name, data: e.data });
  }
  fs.writeFileSync(destJarPath, buildZip(out));
  return true;
}

export function isAuthlibJar(filePath: string): boolean {
  return AUTH_PATTERN.test(filePath);
}

// Builds the offline-skins jar for pre-1.7 versions (no authlib): scans the
// client jar for every class whose constant pool references the hardcoded
// skin hosts (s3 / skins.minecraft.net) and rewrites them to the local skin
// server. All patched classes go into one tiny jar. Returns true when at
// least one class was patched.
export function patchClientJarForLegacySkins(clientJarPath: string, destJarPath: string, host: string): boolean {
  const zip = fs.readFileSync(clientJarPath);
  const pairs = legacySkinPatchPairs(host);
  const patchedClasses: Array<{ name: string; data: Buffer }> = [];
  for (const e of listZipEntries(zip)) {
    if (!e.data || !e.name.endsWith('.class')) continue;
    if (!containsSkinUrl(e.data)) continue;
    const patched = patchClassConstantPoolPrefixes(e.data, pairs);
    if (!patched.equals(e.data)) {
      patchedClasses.push({ name: e.name, data: patched });
    }
  }
  if (patchedClasses.length === 0) return false;
  fs.writeFileSync(destJarPath, buildZip([
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\n\r\n', 'utf8') },
    ...patchedClasses,
  ]));
  return true;
}