import { createRequire } from 'node:module';

// pngjs is a pure-JS PNG codec (decode/encode, all color types, interlacing).
// Loaded the same way as better-sqlite3 so the bundled main process resolves
// it from node_modules at runtime.
const req = createRequire(import.meta.url);
const { PNG } = req('pngjs') as typeof import('pngjs');

export interface PngInfo {
  width: number;
  height: number;
}

// Reads the PNG dimensions straight from the IHDR chunk — no full decode, so
// it is cheap enough to run on every request.
export function pngDimensions(buf: Buffer): PngInfo | null {
  if (buf.length < 24) return null;
  // 8-byte PNG signature
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 8192 || height > 8192) return null;
  return { width, height };
}

// Downscales a PNG to targetWidth×targetHeight using an area-average filter
// with alpha-premultiplied color averaging (avoids dark fringes around
// semi-transparent pixels). Returns null if the image can't be decoded or the
// encode fails — callers should fall back to serving the original.
export function resizePng(buf: Buffer, targetWidth: number, targetHeight: number): Buffer | null {
  try {
    const png = PNG.sync.read(buf);
    if (png.width === targetWidth && png.height === targetHeight) return buf;

    const src = png.data; // normalized RGBA8
    const out = Buffer.alloc(targetWidth * targetHeight * 4);
    const sx = png.width / targetWidth;
    const sy = png.height / targetHeight;

    for (let dy = 0; dy < targetHeight; dy++) {
      const y0 = dy * sy;
      const y1 = y0 + sy;
      const yStart = Math.floor(y0);
      const yEnd = Math.min(png.height, Math.ceil(y1));
      for (let dx = 0; dx < targetWidth; dx++) {
        const x0 = dx * sx;
        const x1 = x0 + sx;
        const xStart = Math.floor(x0);
        const xEnd = Math.min(png.width, Math.ceil(x1));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0; // alpha weighted by pixel coverage
        let wsum = 0;
        for (let py = yStart; py < yEnd; py++) {
          const wy = Math.min(py + 1, y1) - Math.max(py, y0);
          for (let px = xStart; px < xEnd; px++) {
            const wx = Math.min(px + 1, x1) - Math.max(px, x0);
            const w = wx * wy;
            const i = (py * png.width + px) * 4;
            const sa = src[i + 3] / 255;
            r += src[i] * sa * w;
            g += src[i + 1] * sa * w;
            b += src[i + 2] * sa * w;
            a += src[i + 3] * w;
            wsum += w;
          }
        }
        if (wsum <= 0) continue;
        const o = (dy * targetWidth + dx) * 4;
        const oa = a / wsum;
        out[o + 3] = Math.round(oa);
        if (oa > 0) {
          // Un-premultiply: weighted premultiplied color / weighted alpha.
          out[o] = Math.min(255, Math.round((r * 255) / a));
          out[o + 1] = Math.min(255, Math.round((g * 255) / a));
          out[o + 2] = Math.min(255, Math.round((b * 255) / a));
        } else {
          out[o] = out[o + 1] = out[o + 2] = 0;
        }
      }
    }

    const resized = new PNG({ width: targetWidth, height: targetHeight });
    resized.data = out;
    return PNG.sync.write(resized, { colorType: 6 });
  } catch {
    return null;
  }
}
