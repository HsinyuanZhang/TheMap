import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontnik = require('fontnik');
const font = await readFile(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url));
const directory = new URL('../public/fonts/DejaVu Sans/', import.meta.url);
await mkdir(directory, { recursive: true });

const glyphs = await new Promise((resolve, reject) => {
  fontnik.range({ font, start: 0, end: 255 }, (error, data) => {
    if (error) reject(error);
    else resolve(data);
  });
});

await writeFile(new URL('0-255.pbf', directory), glyphs);
console.log('Generated the self-hosted Latin glyph range 0-255.');
