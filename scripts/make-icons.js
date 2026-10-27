// Generates build/icon.png (app icon) and assets/drag-icon.png (drag preview). No dependencies.
// Run with: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// signed distance helpers (negative inside)
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d)); // 1px antialias

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [21, 23, 28];
  const amber = [255, 180, 84];
  const heights = [0.18, 0.4, 0.26, 0.62, 0.34, 0.5, 0.22];
  const barW = size * 0.07;
  const gap = size * 0.115;
  const x0 = size / 2 - ((heights.length - 1) / 2) * gap;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const a = cover(sdRoundRect(px, py, size / 2, size / 2, size * 0.46, size * 0.46, size * 0.2));
      let r = bg[0];
      let g = bg[1];
      let b = bg[2];
      let bar = 0;
      heights.forEach((h, i) => {
        const d = sdRoundRect(px, py, x0 + i * gap, size / 2, barW / 2, (size * h) / 2, barW / 2);
        bar = Math.max(bar, cover(d));
      });
      r = r + (amber[0] - r) * bar;
      g = g + (amber[1] - g) * bar;
      b = b + (amber[2] - b) * bar;
      const o = (y * size + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(1024));
fs.writeFileSync(path.join(root, 'assets', 'drag-icon.png'), render(128));
console.log('wrote build/icon.png and assets/drag-icon.png');
