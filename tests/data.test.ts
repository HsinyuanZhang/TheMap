import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getStationInfo } from '../src/station-info';
import type { MapDatasets } from '../src/map';
import { districts, land, points, roads, stations, transitLines } from '../data/source';
import { closeRing, curvedBoundary, distanceToSegment, reversePath, samePoint } from '../data/geometry';

const transitFixture = JSON.parse(await readFile(new URL('./transit.fixture.json', import.meta.url), 'utf8')) as Record<string, {
  color: string;
  stations: string[];
}>;

test('the single transit source definition matches Appendix B station order and colors', () => {
  assert.equal(transitLines.length, 3);
  assert.equal(stations.length, 14);
  const names = new Map(stations.map((station) => [station.id, station.name]));
  for (const route of transitLines) {
    const expected = transitFixture[route.id];
    assert.ok(expected);
    assert.equal(route.color, expected.color);
    assert.deepEqual(route.stations.map((id) => names.get(id)), expected.stations);
  }
  assert.equal(new Set(transitLines.flatMap((route) => route.stations)).size, stations.length);
  assert.equal(transitLines.flatMap((route) => route.stations).filter((id) => id === 'station-strait-exchange').length, 2);
  assert.equal(transitLines.flatMap((route) => route.stations).filter((id) => id === 'station-times-square').length, 2);
});

test('the kilometer source keeps district coverage, named arterial count, and highway connections compact', () => {
  assert.equal(districts.length, 8);
  assert.equal(land.filter((feature) => feature.kind !== 'monaco').length, 2);
  assert.equal(new Set(points.map((point) => point.id)).size, points.length);
  assert.deepEqual(roads.filter((road) => road.roadClass === 'arterial').map((road) => road.id), [
    'fifth-avenue', 'broadway', 'queens-road', 'wall-street', 'promenade',
  ]);
  const highwayById = new Map(roads.filter((road) => road.roadClass === 'motorway').map((road) => [road.id, road]));
  assert.deepEqual(highwayById.get('A1')?.coordinates[0], [3.2, 3.4555]);
  assert.deepEqual(highwayById.get('A2')?.coordinates[0], [7.7, 3.465]);
  assert.deepEqual(highwayById.get('A3')?.coordinates[0], [8, 21]);
  assert.deepEqual(highwayById.get('A3')?.coordinates.at(-1), [36, 4]);
  assert.deepEqual(highwayById.get('A1')?.coordinates[4], highwayById.get('A3')?.coordinates[0]);
  assert.deepEqual(highwayById.get('A2')?.coordinates.at(-2), highwayById.get('A3')?.coordinates.at(-1));
  assert.deepEqual(points.find((point) => point.id === 'strait-exchange')?.position, [0, 0]);
});

test('shared boundary helpers preserve coast endpoints and reverse internal edges exactly', () => {
  const path = curvedBoundary([0, 0], [4, 0], 0.5, 0.7, 6);
  assert.equal(path.length, 6);
  assert.ok(samePoint(path[0]!, [0, 0]));
  assert.ok(samePoint(path.at(-1)!, [4, 0]));
  assert.deepEqual(reversePath(path).reverse(), path);
  assert.deepEqual(closeRing([[0, 0], [1, 0], [1, 1]]).at(-1), [0, 0]);
  assert.ok(distanceToSegment([2, 0.5], [0, 0], [4, 0]) <= 0.5);
});

test('moved Manhattan stations stay within 300 meters of their Appendix positions', async () => {
  const fixture = JSON.parse(await readFile(new URL('./phase1-geometry.fixture.json', import.meta.url), 'utf8')) as {
    stationsKm: Record<string, [number, number]>;
  };
  for (const station of stations.filter((item) => item.district === '曼哈顿区')) {
    const original = fixture.stationsKm[station.id];
    assert.ok(original, 'the original station position must be fixture-backed');
    assert.ok(Math.hypot(station.position[0] - original[0], station.position[1] - original[1]) <= 0.3);
  }
});

test('station metadata includes adjacent stops, transfers, terminal stops, and missing IDs', () => {
  const datasets = {
    metro_stations: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 'exchange', name: '海峡交易所', district: '曼哈顿区', lines: 'U1' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { id: 'transfer', name: '时代广场', district: '曼哈顿区', lines: 'U1,U3' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 2] }, properties: { id: 'park', name: '中央公园', district: '曼哈顿区', lines: 'U1' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 3] }, properties: { id: 'harlem', name: '哈林', district: '哈林区', lines: 'U3' } },
      ],
    },
    metro_lines: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }, properties: { id: 'U1', stations: 'exchange,transfer,park' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 1], [3, 3]] }, properties: { id: 'U3', stations: 'transfer,harlem' } },
      ],
    },
  } as unknown as MapDatasets;

  assert.deepEqual(getStationInfo('transfer', datasets), {
    name: '时代广场',
    district: '曼哈顿区',
    lines: [
      { id: 'U1', previous: '海峡交易所', next: '中央公园' },
      { id: 'U3', next: '哈林' },
    ],
  });
  assert.deepEqual(getStationInfo('exchange', datasets)?.lines, [{ id: 'U1', next: '时代广场' }]);
  assert.equal(getStationInfo('missing', datasets), undefined);
});
