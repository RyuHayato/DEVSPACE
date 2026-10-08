// Draws the DevWorkspace mark and writes it as a 1024px PNG.
//
// The mark is a prompt glyph — a bone chevron over an ember caret rule — which
// is the same `›_` motif the app uses as its wordmark. Written with zlib only
// so icon generation needs no image dependencies.
//
//   node scripts/make-icon.mjs
//   npx tauri icon scripts/icon-source.png -o src-tauri/icons
//
// Re-run both commands if the palette or the mark changes.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const BG = [0x10, 0x11, 0x14];
const BORDER = [0x2b, 0x2d, 0x34];
const BONE = [0xf2, 0xf1, 0xee];
const EMBER = [0xe8, 0x91, 0x3d];

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - cx;
  const dy = y - cy;
  return Math.hypot(dx, dy) - radius;
}

/** Distance from a point to a line segment. */
function segmentDistance(x, y, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : clamp01(((x - x1) * vx + (y - y1) * vy) / lengthSq);
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy));
}

/** Coverage of a stroke of the given width, antialiased over one pixel. */
const strokeCoverage = (distance, width) => clamp01(width / 2 + 0.5 - distance);

// The mark, in canvas coordinates.
const CHEVRON = [
  [350, 250, 565, 440],
  [565, 440, 350, 630],
];
const CARET = [350, 712, 700, 712];
const STROKE = 82;

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;

    // Plate: a rounded square with a hairline inner border.
    const plate = roundedRectDistance(px, py, 24, 24, SIZE - 24, SIZE - 24, 184);
    const plateCoverage = clamp01(0.5 - plate);
    const borderCoverage = strokeCoverage(Math.abs(plate), 7);

    let r = BG[0];
    let g = BG[1];
    let b = BG[2];
    const blend = (colour, alpha) => {
      r = r * (1 - alpha) + colour[0] * alpha;
      g = g * (1 - alpha) + colour[1] * alpha;
      b = b * (1 - alpha) + colour[2] * alpha;
    };

    blend(BORDER, borderCoverage);

    const chevron = Math.min(
      ...CHEVRON.map(([x1, y1, x2, y2]) => segmentDistance(px, py, x1, y1, x2, y2)),
    );
    blend(BONE, strokeCoverage(chevron, STROKE));
    blend(EMBER, strokeCoverage(segmentDistance(px, py, ...CARET), STROKE));

    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(r);
    pixels[offset + 1] = Math.round(g);
    pixels[offset + 2] = Math.round(b);
    pixels[offset + 3] = Math.round(plateCoverage * 255);
  }
}

// --- PNG container ---------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // truecolour with alpha
// Remaining bytes are the default compression, filter and interlace methods.

// One filter byte (0 = none) per scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  const from = y * SIZE * 4;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, from, from + SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = resolve(dirname(fileURLToPath(import.meta.url)), 'icon-source.png');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`wrote ${target} (${SIZE}x${SIZE}, ${png.length} bytes)`);
