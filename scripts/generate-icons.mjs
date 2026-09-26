/**
 * LANShare icon + social image generator.
 *
 * Renders the brand mark (rounded tile, bidirectional transfer arrow, two nodes) and
 * the Open Graph card with a tiny hand-rolled rasteriser and a 5×7 bitmap font.
 * No image dependencies, deterministic output, Node 18+.
 *
 * Usage: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

const ACCENT = [79, 70, 229];
const ACCENT_2 = [56, 189, 148];
const WHITE = [255, 255, 255];

/* ------------------------------ PNG output ------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const source = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    source.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ drawing ------------------------------ */

function canvas(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function setPixel(target, x, y, colour, alpha) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height || alpha <= 0) return;
  const index = (y * target.width + x) * 4;
  target.data[index] = Math.round(target.data[index] * (1 - alpha) + colour[0] * alpha);
  target.data[index + 1] = Math.round(target.data[index + 1] * (1 - alpha) + colour[1] * alpha);
  target.data[index + 2] = Math.round(target.data[index + 2] * (1 - alpha) + colour[2] * alpha);
  target.data[index + 3] = Math.round(Math.max(target.data[index + 3] / 255, alpha) * 255);
}

function fillRect(target, x, y, w, h, colour, alpha = 1) {
  for (let py = Math.max(0, y); py < Math.min(target.height, y + h); py += 1) {
    for (let px = Math.max(0, x); px < Math.min(target.width, x + w); px += 1) {
      setPixel(target, px, py, colour, alpha);
    }
  }
}

/** Rounded rectangle with 3×3 supersampled edges. */
function fillRoundedRect(target, x, y, w, h, radius, colourAt) {
  const samples = 3;
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const fx = px + (sx + 0.5) / samples;
          const fy = py + (sy + 0.5) / samples;
          const cx = Math.min(Math.max(fx, x + radius), x + w - radius);
          const cy = Math.min(Math.max(fy, y + radius), y + h - radius);
          if (Math.hypot(fx - cx, fy - cy) <= radius) covered += 1;
        }
      }
      if (covered > 0) setPixel(target, px, py, colourAt(px, py), covered / (samples * samples));
    }
  }
}

function fillCircle(target, cx, cy, r, colour, alpha = 1) {
  const samples = 3;
  for (let py = Math.floor(cy - r - 1); py <= Math.ceil(cy + r + 1); py += 1) {
    for (let px = Math.floor(cx - r - 1); px <= Math.ceil(cx + r + 1); px += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const fx = px + (sx + 0.5) / samples;
          const fy = py + (sy + 0.5) / samples;
          if (Math.hypot(fx - cx, fy - cy) <= r) covered += 1;
        }
      }
      if (covered > 0) setPixel(target, px, py, colour, (covered / (samples * samples)) * alpha);
    }
  }
}

function fillTriangle(target, points, colour, alpha = 1) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      let inside = 0;
      const samples = 3;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const point = [px + (sx + 0.5) / samples, py + (sy + 0.5) / samples];
          const d1 = sign(point, points[0], points[1]);
          const d2 = sign(point, points[1], points[2]);
          const d3 = sign(point, points[2], points[0]);
          const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
          const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
          if (!(hasNeg && hasPos)) inside += 1;
        }
      }
      if (inside > 0) setPixel(target, px, py, colour, (inside / (samples * samples)) * alpha);
    }
  }
}

function mix(a, b, t) {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

/* ------------------------------ the mark ------------------------------ */

/** Draw the LANShare mark into a square canvas. */
function drawMark(size, { maskable = false, transparent = true } = {}) {
  const target = canvas(size, size);
  const inset = size * (maskable ? 0.13 : 0.045);
  const radius = size * 0.23;
  const tileSize = size - inset * 2;

  fillRoundedRect(target, Math.round(inset), Math.round(inset), Math.round(tileSize), Math.round(tileSize), radius, (px, py) =>
    mix(ACCENT, ACCENT_2, Math.min(1, Math.max(0, (py - inset) / tileSize))),
  );

  const barHalf = Math.max(1, size * 0.033);
  const topY = size * 0.39;
  const bottomY = size * 0.61;
  const barLeft = size * 0.29;
  const barRight = size * 0.71;
  const head = size * 0.082;

  fillRect(target, Math.round(barLeft), Math.round(topY - barHalf), Math.round(barRight - barLeft), Math.round(barHalf * 2), WHITE);
  fillRect(target, Math.round(barLeft), Math.round(bottomY - barHalf), Math.round(barRight - barLeft), Math.round(barHalf * 2), WHITE);
  fillTriangle(
    target,
    [
      [barRight - head * 0.25, topY - head],
      [barRight + head * 0.85, topY],
      [barRight - head * 0.25, topY + head],
    ],
    WHITE,
  );
  fillTriangle(
    target,
    [
      [barLeft + head * 0.25, bottomY - head],
      [barLeft - head * 0.85, bottomY],
      [barLeft + head * 0.25, bottomY + head],
    ],
    WHITE,
  );

  fillCircle(target, size * 0.205, topY, Math.max(1.2, size * 0.052), WHITE);
  fillCircle(target, size * 0.795, bottomY, Math.max(1.2, size * 0.052), WHITE);

  if (!transparent) {
    for (let i = 0; i < target.data.length; i += 4) target.data[i + 3] = 255;
  }
  return target;
}

/* ------------------------------ 5×7 font ------------------------------ */

const GLYPHS = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.###.',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '####.|....#|....#|.###.|....#|....#|####.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '.###.|#....|#....|####.|#...#|#...#|.###.',
  7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|....#|.###.',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '·': '.....|.....|..##.|..##.|.....|.....|.....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};

function drawText(target, text, x, y, scale, colour, alpha = 1, letterSpacing = 1) {
  let cursor = x;
  for (const rawChar of text.toUpperCase()) {
    const glyph = GLYPHS[rawChar] ?? GLYPHS[' '];
    const rows = glyph.split('|');
    rows.forEach((row, rowIndex) => {
      row.split('').forEach((cell, colIndex) => {
        if (cell !== '#') return;
        fillRect(
          target,
          cursor + colIndex * scale,
          y + rowIndex * scale,
          scale,
          scale,
          colour,
          alpha,
        );
      });
    });
    cursor += (5 + letterSpacing) * scale;
  }
  return cursor - x;
}

function textWidth(text, scale, letterSpacing = 1) {
  return text.length * (5 + letterSpacing) * scale - letterSpacing * scale;
}

/* ------------------------------ outputs ------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

const ICONS = [
  { file: 'icon-192.png', size: 192, options: {} },
  { file: 'icon-512.png', size: 512, options: {} },
  { file: 'icon-maskable-512.png', size: 512, options: { maskable: true } },
  { file: 'apple-touch-icon.png', size: 180, options: {} },
  { file: 'favicon-32.png', size: 32, options: {} },
  { file: 'favicon-16.png', size: 16, options: {} },
];

for (const { file, size, options } of ICONS) {
  const png = encodePng(size, size, drawMark(size, options).data);
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`icons: ${file} (${size}×${size}, ${png.length} bytes)`);
}

/** ICO container with PNG payloads (16/32/48). */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const directory = [];
  for (const { size, data } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.data)]);
}

const ico = encodeIco(
  [16, 32, 48].map((size) => ({ size, data: encodePng(size, size, drawMark(size).data) })),
);
writeFileSync(join(ROOT, 'public', 'favicon.ico'), ico);
console.log(`icons: favicon.ico (${ico.length} bytes)`);

/* Open Graph card: 1200×630 with the mark, the name and the tagline. */
{
  const width = 1200;
  const height = 630;
  const card = canvas(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const glow = Math.max(0, 1 - Math.hypot((x - 180) / 900, (y - 60) / 620) * 2.2) * 0.5;
      setPixel(card, x, y, [14 + glow * 70, 20 + glow * 60, 34 + glow * 130], 1);
    }
  }

  const mark = drawMark(240, { maskable: true });
  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 240; x += 1) {
      const index = (y * 240 + x) * 4;
      const alpha = mark.data[index + 3] / 255;
      if (alpha > 0) setPixel(card, 96 + x, 110 + y, [mark.data[index], mark.data[index + 1], mark.data[index + 2]], alpha);
    }
  }

  const titleScale = 8;
  drawText(card, 'LANSHARE', 400, 132, titleScale, [237, 242, 250]);
  drawText(card, 'SHARE ANYTHING. NEARBY. INSTANTLY.', 400, 232, 3, [150, 166, 190]);
  drawText(card, 'FILES · PHOTOS · VIDEO · TEXT', 400, 296, 3, [124, 140, 255]);
  drawText(card, 'PEER TO PEER · ENCRYPTED', 400, 336, 3, [61, 220, 151], 0.9);
  drawText(card, 'BUILT BY MUHAMMAD ANAS', 400, 420, 3, [237, 242, 250], 0.85);
  drawText(card, 'NO ACCOUNT REQUIRED', 400, 462, 3, [150, 166, 190], 0.8);

  const png = encodePng(width, height, card.data);
  writeFileSync(join(OUT_DIR, 'og-image.png'), png);
  console.log(`icons: og-image.png (${width}×${height}, ${png.length} bytes)`);
  console.log(`icons: title width check ${textWidth('LANSHARE', titleScale)}px`);
}
