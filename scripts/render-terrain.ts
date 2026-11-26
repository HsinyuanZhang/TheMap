import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { datasetNames, type MapDatasets } from '../src/dataset-loader';
import { paintPixels, type Pixels } from '../src/terrain-painter';
import { WorldModel } from '../src/world-model';

const output = resolve(process.argv[2] ?? '/home/ubuntu/phase4/out');
const world = new WorldModel(Object.fromEntries(await Promise.all(datasetNames.map(async name => [name,
  JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'))]))) as unknown as MapDatasets);
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(pixels: Pixels): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(pixels.width); header.writeUInt32BE(pixels.height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((pixels.width * 4 + 1) * pixels.height);
  for (let y = 0; y < pixels.height; y++) rows.set(pixels.data.subarray(y * pixels.width * 4, (y + 1) * pixels.width * 4), y * (pixels.width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}
await mkdir(output, { recursive: true });
for (const [name, cx, cy, scale, width, height] of [
  ['overview', 19, 17.5, 27, 1269, 952],
  ['central', 14, 5.8, 96, 1389, 868],
  ['harlem', 25, 16, 96, 1389, 868],
] as const) {
  const pixels = paintPixels(world, { west: cx - width / 2 / scale, east: cx + width / 2 / scale,
    north: cy + height / 2 / scale, south: cy - height / 2 / scale, width, height, zoom: Math.log2(scale * 59.96) });
  const path = resolve(output, `paint-${name}.png`);
  await writeFile(path, png(pixels));
  console.log(`Rendered ${path} (${width}x${height}; cx=${cx}, cy=${cy}, s=${scale})`);
}
