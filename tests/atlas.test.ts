import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { area, booleanPointInPolygon, booleanValid, difference, featureCollection, pointOnFeature } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson';
import { generateAtlas } from '../data/atlas';

type Properties = Record<string, string | number | boolean>;
type Item = Feature<Geometry, Properties>;
const read = async (name: string): Promise<FeatureCollection<Geometry, Properties>> => JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'));

test('exported atlas excludes water, contains varied dominant classes and bounded aspect shading', async () => {
  const [atlas, land, surface] = await Promise.all([read('atlas'), read('land'), read('surface')]);
  const monaco = land.features.find((item) => item.properties?.kind === 'monaco') as Feature<Polygon, Properties>;
  const hexes = atlas.features.filter((item) => item.properties?.kind === 'hex') as Feature<Polygon, Properties>[];
  assert.ok(hexes.length > 1000 && hexes.length < 3000);
  assert.ok(Buffer.byteLength(JSON.stringify(atlas)) < 1_000_000);
  const classes = new Set(hexes.map((item) => item.properties?.class));
  for (const kind of ['wood', 'farm', 'hill', 'district', 'lowrise']) assert.ok(classes.has(kind), kind);
  let covered = 0;
  for (const hex of hexes) {
    assert.ok(booleanValid(hex));
    const outside = difference(featureCollection([hex, monaco]));
    const path = hex.geometry.coordinates[0]!;
    const perimeter = path.slice(1).reduce((sum, p, index) => sum + Math.hypot((p[0]! - path[index]![0]!) * 85300, (p[1]! - path[index]![1]!) * 110574), 0);
    assert.ok(!outside || area(outside) <= perimeter * 0.14, 'only sub-cell coastal rounding is allowed');
    for (const p of path) for (const value of p) assert.ok(Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-7);
    covered += area(hex);
  }
  assert.ok(covered / area(monaco) > 0.999);
  const shades = atlas.features.filter((item) => item.properties?.kind === 'hillshade');
  assert.ok(shades.some((item) => Number(item.properties?.shade) > 0));
  assert.ok(shades.some((item) => Number(item.properties?.shade) < 0));
  assert.ok(shades.every((item) => Math.abs(Number(item.properties?.shade)) <= 1));
  const woods = surface.features.filter((item) => item.properties?.kind === 'wood') as Feature<Polygon, Properties>[];
  const clumps = atlas.features.filter((item) => item.properties?.kind === 'clump');
  assert.ok(clumps.length > 10 && clumps.length < 300);
  assert.ok(clumps.every((item) => woods.some((wood) => booleanPointInPolygon(pointOnFeature(item), wood))));
  const farms = surface.features.filter((item) => item.properties?.kind === 'farm');
  assert.deepEqual([...new Set(farms.map((item) => item.properties?.furrow))].sort(), ['east', 'north']);
  console.log(`Atlas: ${hexes.length} land hexes, ${shades.length} aspect cells, ${clumps.length} tree clumps; ${Buffer.byteLength(JSON.stringify(atlas)) + 1} raw bytes.`);
});

test('atlas generation is deterministic and supports empty detail collections', () => {
  const monaco: Feature<Polygon, Properties> = { type: 'Feature', properties: { kind: 'monaco' }, geometry: {
    type: 'Polygon', coordinates: [[[-150, 40], [-149.98, 40], [-149.98, 40.02], [-150, 40.02], [-150, 40]]],
  } };
  const generate = (): Item[] => generateAtlas(monaco, [], [], [], [], () => 0);
  const first = generate();
  assert.deepEqual(first, generate());
  assert.ok(first.length > 0);
  assert.ok(first.every((item) => item.properties?.kind === 'hex' && item.properties?.class === 'district'));
  const wood = { ...monaco, properties: { kind: 'wood' } };
  const forest = generateAtlas(monaco, [], [wood], [], [], () => 0);
  assert.ok(forest.filter((item) => item.properties?.kind === 'hex').every((item) => item.properties?.class === 'wood'));
  assert.ok(!forest.some((item) => item.properties?.kind === 'hillshade'));
});

test('aspect shading follows the shared northwest light on opposing slopes', () => {
  const sx = 111.32 * Math.cos(40 * Math.PI / 180), sy = 110.574;
  const corners = [[9, 3], [11, 3], [11, 5], [9, 5], [9, 3]];
  const beverly: Feature<Polygon, Properties> = { type: 'Feature', properties: { id: 'beverly' }, geometry: {
    type: 'Polygon', coordinates: [corners.map(([x, y]) => [-150 + x! / sx, 40 + y! / sy])],
  } };
  const shades = (elevation: (position: readonly [number, number]) => number) =>
    generateAtlas(beverly, [beverly], [], [], [], elevation).filter((item) => item.properties?.kind === 'hillshade');
  const lit = shades(([x]) => 100 * x), dark = shades(([, y]) => 100 * y);
  assert.ok(lit.length > 0 && dark.length > 0);
  assert.ok(lit.every((item) => Number(item.properties?.shade) > 0));
  assert.ok(dark.every((item) => Number(item.properties?.shade) < 0));
});
