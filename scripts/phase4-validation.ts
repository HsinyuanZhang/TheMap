import assert from 'node:assert/strict';
import { booleanIntersects, booleanWithin } from '@turf/turf';
import type { Feature, LineString, Polygon } from 'geojson';
import { distanceToSegment, pointInRing } from '../data/geometry';
import { beverlyElevationAt } from '../data/generate';
import { nodeRoads } from '../data/phase4-network';
import { districts, parks, urbanGrid, type RoadDefinition, type XY } from '../data/source';
import type { Dataset } from '../src/dataset-loader';

const sx = 111.32 * Math.cos(40 * Math.PI / 180);
const local = (p: number[]): XY => [(p[0]! + 150) * sx, (p[1]! - 40) * 110.574];
const key = (p: XY): string => p.map(v => v.toFixed(7)).join(',');
const distance = (p: XY, path: readonly XY[]): number => Math.min(...path.slice(1).map((b, i) => distanceToSegment(p, path[i]!, b)));
export function isManhattanGridIntersection(a: XY, b: XY, c: XY): boolean {
  const grid = urbanGrid.grid, precision = Math.hypot(sx, 110.574) * 1e-6;
  if (b[0] < grid.west || b[0] > grid.east || b[1] < grid.south || b[1] > 9.15
    || !pointInRing(b, districts.find(d => d.id === 'manhattan')!.ring)
    || parks.some(park => pointInRing(b, park.ring))) return false;
  const onGrid = (value: number, origin: number, step: number): boolean => Math.abs(value - origin - Math.round((value - origin) / step) * step) <= precision;
  if (!onGrid(b[0], grid.west + grid.blockWidth + (grid.stepX - grid.blockWidth) / 2, grid.stepX)
    || !onGrid(b[1], grid.south + grid.blockDepth + (grid.stepY - grid.blockDepth) / 2, grid.stepY)) return false;
  const horizontal = (p: XY, q: XY): boolean => Math.abs(p[1] - q[1]) <= precision && Math.abs(p[0] - q[0]) > precision;
  const vertical = (p: XY, q: XY): boolean => Math.abs(p[0] - q[0]) <= precision && Math.abs(p[1] - q[1]) > precision;
  return horizontal(a, b) && vertical(b, c) || vertical(a, b) && horizontal(b, c);
}

export function maximumTurn(path: readonly XY[], exceptGrid = false): number {
  let maximum = 0;
  for (let i = 1; i < path.length - 1; i++) {
    if (exceptGrid && isManhattanGridIntersection(path[i - 1]!, path[i]!, path[i + 1]!)) continue;
    const a = path[i - 1]!, b = path[i]!, c = path[i + 1]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const scale = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (!scale) continue;
    maximum = Math.max(maximum, Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / scale))) * 180 / Math.PI);
  }
  return maximum;
}

export function validatePhase4Data(data: ReadonlyMap<string, Dataset>): void {
  const get = (name: string): Dataset => { const value = data.get(name); assert.ok(value, `${name} dataset required`); return value; };
  const districtData = get('districts');
  assert.equal(districtData.features.length, 9);
  const blocks = get('blocks'), buildings = get('buildings');
  assert.ok(!blocks.features.some(f => f.properties?.kind === 'superblock'), 'obsolete superblocks must not be exported');
  assert.ok(!buildings.features.some(f => ['villa', 'town-house', 'warehouse', 'uptown-support'].includes(String(f.properties?.kind))),
    'non-Manhattan individual buildings must be replaced by surface symbols');
  const manhattan = districtData.features.find(f => f.properties?.id === 'manhattan') as Feature<Polygon>;
  for (const building of buildings.features) if (building.properties?.id === undefined) {
    assert.ok(booleanWithin(building as Feature<Polygon>, manhattan), 'ordinary building geometry must stay in Manhattan');
  }
  const roadData = get('roads');
  const roads: RoadDefinition[] = roadData.features.map(f => ({
    id: String(f.properties?.id), name: String(f.properties?.name), roadClass: f.properties?.class as RoadDefinition['roadClass'],
    width: Number(f.properties?.width), coordinates: (f.geometry as LineString).coordinates.map(local),
  }));
  const arterials = roads.filter(r => r.roadClass === 'arterial');
  assert.ok(arterials.length >= 12 && arterials.length <= 20, `arterial count ${arterials.length} must be 12–20`);
  const boundaries = get('boundaries').features.filter(f => f.properties?.kind !== 'north-border');
  for (const f of boundaries) {
    const path = (f.geometry as LineString).coordinates.map(local);
    let run = 0, direction: XY | undefined;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const next: XY = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      if (!direction || Math.abs(direction[0] * next[1] - direction[1] * next[0]) > 0.00001) { run = 0; direction = next; }
      run += length;
      assert.ok(run <= 2, `${f.properties?.id}: boundary straight run ${run.toFixed(3)} km exceeds 2 km`);
    }
  }
  for (const road of roads) {
    const turn = maximumTurn(road.coordinates, true);
    assert.ok(turn <= 12, `${road.id}: road turn ${turn.toFixed(3)}° exceeds 12°`);
  }
  const noded = nodeRoads(roads);
  for (const road of noded) {
    const original = roads.find(r => r.id === road.id)!;
    const vertices = new Set(original.coordinates.map(key));
    assert.ok(road.coordinates.every(p => vertices.has(key(p))), `${road.id}: exported intersection is missing a shared vertex`);
  }
  for (const road of arterials) for (const p of [road.coordinates[0]!, road.coordinates.at(-1)!]) {
    const attached = roads.some(other => other.id !== road.id && other.coordinates.some(q => key(q) === key(p)));
    const onBoundary = boundaries.some(f => distance(p, (f.geometry as LineString).coordinates.map(local)) <= 0.00015)
      || districts.some(d => distance(p, d.ring) <= 0.00015);
    assert.ok(attached || onBoundary, `${road.id}: arterial endpoint ${p} must meet another road or district boundary`);
  }
  const lines = get('metro_lines'), stations = get('metro_stations');
  let stationGap = 0, metroTurn = 0, u2Gap = Infinity;
  for (const line of lines.features) {
    const path = (line.geometry as LineString).coordinates.map(local);
    const turn = maximumTurn(path);
    metroTurn = Math.max(metroTurn, turn);
    assert.ok(turn <= 12, `${line.properties?.id}: metro turn ${turn.toFixed(3)}° exceeds 12°`);
    let previousIndex = -1;
    for (const id of String(line.properties?.stations).split(',')) {
      const station = stations.features.find(f => f.properties?.id === id);
      assert.ok(station?.geometry.type === 'Point');
      const p = local(station.geometry.coordinates), gap = distance(p, path);
      stationGap = Math.max(stationGap, gap);
      assert.ok(gap < 0.005, `${id}: station gap ${(gap * 1000).toFixed(2)} m must be below 5 m`);
      const index = path.reduce((best, q, i) => Math.hypot(q[0] - p[0], q[1] - p[1])
        < Math.hypot(path[best]![0] - p[0], path[best]![1] - p[1]) ? i : best, 0);
      assert.ok(index > previousIndex, `${line.properties?.id}: station traversal order changed`);
      previousIndex = index;
    }
    if (line.properties?.id !== 'U2') continue;
    const beverly = districts.find(d => d.id === 'beverly')!;
    const a2 = roads.find(r => r.id === 'A2')!;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.025));
      for (let sample = 0; sample <= count; sample++) {
        const t = sample / count, p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (!pointInRing(p, beverly.ring)) continue;
        u2Gap = Math.min(u2Gap, distance(p, a2.coordinates));
        assert.ok(beverlyElevationAt(p) < 40, 'Beverly U2 must stay below 40 m');
      }
    }
  }
  assert.ok(u2Gap >= 0.4, `Beverly U2/A2 separation ${(u2Gap * 1000).toFixed(2)} m must be at least 400 m`);
  const surfaces = get('surface');
  const airport = surfaces.features.find(f => f.properties?.kind === 'airport') as Feature<Polygon>;
  assert.ok(airport, 'airport surface required');
  const harlem = districtData.features.find(f => f.properties?.id === 'harlem') as Feature<Polygon>;
  assert.ok(booleanWithin(airport, harlem), 'airport must be entirely inside Harlem');
  for (const road of roadData.features) if (road.properties?.id !== 'airport-access') assert.ok(!booleanIntersects(airport, road), `${road.properties?.id}: road enters airport`);
  for (const line of lines.features) assert.ok(!booleanIntersects(airport, line), 'metro must avoid airport');
  for (const station of stations.features) assert.ok(!booleanIntersects(airport, station), 'station must avoid airport');
  for (const building of buildings.features) if (building.properties?.id !== 'airport') assert.ok(!booleanIntersects(airport, building), 'ordinary building enters airport');
  const runways = surfaces.features.filter(f => f.properties?.kind === 'runway');
  assert.equal(runways.length, 2);
  const directions = runways.map(f => {
    const ring = (f.geometry as Polygon).coordinates[0]!.map(local);
    const edges = ring.slice(1).map((p, i) => ({ dx: p[0] - ring[i]![0], dy: p[1] - ring[i]![1] }));
    edges.sort((a, b) => Math.hypot(b.dx, b.dy) - Math.hypot(a.dx, a.dy));
    const e = edges[0]!, length = Math.hypot(e.dx, e.dy);
    assert.ok(length >= 3.2 && length <= 3.6, 'runway length must be 3.2–3.6 km');
    return Math.atan2(e.dy, e.dx);
  });
  assert.ok(Math.abs(Math.sin(directions[0]! - directions[1]!)) < 0.0001, 'runways must be parallel after export');
  for (const [kind, count] of [['airport-apron', 1], ['airport-taxiway', 2], ['airport-pier', 3], ['airport-aircraft', 6]] as const) {
    const parts = surfaces.features.filter(f => f.properties?.kind === kind);
    assert.equal(parts.length, count);
    for (const part of parts) assert.ok(booleanWithin(part as Feature<Polygon>, airport));
  }
  const airportBuildings = buildings.features.filter(f => f.properties?.id === 'airport');
  assert.deepEqual(airportBuildings.map(f => f.properties?.top).sort(), [30, 60]);
  for (const building of airportBuildings) assert.ok(booleanWithin(building as Feature<Polygon>, airport));
  const governor = get('pois').features.find(f => f.properties?.id === 'old-governors-house');
  assert.ok(governor?.geometry.type === 'Point');
  const p = local(governor.geometry.coordinates);
  assert.ok(pointInRing(p, districts.find(d => d.id === 'beverly')!.ring) && beverlyElevationAt(p) >= 40);
  console.log(`Section 12: ${arterials.length} connected arterials; metro max turn ${metroTurn.toFixed(2)}°; station gap ${(stationGap * 1000).toFixed(2)} m; Beverly U2/A2 ${(u2Gap * 1000).toFixed(2)} m; airport and boundary checks passed.`);
}
