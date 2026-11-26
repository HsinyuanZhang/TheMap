import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { datasetNames, emptyMapDatasets, type Dataset, type MapDatasets } from '../src/dataset-loader';
import { WorldModel, toLngLat, worldHash } from '../src/world-model';
import { PAINT, paintPixels, tileView, lodWeights, type Pixels } from '../src/terrain-painter';
import { ByteLRU } from '../src/paint-cache';
import { beverlyElevationAt } from '../data/generate';

const data: MapDatasets = Object.fromEntries(await Promise.all(datasetNames.map(async name => [name,
  JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8')) as Dataset]))) as unknown as MapDatasets;
const world = new WorldModel(data);
function tileAt(z: number, x: number, y: number): [number, number, number] {
  const [lng, lat] = toLngLat([x, y]), n = 2 ** z;
  return [z, Math.floor((lng + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)];
}
function seam(a: Pixels, b: Pixels, vertical: boolean): number {
  let difference = 0;
  for (let p = 0; p < 512; p++) for (let c = 0; c < 3; c++) {
    const i = vertical ? ((511 * 512 + p) * 4 + c) : ((p * 512 + 511) * 4 + c);
    const j = vertical ? p * 4 + c : p * 512 * 4 + c;
    difference += Math.abs(a.data[i] - b.data[j]);
  }
  return difference / (512 * 3 * 255);
}

test('dataset-backed world surfaces cover every district and airport without DOM access', () => {
  const seen = new Map<string, Set<string>>();
  for (let y = 0; y < 34; y += 0.7) for (let x = -2; x < 36; x += 0.7) {
    const s = world.sample(x, y), surfaces = seen.get(s.district) ?? new Set();
    surfaces.add(s.surface); seen.set(s.district, surfaces);
    if (s.district === 'reserve') assert.ok(['wood', 'farm', 'town'].includes(s.surface));
  }
  for (const f of data.districts.features) assert.ok(seen.has(String(f.properties.id)), String(f.properties.id));
  for (const id of ['reserve', 'beverly']) assert.ok(seen.get(id)?.has('wood'));
  assert.ok(seen.get('reserve')?.has('town'));
  assert.equal(world.sample(11.6, 3.6).surface, 'highrise');
  for (const f of data.surface.features.filter(f => f.properties.kind === 'airport')) {
    assert.equal(f.geometry.type, 'Polygon');
    if (f.geometry.type !== 'Polygon') continue;
    const points = f.geometry.coordinates[0].slice(0, -1), center = points.reduce((a, p) => [a[0] + p[0] / points.length, a[1] + p[1] / points.length], [0, 0]);
    const x = (center[0] + 150) * 111.32 * Math.cos(40 * Math.PI / 180), y = (center[1] - 40) * 110.574;
    for (let dx = -1.2; dx <= 1.2; dx += 0.4) for (let dy = -1.2; dy <= 1.2; dy += 0.4) assert.equal(world.sample(x + dx, y + dy).surface, 'airport');
  }
  for (const [x, y] of [[16.7, 4.5], [19, 6], [26, 5]]) assert.equal(world.elevationAt(x, y), beverlyElevationAt([x, y]));
  assert.equal(world.quarterAt(5, 8, 'manhattan').angle, 0);
  assert.equal(world.quarterAt(1, 1, 'manhattan').angle, 24 * Math.PI / 180);
  assert.equal(world.quarterAt(5, 1, 'manhattan').angle, 2 * Math.PI / 180);
  assert.equal(world.quarterAt(12, 5, 'central').angle, 11 * Math.PI / 180);
  assert.notEqual(world.quarterAt(5, 12).id, world.quarterAt(8, 15).id);
  const empty = new WorldModel(emptyMapDatasets());
  assert.equal(empty.sample(0, 0).surface, 'sea');
  assert.equal(empty.elevationAt(0, 0), 0);
  assert.ok(worldHash(-1, 0) >= 0 && worldHash(-1, 0) < 1);
});

test('same tile paints identical RGBA pixels including the glyphs', () => {
  const view = tileView(...tileAt(13, 19, 6));
  const a = paintPixels(world, view), b = paintPixels(world, view);
  assert.deepEqual(a.data, b.data);
  assert.equal(a.data.length, 512 * 512 * 4);
  assert.ok(new Set(a.data).size > 80);
  assert.deepEqual(a.data, paintPixels(world, view, 64).data, '48 px bleed must contain complete glyphs');
});

test('three adjacent coast, urban and woodland tile pairs differ by less than 3% along seams', () => {
  for (const [z, x, y, vertical] of [[11, 1, 0, false], [13, 12, 5, true], [13, 22, 6, false]] as const) {
    const [tz, tx, ty] = tileAt(z, x, y);
    const a = paintPixels(world, tileView(tz, tx, ty));
    const b = paintPixels(world, tileView(tz, tx + (vertical ? 0 : 1), ty + (vertical ? 1 : 0)));
    const difference = seam(a, b, vertical);
    console.log(`Paint seam z${z} ${vertical ? 'south' : 'east'}: ${(difference * 100).toFixed(3)}%`);
    assert.ok(difference < 0.03, String(difference));
  }
});

test('three painter tiers fade over 0.3 zoom, hide Manhattan glyphs near, and suppress towers above pitch 30', () => {
  assert.deepEqual(lodWeights(11), { glyphs: 0, manhattan: 1 });
  assert.ok(Math.abs(lodWeights(11.85).glyphs - 0.5) < 1e-10);
  assert.ok(Math.abs(lodWeights(13.65).manhattan - 0.5) < 1e-10);
  assert.equal(lodWeights(14).manhattan, 0);
  const view = { west: 10.5, north: 4.6, east: 12.8, south: 2.5, width: 128, height: 128, zoom: 12.5 };
  const flat = paintPixels(world, view), pitched = paintPixels(world, { ...view, pitch: 31 });
  assert.notDeepEqual(flat.data, pitched.data);
  assert.deepEqual(paintPixels(world, { ...view, pitch: 30 }).data, flat.data);
  assert.deepEqual(pitched.data, paintPixels(world, { ...view, buildings: false }).data);
  const tile = tileView(12, 342, 1547);
  assert.notEqual(tile.east - tile.west, tile.north - tile.south);
  assert.throws(() => tileView(6, 0, 0), /Invalid/);
  assert.throws(() => tileView(12, -1, 0), /Invalid/);
  assert.throws(() => paintPixels(world, { ...view, width: 0 }), /Invalid/);
  assert.throws(() => paintPixels(world, { ...view, west: NaN }), /Invalid/);
  assert.equal(PAINT.bleed, 48);
});

test('byte-bounded LRU refreshes recency, evicts old entries, clears, and refuses oversized tiles', () => {
  const cache = new ByteLRU(8), a = new ArrayBuffer(4), b = new ArrayBuffer(4);
  assert.equal(cache.get('none'), undefined);
  cache.set('a', a); cache.set('b', b); assert.equal(cache.get('a'), a);
  cache.set('c', new ArrayBuffer(4)); assert.equal(cache.get('b'), undefined);
  cache.set('a', new ArrayBuffer(10)); assert.equal(cache.get('a'), undefined);
  assert.ok(cache.bytes <= 8);
  cache.clear(); assert.equal(cache.bytes, 0); assert.equal(cache.get('c'), undefined);
  assert.throws(() => new ByteLRU(-1), /Invalid/);
});
