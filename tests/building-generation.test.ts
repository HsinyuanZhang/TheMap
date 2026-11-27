import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { booleanWithin } from '@turf/turf';
import type { Feature, FeatureCollection, LineString, Polygon, Position } from 'geojson';
import { assertRoadClearance, type Road, type Ring } from '../scripts/data-invariants';

type Properties = Record<string, string | number | boolean>;
type PolygonFeature = Feature<Polygon, Properties>;

const readCollection = async (name: string): Promise<FeatureCollection<Polygon, Properties>> =>
  JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8')) as FeatureCollection<Polygon, Properties>;

const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;
const toLocal = ([longitude, latitude]: Position): [number, number] => [
  (longitude! + 150) * longitudeScale,
  (latitude! - 40) * latitudeScale,
];

function polygonBounds(feature: PolygonFeature): { minX: number; maxX: number; minY: number; maxY: number } {
  const points = feature.geometry.coordinates.flat().map(toLocal);
  return {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)),
    maxY: Math.max(...points.map(([, y]) => y)),
  };
}

function boundsCells(bounds: ReturnType<typeof polygonBounds>, size: number): string[] {
  const keys: string[] = [];
  for (let x = Math.floor(bounds.minX / size); x <= Math.floor(bounds.maxX / size); x += 1) {
    for (let y = Math.floor(bounds.minY / size); y <= Math.floor(bounds.maxY / size); y += 1) keys.push(`${x}:${y}`);
  }
  return keys;
}

test('generated buildings and blocks meet Phase 3 count, height, type, support, and monument invariants', async () => {
  const [buildings, blocks, districts] = await Promise.all([
    readCollection('buildings'), readCollection('blocks'), readCollection('districts'),
  ]);
  const manhattan = districts.features.find((item) => item.properties?.id === 'manhattan') as PolygonFeature | undefined;
  assert.ok(manhattan, 'Manhattan district geometry is required');

  const bids = new Map<string, PolygonFeature[]>();
  for (const building of buildings.features as PolygonFeature[]) {
    const bid = building.properties?.bid;
    assert.equal(typeof bid, 'string', 'every generated building must have a bid');
    bids.set(bid as string, [...(bids.get(bid as string) ?? []), building]);
  }
  assert.ok(bids.size <= 20000, 'total distinct building bids must not exceed 20,000');
  const manhattanBids = [...bids.values()].filter((segments) => {
    const base = segments.find((segment) => Number(segment.properties?.base) === 0);
    assert.ok(base, 'every bid must have a ground footprint');
    return booleanWithin(base, manhattan);
  });
  assert.ok(manhattanBids.length >= 8000 && manhattanBids.length <= 13000,
    'Manhattan must contain 8,000-13,000 distinct building bids');

  const heights = manhattanBids.map((segments) => Number(segments[0]!.properties?.top)).sort((a, b) => a - b);
  const middle = Math.floor(heights.length / 2);
  const median = heights.length % 2 === 0 ? (heights[middle - 1]! + heights[middle]!) / 2 : heights[middle]!;
  const above150 = heights.filter((height) => height > 150).length;
  const above300 = heights.filter((height) => height > 300).length;
  assert.ok(median >= 20 && median <= 35, 'Manhattan median building height must remain 20-35 m');
  assert.ok(above150 / heights.length >= 0.03 && above150 / heights.length <= 0.07,
    '3-7% of Manhattan buildings must exceed 150 m');
  assert.ok(above300 >= 5 && above300 <= 60, 'Manhattan must contain 5-60 buildings above 300 m');

  const keyBids = new Set(buildings.features.filter((item) => Number(item.properties?.key) === 1)
    .map((item) => String(item.properties?.bid)));
  const keySegments = buildings.features.filter((item) => Number(item.properties?.key) === 1).length;
  assert.ok(keyBids.size >= 100 && keyBids.size <= 200, 'key buildings must cover 100-200 distinct bids');
  assert.ok(keySegments <= 1200, 'key buildings must use at most 1,200 segments');

  const allowedTypes = new Set(['highrise', 'midrise', 'lowrise', 'lowdensity', 'town', 'plaza']);
  assert.ok(blocks.features.every((block) => allowedTypes.has(String(block.properties?.type))),
    'every block type must use one of the six canonical values');
  const manhattanTypes = new Set<string>();
  const heightsByBlock = new Map<string, Map<string, number>>();
  for (const building of buildings.features) {
    if (Number(building.properties?.base) !== 0) continue;
    const blockId = String(building.properties?.block_id);
    const bid = String(building.properties?.bid);
    const group = heightsByBlock.get(blockId) ?? new Map<string, number>();
    group.set(bid, Number(building.properties?.top));
    heightsByBlock.set(blockId, group);
  }
  for (const block of blocks.features as PolygonFeature[]) {
    const zone = String(block.properties?.zone);
    const kind = String(block.properties?.kind);
    const type = String(block.properties?.type);
    if (booleanWithin(block, manhattan)) {
      manhattanTypes.add(type);
      if (kind === 'plaza') {
        assert.equal(type, 'plaza');
      } else {
        const heights = [...(heightsByBlock.get(String(block.properties?.block_id))?.values() ?? [])];
        const maximum = Math.max(0, ...heights);
        const mean = heights.length ? heights.reduce((sum, height) => sum + height, 0) / heights.length : 0;
        const expected = maximum >= 150 ? 'highrise' : mean >= 45 || maximum >= 90 ? 'midrise' : 'lowrise';
        assert.equal(type, expected, `${String(block.properties?.block_id)} must use its actual Manhattan bid heights`);
      }
    }
    if (zone === 'beverly' && kind !== 'plaza') assert.equal(type, 'lowdensity');
    if (kind === 'town') assert.equal(type, 'town');
    if (kind === 'superblock' && zone === 'uptown') assert.equal(type, 'midrise');
    if (kind === 'superblock' && ['st-germain', 'harlem'].includes(zone)) assert.equal(type, 'lowrise');
  }
  assert.deepEqual([...manhattanTypes].filter((type) => ['highrise', 'midrise', 'lowrise'].includes(type)).sort(),
    ['highrise', 'lowrise', 'midrise']);
  const roadCollection = JSON.parse(await readFile(new URL('../public/data/roads.geojson', import.meta.url), 'utf8')) as FeatureCollection<LineString, Properties>;
  const roadCellSize = 0.25;
  const roadIndex = new Map<string, Road[]>();
  for (const road of roadCollection.features) {
    assert.equal(road.geometry.type, 'LineString');
    const coordinates = road.geometry.coordinates.map(toLocal);
    const width = Number(road.properties?.width);
    for (let index = 1; index < coordinates.length; index += 1) {
      const start = coordinates[index - 1]!;
      const end = coordinates[index]!;
      const segment: Road = { coordinates: [start, end], width };
      const bounds = {
        minX: Math.min(start[0], end[0]) - width / 2,
        maxX: Math.max(start[0], end[0]) + width / 2,
        minY: Math.min(start[1], end[1]) - width / 2,
        maxY: Math.max(start[1], end[1]) + width / 2,
      };
      for (const cell of boundsCells(bounds, roadCellSize)) roadIndex.set(cell, [...(roadIndex.get(cell) ?? []), segment]);
    }
  }
  const baseFootprints = buildings.features.filter((item) => Number(item.properties?.base) === 0) as PolygonFeature[];
  for (const footprint of baseFootprints) {
    const roadCells = boundsCells(polygonBounds(footprint), roadCellSize);
    const nearbyRoads = new Set(roadCells.flatMap((cell) => roadIndex.get(cell) ?? []));
    const ring = footprint.geometry.coordinates[0]!.map(toLocal) as Ring;
    assertRoadClearance(ring, [...nearbyRoads]);
  }
  assert.ok(!blocks.features.some((item) => item.properties?.kind === 'superblock'));
  assert.ok(!buildings.features.some((item) => ['uptown-support', 'villa', 'town-house', 'warehouse'].includes(String(item.properties?.kind))));
  const monuments = buildings.features.filter((item) => item.properties?.kind === 'monument');
  const monumentIds = new Set(monuments.map((item) => String(item.properties?.id)));
  assert.deepEqual([...monumentIds].sort(), ['church', 'old-governors-house', 'republic-monument']);
  assert.ok(monuments.every((item) => Number(item.properties?.key) === 1));
  const monumentPlazas = blocks.features.filter((item) => item.properties?.kind === 'plaza' && typeof item.properties?.monument_id === 'string');
  assert.deepEqual(monumentPlazas.map((item) => String(item.properties?.monument_id)).sort(), [...monumentIds].sort());
  console.log(`Building bids: Manhattan=${manhattanBids.length}; total=${bids.size}; key=${keyBids.size} bids/${keySegments} segments.`);
  console.log(`Manhattan heights: median=${median} m; <45=${heights.filter((height) => height < 45).length}; 45-90=${heights.filter((height) => height >= 45 && height < 90).length}; 90-150=${heights.filter((height) => height >= 90 && height <= 150).length}; >150=${above150} (${(above150 / heights.length * 100).toFixed(2)}%); >300=${above300}.`);
  console.log(`Block types: ${[...new Set(blocks.features.map((item) => String(item.properties?.type)))].sort().join(', ')}.`);
  console.log(`Road clearance: ${baseFootprints.length} base footprints checked against road-width buffers.`);
});
