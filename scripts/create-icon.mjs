import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const size = 256;
const pixels = Buffer.alloc(size * size * 4);

function setPixel(x, y, rgba) {
  const offset = (y * size + x) * 4;
  pixels[offset] = rgba[0];
  pixels[offset + 1] = rgba[1];
  pixels[offset + 2] = rgba[2];
  pixels[offset + 3] = rgba[3];
}

function fillRect(x, y, width, height, rgba) {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      if (xx >= 0 && yy >= 0 && xx < size && yy < size) {
        setPixel(xx, yy, rgba);
      }
    }
  }
}

function roundedRect(x, y, width, height, radius, rgba) {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      const dx = Math.max(x - xx, 0, xx - (x + width - 1));
      const dy = Math.max(y - yy, 0, yy - (y + height - 1));
      const nearCorner =
        (xx < x + radius && yy < y + radius) ||
        (xx >= x + width - radius && yy < y + radius) ||
        (xx < x + radius && yy >= y + height - radius) ||
        (xx >= x + width - radius && yy >= y + height - radius);

      if (!nearCorner || dx * dx + dy * dy <= radius * radius) {
        setPixel(xx, yy, rgba);
      }
    }
  }
}

const green = [35, 108, 90, 255];
const deepGreen = [23, 75, 62, 255];
const paper = [255, 253, 248, 255];
const blue = [47, 95, 158, 255];

roundedRect(16, 16, 224, 224, 38, green);
fillRect(36, 54, 184, 148, paper);
fillRect(36, 54, 184, 16, deepGreen);
fillRect(60, 96, 112, 10, deepGreen);
fillRect(60, 126, 92, 10, deepGreen);
fillRect(60, 156, 122, 10, deepGreen);
fillRect(186, 92, 16, 16, blue);
fillRect(186, 122, 16, 16, green);
fillRect(186, 152, 16, 16, deepGreen);

const rawRows = [];
for (let y = 0; y < size; y += 1) {
  rawRows.push(Buffer.from([0]));
  rawRows.push(pixels.subarray(y * size * 4, (y + 1) * size * 4));
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const payload = Buffer.concat([typeBuffer, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(payload), 8 + data.length);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk(
    "IHDR",
    Buffer.from([
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      8,
      6,
      0,
      0,
      0
    ])
  ),
  chunk("IDAT", deflateSync(Buffer.concat(rawRows))),
  chunk("IEND", Buffer.alloc(0))
]);

const outputPath = join(root, "src-tauri", "icons", "icon.png");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, png);
console.log(outputPath);
