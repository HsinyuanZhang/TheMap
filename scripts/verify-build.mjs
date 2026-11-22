import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const assetsDirectory = resolve('dist/assets');
const assetNames = await readdir(assetsDirectory);
const workerFiles = assetNames.filter((name) => name.startsWith('maplibre-gl-worker') && name.endsWith('.mjs'));
assert.equal(workerFiles.length, 1, `Expected one MapLibre worker asset, found ${workerFiles.length}.`);

const workerFile = workerFiles[0];
assert.ok(workerFile, 'MapLibre worker asset must be present.');
const workerPath = resolve(assetsDirectory, workerFile);
const workerContents = await readFile(workerPath, 'utf8');
const workerSize = (await stat(workerPath)).size;
assert.ok(workerSize > 0, 'MapLibre worker asset must not be empty.');
assert.doesNotMatch(workerContents, /^\s*<!doctype html/i, 'MapLibre worker asset must be JavaScript, not an SPA fallback document.');

const workerUrl = `/assets/${workerFile}`;
const applicationBundles = await Promise.all(assetNames
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFile(resolve(assetsDirectory, name), 'utf8')));
assert.ok(
  applicationBundles.some((contents) => contents.includes(workerUrl)),
  `Production JavaScript must reference the same-origin worker asset ${workerUrl}.`,
);

console.log(`Verified MapLibre worker asset ${workerUrl} (${workerSize} bytes) is emitted and referenced by a production bundle.`);
