#!/usr/bin/env node
/**
 * Draws the portal's app icons (the sidebar's brand mark: a white F on the accent colour) into PNG files under
 * public/icons/, with no dependency: the shapes are rectangles and a rounded square, rendered with 4×4 supersampling
 * and encoded with node:zlib. Run by hand after changing the mark (`node scripts/gen-icons.mjs`) and commit the
 * output; the build doesn't run it. public/favicon.svg draws the same mark.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

/** The accent colour (--color-f-accent) and the F, in a unit square. */
export const ACCENT = [0x3b, 0x82, 0xf6];
export const CORNER = 0.22;
export const GLYPH = [
  { x0: 0.34, y0: 0.24, x1: 0.46, y1: 0.76 }, // stem
  { x0: 0.34, y0: 0.24, x1: 0.7, y1: 0.35 }, // top arm
  { x0: 0.34, y0: 0.46, x1: 0.64, y1: 0.56 }, // middle arm
];

/**
 * The icons, by file. `rounded` leaves the corners transparent (browsers show it as is); the others fill the square,
 * for platforms that cut their own shape: maskable icons on Android and the iOS home screen. The F stays inside the
 * maskable safe zone (a circle of 40% radius) either way.
 */
export const ICONS = [
  { file: "icon-192.png", size: 192, rounded: true },
  { file: "icon-512.png", size: 512, rounded: true },
  { file: "icon-maskable-512.png", size: 512, rounded: false },
  { file: "apple-touch-icon.png", size: 180, rounded: false },
];

function insideBackground(x, y, rounded) {
  if (!rounded) return true;
  const r = CORNER;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const insideGlyph = (x, y) => GLYPH.some((g) => x >= g.x0 && x < g.x1 && y >= g.y0 && y < g.y1);

/** RGBA pixels (straight alpha) of the mark at `size`×`size`. */
export function drawMark(size, rounded) {
  const px = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let inside = 0;
      let white = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (pxl + (sx + 0.5) / n) / size;
          const y = (py + (sy + 0.5) / n) / size;
          if (!insideBackground(x, y, rounded)) continue;
          inside++;
          if (insideGlyph(x, y)) white++;
        }
      }
      const o = (py * size + pxl) * 4;
      if (!inside) continue;
      const w = white / inside;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(ACCENT[c] * (1 - w) + 255 * w);
      px[o + 3] = Math.round((255 * inside) / (n * n));
    }
  }
  return px;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG (8-bit RGBA, no filtering) of `rgba`, `width`×`height` pixels. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
  mkdirSync(out, { recursive: true });
  for (const icon of ICONS) {
    writeFileSync(join(out, icon.file), encodePng(icon.size, icon.size, drawMark(icon.size, icon.rounded)));
    console.log(`public/icons/${icon.file}: ${icon.size}×${icon.size}`);
  }
}
