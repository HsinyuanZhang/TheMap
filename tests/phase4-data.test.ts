import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { FeatureCollection, LineString, Polygon } from 'geojson';
import { booleanDisjoint, booleanWithin, lineString, polygon } from '@turf/turf';
import { curvedBoundary, smoothSpline } from '../data/geometry';
import { beverlyElevationAt, generateBeverlyRoadContours } from '../data/generate';
import { airport, airportAircraft, airportApron, airportPiers, airportPosition, airportRing, airportRunways, airportTaxiways } from '../data/phase4-config';
import { districts, points, roads, stations, transitLines, type XY } from '../data/source';
import { cleanRoundedNetwork, cleanRoundedPath, finalizeRoadNetwork, nodeRoads, roundedCorners } from '../data/phase4-network';
import { metroPaths } from '../data/phase4-roads';
import { isManhattanGridIntersection, maximumTurn } from '../scripts/phase4-validation';
import { maximumRoadGrade, roundHillroadTurns } from '../data/hillroad-arcs';

test('airport buildings share their rotated block geometry and defined centers', async () => {
  const buildings = JSON.parse(await readFile(new URL('../public/data/buildings.geojson', import.meta.url), 'utf8')) as FeatureCollection<Polygon>;
  const blocks = JSON.parse(await readFile(new URL('../public/data/blocks.geojson', import.meta.url), 'utf8')) as FeatureCollection<Polygon>;
  const parts = buildings.features.filter(f => f.properties?.id === 'airport');
  assert.equal(parts.length, 2);
  for (const part of parts) {
    const block = blocks.features.find(f => f.properties?.block_id === part.properties?.block_id)!;
    assert.deepEqual(part.geometry, block.geometry);
    const coordinates = part.geometry.coordinates[0]!;
    const center: XY = [
      ((Math.min(...coordinates.map(p => p[0]!)) + Math.max(...coordinates.map(p => p[0]!))) / 2 + 150) * 111.32 * Math.cos(40 * Math.PI / 180),
      ((Math.min(...coordinates.map(p => p[1]!)) + Math.max(...coordinates.map(p => p[1]!))) / 2 - 40) * 110.574,
    ];
    const expected = part.properties?.top === 30 ? airportPosition(0, -0.3) : airportPosition(-0.8, -0.4);
    assert.ok(Math.hypot(center[0] - expected[0], center[1] - expected[1]) < 0.002);
  }
});

test('every six-decimal building footprint remains inside its exported parent block', async () => {
  const buildings = JSON.parse(await readFile(new URL('../public/data/buildings.geojson', import.meta.url), 'utf8')) as FeatureCollection<Polygon>;
  const blocks = JSON.parse(await readFile(new URL('../public/data/blocks.geojson', import.meta.url), 'utf8')) as FeatureCollection<Polygon>;
  const parents = new Map(blocks.features.map(block => [block.properties?.block_id, block]));
  assert.ok(buildings.features.length > 0);
  for (const building of buildings.features) {
    const parent = parents.get(building.properties?.block_id);
    assert.ok(parent && booleanWithin(building, parent), String(building.properties?.bid));
  }
});

test('rounded metro arcs retain their stations and remain below the turn limit', () => {
  const paths = metroPaths();
  for (const line of transitLines) {
    const stops = stations.filter(s => line.stations.includes(s.id)).map(s => s.position);
    const path = cleanRoundedPath(paths.get(line.id)!, stops);
    assert.ok(maximumTurn(path) <= 12, line.id);
    for (const stop of stops) assert.ok(path.some(p => Math.hypot(p[0] - stop[0], p[1] - stop[1]) < 0.00015));
  }
  const fifthAvenue = paths.get('U1')!.filter(p => p[1] >= 5.013 && p[1] <= 7.129);
  assert.ok(fifthAvenue.length >= 2);
  assert.ok(fifthAvenue.every(p => Math.abs(p[0] - 5.908) < 0.00015));
});

test('final road intersections converge and are idempotent at export precision', () => {
  assert.deepEqual(finalizeRoadNetwork([]), []);
  assert.throws(() => finalizeRoadNetwork([{ id: 'invalid', name: '', roadClass: 'local', width: 0.02, coordinates: [[NaN, 0], [1, 0]] }]), /finite/);
  const roads = finalizeRoadNetwork([
    { id: 'east', name: '', roadClass: 'arterial', width: 0.024, coordinates: [[0, 0], [2, 0]] },
    { id: 'north', name: '', roadClass: 'arterial', width: 0.024, coordinates: [[1, -1], [1, 1]] },
  ]);
  assert.deepEqual(finalizeRoadNetwork(roads), roads);
  assert.deepEqual(nodeRoads(roads), roads);
});

test('only true right-angle Manhattan grid intersections receive the road exemption', () => {
  const corner: XY = [0.448, 3.633];
  const path: XY[] = [[corner[0] - 0.05, corner[1]], corner, [corner[0], corner[1] + 0.05]];
  assert.ok(isManhattanGridIntersection(...path as [XY, XY, XY]));
  assert.equal(maximumTurn(path, true), 0);
  assert.equal(maximumTurn(path), 90);
  assert.equal(maximumTurn([[1, 4], [2, 4], [2, 5]], true), 90);
  assert.equal(maximumTurn([[4.558, 6.025], [4.608, 6.025], [4.608, 6.075]], true), 90);
  assert.equal(maximumTurn([[-1, -1], [0, -1], [0, 0]], true), 90);
  assert.ok(!isManhattanGridIntersection([0.4, 3.6], corner, [0.5, 3.7]));
  assert.equal(maximumTurn([], true), 0);
});

test('exported roads and metro are cleaned at six decimals and hillroads meet angle and grade limits', async () => {
  const collections = await Promise.all(['roads', 'metro_lines'].map(async name =>
    JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8')) as FeatureCollection<LineString>));
  for (const collection of collections) {
    const shared = new Map<string, number>();
    for (const f of collection.features) for (const key of new Set(f.geometry.coordinates.map(p => p.join(',')))) {
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
    for (const f of collection.features) {
      const coordinates = f.geometry.coordinates;
      const path: XY[] = coordinates.map(([x, y]) => [(x! + 150) * 111.32 * Math.cos(40 * Math.PI / 180), (y! - 40) * 110.574]);
      assert.ok(path.length >= 2, `${f.properties?.id}: line must not collapse`);
      for (let i = 0; i < path.length; i++) {
        for (const value of coordinates[i]!) assert.equal(value, Number(value.toFixed(6)));
        if (i > 0) {
          assert.notDeepEqual(coordinates[i], coordinates[i - 1], `${f.properties?.id}: duplicate vertex`);
          const meters = Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]) * 1000;
          assert.ok(meters >= 3 || i === path.length - 1 || (shared.get(coordinates[i]!.join(',')) ?? 0) > 1,
            `${f.properties?.id}: unshared vertex only ${meters.toFixed(3)} m from the previous vertex`);
        }
        if (i > 1) assert.notDeepEqual(coordinates[i], coordinates[i - 2], `${f.properties?.id}: A-B-A backtrack`);
      }
      if (f.properties?.class === 'hillroad') {
        assert.ok(maximumTurn(path) <= 12, `${f.properties.id}: hillroad turn exceeds 12°`);
        assert.ok(maximumRoadGrade(path, beverlyElevationAt) <= 0.08, `${f.properties.id}: hillroad grade exceeds 8%`);
      }
    }
  }
});

test('hillroad arcs retain endpoints and satisfy exported turn and grade limits', () => {
  assert.deepEqual(roundHillroadTurns([], () => 0), []);
  assert.equal(maximumRoadGrade([], () => 0), 0);
  assert.throws(() => maximumRoadGrade([[0, 0], [1, 0]], () => NaN), /finite/);
  const source = [[0, 0], [1, 0], [1, 1]] as const;
  const path = roundHillroadTurns(source, () => 100);
  assert.deepEqual(path[0], cleanRoundedPath(source)[0]);
  assert.deepEqual(path.at(-1), cleanRoundedPath(source).at(-1));
  assert.ok(maximumTurn(path) <= 12);
  assert.equal(maximumRoadGrade(path, () => 100), 0);
  assert.ok(path.length > source.length);
  assert.deepEqual(roundHillroadTurns(source, () => 100, () => false), cleanRoundedPath(source));
});

test('rounded line cleanup removes duplicates, spikes and sub-3 m samples but preserves junctions', () => {
  assert.deepEqual(cleanRoundedPath([]), []);
  assert.deepEqual(cleanRoundedNetwork([]), []);
  assert.throws(() => cleanRoundedPath([[NaN, 0]]), /finite/);
  const expected = cleanRoundedPath([[0, 0], [0.02, 0]]);
  assert.deepEqual(cleanRoundedPath([[0, 0], [0, 0], [0.01, 0], [0, 0], [0.001, 0], [0.02, 0]]), expected);
  const junction = [0.001, 0] as const;
  const kept = cleanRoundedPath([[0, 0], junction, [0.02, 0]], [junction]);
  assert.equal(kept.length, 3);
  const roads = cleanRoundedNetwork([
    { id: 'east', name: '', roadClass: 'arterial', width: 0.024, coordinates: [[0, 0], junction, [0.0015, 0], junction, [0.02, 0]] },
    { id: 'north', name: '', roadClass: 'arterial', width: 0.024, coordinates: [[0.001, -0.01], junction, [0.001, 0.01]] },
  ]);
  assert.ok(roads[0]!.coordinates.some(p => roads[1]!.coordinates.some(q => p[0] === q[0] && p[1] === q[1])));
  for (const road of roads) for (let i = 2; i < road.coordinates.length; i++) {
    assert.notDeepEqual(road.coordinates[i], road.coordinates[i - 2]);
  }
});

test('road noding shares exported crossing vertices and handles empty networks', () => {
  assert.deepEqual(nodeRoads([]), []);
  const network = nodeRoads([
    { id: 'east', name: '', roadClass: 'arterial', width: 0.024, coordinates: [[0, 0], [2, 0]] },
    { id: 'north', name: '', roadClass: 'arterial', width: 0.024, coordinates: [[1, -1], [1, 1]] },
  ]);
  const first = network[0]!.coordinates, second = network[1]!.coordinates;
  assert.ok(first.some(p => second.some(q => p[0] === q[0] && p[1] === q[1])));
  assert.deepEqual(roundedCorners([]), []);
  assert.ok(maximumTurn(roundedCorners([[0, 0], [1, 0], [1, 1]])) < 12);
  assert.equal(maximumTurn([[0, 0], [1, 0], [1, 1]]), 90);
});

test('splines preserve control points and reject empty paths and invalid sampling', () => {
  const controls = [[0, 0], [1, 2], [3, 1]] as const;
  const path = smoothSpline(controls);
  for (const control of controls) assert.ok(path.some(([x, y]) => x === control[0] && y === control[1]));
  assert.deepEqual(smoothSpline([[0, 0], [0, 0]]).at(-1), [0, 0]);
  assert.throws(() => smoothSpline([]), /at least two points/);
  assert.throws(() => smoothSpline([[0, 0]]), /at least two points/);
  for (const step of [0, -1, Infinity, NaN]) assert.throws(() => smoothSpline(controls, step), /positive and finite/);
  assert.throws(() => curvedBoundary([0, 0], [0, 0], 0.2, 0), /distinct endpoints/);
});

test('airport geometry stays inside Harlem with two parallel runways and an A3 bypass', () => {
  const shape = (ring: readonly (readonly [number, number])[]) => polygon([ring.map(([x, y]) => [x, y])]);
  const site = shape(airportRing);
  assert.ok(booleanWithin(site, shape(districts.find(({ id }) => id === 'harlem')!.ring)));
  assert.equal(airportRunways.length, 2);
  for (const [start, end] of airportRunways) {
    assert.ok(Math.abs(Math.hypot(end[0] - start[0], end[1] - start[1]) - 3.4) < 1e-9);
    assert.ok(Math.abs(Math.atan2(end[1] - start[1], end[0] - start[0]) - airport.angle) < 1e-9);
  }
  assert.equal(airportTaxiways.length, 2);
  assert.equal(airportPiers.length, 3);
  assert.equal(airportAircraft.length, 6);
  for (const ring of [airportApron, ...airportTaxiways, ...airportPiers, ...airportAircraft]) assert.ok(booleanWithin(shape(ring), site));
  const a3 = roads.find(({ id }) => id === 'A3')!;
  assert.ok(booleanDisjoint(lineString(a3.coordinates.map(([x, y]) => [x, y])), site));
});

test('new Beverly contour candidates and the moved governor site meet elevation constraints', () => {
  const governor = points.find(({ id }) => id === 'old-governors-house')!;
  assert.ok(beverlyElevationAt(governor.position) >= 40);
  const contours = generateBeverlyRoadContours().filter(({ level, path }) => [200, 240].includes(level) && path.length > 20);
  assert.equal(contours.length, 2);
  for (const { path } of contours) {
    const xs = path.map(p => p[0]), ys = path.map(p => p[1]);
    const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
    const upperArc = path.filter(p => p[0] > west + (east - west) * 0.2 && p[0] < east - (east - west) * 0.2 && p[1] > (south + north) / 2).map(p => p[1]);
    assert.ok(Math.max(...upperArc) - Math.min(...upperArc) > 0.3, 'hill-road contours must wind rather than form a straight-sided stadium');
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1]!, to = path[index]!;
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const count = Math.max(1, Math.ceil(length / 0.05));
      let previous = beverlyElevationAt(from);
      for (let sample = 1; sample <= count; sample += 1) {
        const ratio = sample / count;
        const height = beverlyElevationAt([from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio]);
        assert.ok(Math.abs(height - previous) / (length * 1000 / count) <= 0.08);
        previous = height;
      }
    }
  }
});
