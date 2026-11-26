import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { area, booleanIntersects, booleanWithin } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson';
import { beverlyHills, districts as sourceDistricts, reserveTownCenters } from '../data/source';
import { beverlyElevationAt } from '../data/generate';
import { distanceToSegment } from '../data/geometry';
import { assertNoPositiveAreaOverlap } from '../scripts/data-invariants';

type Properties = Record<string, string | number | boolean>;
type DataFeature = Feature<Geometry, Properties>;
type PolygonFeature = Feature<Polygon, Properties>;
type XY = readonly [number, number];

const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;
const localPosition = ([longitude, latitude]: Position): XY => [
  (longitude! + 150) * longitudeScale,
  (latitude! - 40) * latitudeScale,
];

async function readCollection(name: string): Promise<FeatureCollection<Geometry, Properties>> {
  return JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8')) as FeatureCollection<Geometry, Properties>;
}

function positions(geometry: Geometry): Position[] {
  const output: Position[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      output.push(value as Position);
      return;
    }
    for (const child of value) visit(child);
  };
  if (geometry.type === 'GeometryCollection') geometry.geometries.forEach((item) => output.push(...positions(item)));
  else visit(geometry.coordinates);
  return output;
}

function bounds(feature: DataFeature): { minX: number; maxX: number; minY: number; maxY: number; width: number; depth: number; center: XY } {
  const vertices = positions(feature.geometry!).map(localPosition);
  const minX = Math.min(...vertices.map(([x]) => x));
  const maxX = Math.max(...vertices.map(([x]) => x));
  const minY = Math.min(...vertices.map(([, y]) => y));
  const maxY = Math.max(...vertices.map(([, y]) => y));
  return { minX, maxX, minY, maxY, width: maxX - minX, depth: maxY - minY, center: [(minX + maxX) / 2, (minY + maxY) / 2] };
}


function roadDistance(position: XY, road: DataFeature): number {
  if (road.geometry?.type !== 'LineString') return Number.POSITIVE_INFINITY;
  const path = road.geometry.coordinates.map(localPosition);
  return Math.min(...path.slice(1).map((next, index) => distanceToSegment(position, path[index]!, next)));
}

function maximumStraightRun(path: readonly XY[]): number {
  const coordinateCellDiagonal = Math.hypot(111.32 * Math.cos(40 * Math.PI / 180) * 1e-6, 110.574e-6);
  let longest = 0;
  let run = 0;
  let previous: XY | undefined;
  let previousLength = 0;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]!;
    const end = path[index]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (previous) {
      const previousDx = start[0] - previous[0];
      const previousDy = start[1] - previous[1];
      const cross = Math.abs(previousDx * dy - previousDy * dx);
      const dot = previousDx * dx + previousDy * dy;
      if (dot > 0 && cross / previousLength <= coordinateCellDiagonal) run += length;
      else {
        longest = Math.max(longest, run);
        run = length;
      }
    } else {
      run = length;
    }
    longest = Math.max(longest, run);
    previous = start;
    previousLength = length;
  }
  return longest;
}

function maximumNetworkStraightRun(roads: readonly DataFeature[]): number {
  interface Segment {
    id: string;
    startKey: string;
    endKey: string;
    start: XY;
    end: XY;
    length: number;
  }
  const segments = new Map<string, Segment>();
  const byVertex = new Map<string, Segment[]>();
  for (const road of roads) {
    if (road.geometry?.type !== 'LineString') continue;
    const coordinates = road.geometry.coordinates;
    for (let index = 1; index < coordinates.length; index += 1) {
      const startCoordinate = coordinates[index - 1]!;
      const endCoordinate = coordinates[index]!;
      const startKey = `${startCoordinate[0]},${startCoordinate[1]}`;
      const endKey = `${endCoordinate[0]},${endCoordinate[1]}`;
      if (startKey === endKey) continue;
      const id = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
      if (segments.has(id)) continue;
      const start = localPosition(startCoordinate);
      const end = localPosition(endCoordinate);
      const segment = { id, startKey, endKey, start, end, length: Math.hypot(end[0] - start[0], end[1] - start[1]) };
      segments.set(id, segment);
      byVertex.set(startKey, [...(byVertex.get(startKey) ?? []), segment]);
      byVertex.set(endKey, [...(byVertex.get(endKey) ?? []), segment]);
    }
  }
  const coordinateCellDiagonal = Math.hypot(longitudeScale * 1e-6, latitudeScale * 1e-6);
  let longest = 0;
  const extend = (
    vertex: string,
    previousX: number,
    previousY: number,
    previousLength: number,
    length: number,
    used: ReadonlySet<string>,
  ): void => {
    longest = Math.max(longest, length);
    for (const segment of byVertex.get(vertex) ?? []) {
      if (used.has(segment.id)) continue;
      const forward = segment.startKey === vertex;
      const nextVertex = forward ? segment.endKey : segment.startKey;
      const dx = forward ? segment.end[0] - segment.start[0] : segment.start[0] - segment.end[0];
      const dy = forward ? segment.end[1] - segment.start[1] : segment.start[1] - segment.end[1];
      const cross = Math.abs(previousX * dy - previousY * dx);
      if (previousX * dx + previousY * dy <= 0 || cross / previousLength > coordinateCellDiagonal) continue;
      extend(nextVertex, previousX, previousY, previousLength, length + segment.length, new Set([...used, segment.id]));
    }
  };
  for (const segment of segments.values()) {
    const dx = segment.end[0] - segment.start[0];
    const dy = segment.end[1] - segment.start[1];
    extend(segment.endKey, dx, dy, segment.length, segment.length, new Set([segment.id]));
    extend(segment.startKey, -dx, -dy, segment.length, segment.length, new Set([segment.id]));
  }
  return longest;
}

function roadsTouch(first: DataFeature, second: DataFeature): boolean {
  return booleanIntersects(first, second);
}

function reachableRoads(start: DataFeature, roads: readonly DataFeature[]): Set<DataFeature> {
  const reached = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const current = pending.pop()!;
    for (const candidate of roads) {
      if (!reached.has(candidate) && roadsTouch(current, candidate)) {
        reached.add(candidate);
        pending.push(candidate);
      }
    }
  }
  return reached;
}

test('Beverly and Reserve data meet terrain, land-use, town, and road-graph constraints', async () => {
  const [districtCollection, roadsCollection, surfaceCollection, blockCollection, buildingCollection, terrainCollection] = await Promise.all([
    readCollection('districts'), readCollection('roads'), readCollection('surface'), readCollection('blocks'),
    readCollection('buildings'), readCollection('terrain'),
  ]);
  const districtById = new Map(districtCollection.features.map((feature) => [String(feature.properties?.id), feature as PolygonFeature]));
  const reserve = districtById.get('reserve')!;
  const beverly = districtById.get('beverly')!;
  const surfaces = surfaceCollection.features as PolygonFeature[];
  const woods = surfaces.filter((feature) => feature.properties?.kind === 'wood');
  const reserveWoods = woods.filter((feature) => feature.properties?.sector === 'reserve');
  const beverlyWoods = woods.filter((feature) => feature.properties?.sector === 'beverly');
  const farms = surfaces.filter((feature) => feature.properties?.kind === 'farm');
  const towns = (blockCollection.features as PolygonFeature[]).filter((feature) => feature.properties?.kind === 'town');
  const buildings = buildingCollection.features as PolygonFeature[];
  const roads = roadsCollection.features as DataFeature[];
  const areaKm2 = (feature: DataFeature): number => area(feature) / 1_000_000;
  const reserveArea = areaKm2(reserve);
  const beverlyArea = areaKm2(beverly);
  const reserveWoodArea = reserveWoods.reduce((sum, feature) => sum + areaKm2(feature), 0);
  const beverlyWoodArea = beverlyWoods.reduce((sum, feature) => sum + areaKm2(feature), 0);
  const farmArea = farms.reduce((sum, feature) => sum + areaKm2(feature), 0);
  let minimumFarmSide = Number.POSITIVE_INFINITY;
  let maximumFarmSide = 0;

  const assertWoodShapeVariation = (patches: PolygonFeature[]): void => {
    for (let first = 0; first < patches.length; first += 1) {
      const ring = patches[first]!.geometry.coordinates[0]!;
      assert.ok(ring.length >= 100, 'woods must export smooth, high-resolution outlines');
      const local = ring.slice(0, -1).map(localPosition);
      const center: XY = [
        local.reduce((sum, [x]) => sum + x, 0) / local.length,
        local.reduce((sum, [, y]) => sum + y, 0) / local.length,
      ];
      const radiusX = Math.max(...local.map(([x]) => Math.abs(x - center[0])));
      const radiusY = Math.max(...local.map(([, y]) => Math.abs(y - center[1])));
      const normalizedRadii = local.map(([x, y]) => Math.hypot((x - center[0]) / radiusX, (y - center[1]) / radiusY));
      const meanRadius = normalizedRadii.reduce((sum, radius) => sum + radius, 0) / normalizedRadii.length;
      const radiusVariation = Math.sqrt(normalizedRadii.reduce((sum, radius) => sum + (radius - meanRadius) ** 2, 0)
        / normalizedRadii.length) / meanRadius;
      assert.ok(radiusVariation > 0.035, 'woods must not be circular copies');
      for (let second = first + 1; second < patches.length; second += 1) {
        assertNoPositiveAreaOverlap(patches[first]!, patches[second]!, 'wood patches must not overlap');
      }
    }
    const patchAreas = patches.map(areaKm2);
    const meanArea = patchAreas.reduce((sum, value) => sum + value, 0) / patchAreas.length;
    const areaVariation = Math.sqrt(patchAreas.reduce((sum, value) => sum + (value - meanArea) ** 2, 0)
      / patchAreas.length) / meanArea;
    assert.ok(areaVariation > 0.05, 'wood patches must vary in size');
  };

  assert.equal(reserveWoods.length, 7);
  assert.equal(beverlyWoods.length, beverlyHills.length);
  assertWoodShapeVariation(reserveWoods);
  assertWoodShapeVariation(beverlyWoods);
  assert.ok(reserveWoodArea / reserveArea >= 0.3 && reserveWoodArea / reserveArea <= 0.4);
  assert.ok(reserveWoods.every((feature) => areaKm2(feature) >= 0.3));
  assert.ok(reserveWoods.filter((feature) => areaKm2(feature) > 5).length >= 3);
  const reserveWoodCenters = reserveWoods.map((feature) => bounds(feature).center);
  assert.ok(reserveWoodCenters.some(([x, y]) => x < 28 && y > 25));
  assert.ok(reserveWoodCenters.some(([x]) => x >= 28));
  assert.ok(beverlyWoodArea / beverlyArea >= 0.35 && beverlyWoodArea / beverlyArea <= 0.5);

  assert.ok(farms.length >= 1000 && farms.length <= 2000);
  assert.ok(farmArea / reserveArea >= 0.45 && farmArea / reserveArea <= 0.55);
  assert.ok(farms.every((feature) => Number.isInteger(feature.properties?.tone)
    && Number(feature.properties?.tone) >= 0 && Number(feature.properties?.tone) <= 3));
  const quadrilaterals = farms.filter((feature) => feature.geometry.coordinates[0]?.length === 5);
  assert.ok(quadrilaterals.length / farms.length <= 0.3);
  const farmIndex = new Map<string, PolygonFeature[]>();
  const farmCellSize = 0.5;
  for (const farm of farms) {
    assert.ok(booleanWithin(farm, reserve));
    const farmBounds = bounds(farm);
    const { width, depth } = farmBounds;
    minimumFarmSide = Math.min(minimumFarmSide, width, depth);
    maximumFarmSide = Math.max(maximumFarmSide, width, depth);
    assert.ok(width >= 0.15 && width <= 0.6 && depth >= 0.15 && depth <= 0.6);
    const keys: string[] = [];
    for (let x = Math.floor(farmBounds.minX / farmCellSize); x <= Math.floor(farmBounds.maxX / farmCellSize); x += 1) {
      for (let y = Math.floor(farmBounds.minY / farmCellSize); y <= Math.floor(farmBounds.maxY / farmCellSize); y += 1) keys.push(`${x}:${y}`);
    }
    const candidates = new Set(keys.flatMap((key) => farmIndex.get(key) ?? []));
    for (const previous of candidates) assertNoPositiveAreaOverlap(farm, previous, 'farm Voronoi cells overlap');
    for (const key of keys) farmIndex.set(key, [...(farmIndex.get(key) ?? []), farm]);
    for (const wood of woods) assertNoPositiveAreaOverlap(farm, wood, 'farm and woods overlap');
    for (const town of towns) assertNoPositiveAreaOverlap(farm, town, 'farm and town overlap');
  }
  for (const town of towns) for (const wood of woods) assertNoPositiveAreaOverlap(town, wood, 'town and woods overlap');

  assert.equal(towns.length, reserveTownCenters.length);
  assert.deepEqual(towns.map((town) => String(town.properties?.town_id)).sort(), reserveTownCenters.map((town) => town.id).sort());
  assert.ok(reserveTownCenters.filter((town) => town.position[0] >= 28).length >= 3);
  for (let first = 0; first < reserveTownCenters.length; first += 1) {
    for (let second = first + 1; second < reserveTownCenters.length; second += 1) {
      assert.ok(Math.hypot(reserveTownCenters[first]!.position[0] - reserveTownCenters[second]!.position[0],
        reserveTownCenters[first]!.position[1] - reserveTownCenters[second]!.position[1]) >= 3);
    }
  }
  assert.ok(!buildings.some((item) => ['villa', 'town-house'].includes(String(item.properties?.kind))));
  for (const town of towns) assert.ok(areaKm2(town) >= 0.3 && areaKm2(town) <= 0.9);
  const hillRoads = roads.filter((road) => road.properties?.class === 'hillroad');
  const hillRoadIds = new Set(hillRoads.map((road) => String(road.properties?.id).replace(/-part-\d+$/, '').replace(/-\d+$/, '')));
  assert.ok(hillRoadIds.size >= 8 && hillRoadIds.size <= 12);
  const maximumHillNetworkStraightRun = maximumNetworkStraightRun(hillRoads);
  assert.ok(maximumHillNetworkStraightRun <= 0.6 + 0.00014,
    `exported hill-road network has a straight run of ${(maximumHillNetworkStraightRun * 1000).toFixed(1)} m`);
  const mainRoads = roads.filter((road) => ['motorway', 'arterial'].includes(String(road.properties?.class)));
  const a2 = mainRoads.find((road) => road.properties?.id === 'A2');
  const a3 = mainRoads.find((road) => road.properties?.id === 'A3');
  assert.ok(a2 && a3);
  const hillGraph = reachableRoads(a2, [...hillRoads, ...mainRoads]);
  assert.ok(hillRoads.every((road) => hillGraph.has(road)));
  assert.ok(hillGraph.has(a3));
  let maxGrade = 0;
  let maxGradeRoad = '';
  let maxRoadSegment = 0;
  let totalHillRoadLength = 0;
  for (const road of hillRoads) {
    assert.equal(road.properties?.name, '');
    assert.ok(Math.abs(Number(road.properties?.width) - 0.012) < 1e-8);
    assert.ok(road.geometry?.type === 'LineString');
    const path = road.geometry.coordinates.map(localPosition);
    for (let segment = 1; segment < path.length; segment += 1) {
      const start = path[segment - 1]!;
      const end = path[segment]!;
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      maxRoadSegment = Math.max(maxRoadSegment, length);
      totalHillRoadLength += length;
      assert.ok(length <= 0.6);
      const steps = Math.max(1, Math.ceil(length / 0.05));
      let previous = beverlyElevationAt(start);
      for (let step = 1; step <= steps; step += 1) {
        const current: XY = [start[0] + (end[0] - start[0]) * step / steps,
          start[1] + (end[1] - start[1]) * step / steps];
        const elevation = beverlyElevationAt(current);
        const grade = Math.abs(elevation - previous) / (length * 1000 / steps);
        if (grade > maxGrade) {
          maxGrade = grade;
          maxGradeRoad = String(road.properties?.id);
        }
        previous = elevation;
      }
    }
    assert.ok(maximumStraightRun(path) <= 0.6 + 0.00014,
      `hill road ${road.properties?.id} has a straight run longer than 600 m`);
  }
  assert.ok(maxGrade <= 0.08, `maximum sampled grade ${(maxGrade * 100).toFixed(2)}% on ${maxGradeRoad}`);
  assert.ok([...hillRoadIds].some((id) => id.startsWith('hillroad-contour-')));

  const ruralRoads = roads.filter((road) => road.properties?.class === 'rural');
  assert.ok(ruralRoads.length >= 40);
  const ruralGraph = [...ruralRoads, ...mainRoads];
  for (const sourceTown of reserveTownCenters) {
    const nearestTown = reserveTownCenters.filter((town) => town.id !== sourceTown.id)
      .map((town) => ({ town, distance: Math.hypot(town.position[0] - sourceTown.position[0], town.position[1] - sourceTown.position[1]) }))
      .sort((first, second) => first.distance - second.distance)[0]!.town;
    const pairId = `rural-link-${[sourceTown.id, nearestTown.id].sort().join(':').replace(':', '-')}`;
    const townLink = ruralRoads.find((road) => road.properties?.id === pairId);
    const access = ruralRoads.find((road) => road.properties?.id === `rural-highway-${sourceTown.id}`);
    assert.ok(townLink?.geometry?.type === 'LineString' && access?.geometry?.type === 'LineString');
    const townLinkEnds = [townLink.geometry.coordinates[0]!, townLink.geometry.coordinates.at(-1)!].map(localPosition);
    assert.ok(townLinkEnds.every((end) => [sourceTown.position, nearestTown.position]
      .some((center) => Math.hypot(end[0] - center[0], end[1] - center[1]) <= 0.003)));
    const accessStart = localPosition(access.geometry.coordinates[0]!);
    const accessEnd = localPosition(access.geometry.coordinates.at(-1)!);
    assert.ok(Math.hypot(accessStart[0] - sourceTown.position[0], accessStart[1] - sourceTown.position[1]) <= 0.003);
    const nearestMainRoad = mainRoads.map((road) => ({ road, distance: roadDistance(sourceTown.position, road) }))
      .sort((first, second) => first.distance - second.distance)[0]!.road;
    assert.ok(roadDistance(accessEnd, nearestMainRoad) <= 0.003);
    const connected = reachableRoads(access, ruralGraph);
    assert.ok(connected.has(nearestMainRoad) && connected.has(townLink));
  }

  const beverlyRing = sourceDistricts.find((district) => district.id === 'beverly')!.ring;
  let peak = 0;
  for (let x = 9; x <= 28; x += 0.1) for (let y = 0; y <= 9; y += 0.1) peak = Math.max(peak, beverlyElevationAt([x, y]));
  assert.ok(beverlyHills.length >= 5 && beverlyHills.length <= 8);
  assert.ok(peak >= 280 && peak <= 340);
  let maximumBoundaryElevation = 0;
  for (let segment = 1; segment < beverlyRing.length; segment += 1) {
    const start = beverlyRing[segment - 1]!;
    const end = beverlyRing[segment]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 0.05));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      const elevation = beverlyElevationAt([start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio]);
      maximumBoundaryElevation = Math.max(maximumBoundaryElevation, elevation);
      assert.ok(elevation < 40);
    }
  }
  let maximumCoastElevation = 0;
  for (let x = 9; x <= 28; x += 0.05) for (let y = 0; y < 2.8; y += 0.05) {
    const elevation = beverlyElevationAt([x, y]);
    maximumCoastElevation = Math.max(maximumCoastElevation, elevation);
    assert.ok(elevation < 40);
  }
  assert.ok([beverlyElevationAt([8.99, 5]), beverlyElevationAt([28.01, 5]), beverlyElevationAt([18, -0.01]),
    beverlyElevationAt([18, 9.01])].every((elevation) => elevation === 0));

  assert.ok(terrainCollection.features.some((feature) => feature.properties?.kind === 'band'));
  assert.ok(terrainCollection.features.some((feature) => feature.properties?.kind === 'contour'));
  assert.ok(terrainCollection.features.filter((feature) => feature.properties?.kind === 'band')
    .every((feature) => feature.geometry?.type === 'Polygon' && Number(feature.properties?.level) >= 0 && Number(feature.properties?.level) % 40 === 0));
  assert.ok(terrainCollection.features.filter((feature) => feature.properties?.kind === 'contour')
    .every((feature) => feature.geometry?.type === 'LineString' && Number(feature.properties?.level) > 0 && Number(feature.properties?.level) % 40 === 0));
  console.log(`Beverly: peak ${peak} m, boundary max ${maximumBoundaryElevation} m, coast max ${maximumCoastElevation} m, woods ${(beverlyWoodArea / beverlyArea * 100).toFixed(2)}%, ${hillRoadIds.size} hill roads ${totalHillRoadLength.toFixed(1)} km total, max grade ${(maxGrade * 100).toFixed(2)}%, max segment ${(maxRoadSegment * 1000).toFixed(1)} m, max straight run ${(maximumHillNetworkStraightRun * 1000).toFixed(1)} m.`);
  console.log(`Reserve: ${reserveWoods.length} woods patches ${(reserveWoodArea / reserveArea * 100).toFixed(2)}% (${reserveWoods.filter((feature) => areaKm2(feature) > 5).length} >5 km²), ${farms.length} Voronoi farms ${(farmArea / reserveArea * 100).toFixed(2)}%, field sides ${(minimumFarmSide * 1000).toFixed(1)}-${(maximumFarmSide * 1000).toFixed(1)} m, ${towns.length} town polygons, ${ruralRoads.length} rural roads.`);
});
