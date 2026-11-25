import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { area, booleanIntersects, booleanPointInPolygon, booleanWithin, point } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson';
import { beverlyHills, districts as sourceDistricts, reserveTownCenters } from '../data/source';
import { beverlyElevationAt, beverlySlopeAt } from '../data/generate';
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
const geographicPosition = ([x, y]: XY): Position => [
  -150 + x / longitudeScale,
  40 + y / latitudeScale,
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

function edgeLengths(feature: PolygonFeature): number[] {
  const ring = feature.geometry.coordinates[0]!.map(localPosition);
  return ring.slice(1).map((position, index) =>
    Math.hypot(position[0] - ring[index]![0], position[1] - ring[index]![1]),
  );
}

function roadDistance(position: XY, road: DataFeature): number {
  if (road.geometry?.type !== 'LineString') return Number.POSITIVE_INFINITY;
  const path = road.geometry.coordinates.map(localPosition);
  return Math.min(...path.slice(1).map((next, index) => distanceToSegment(position, path[index]!, next)));
}

function roadsTouch(first: DataFeature, second: DataFeature): boolean {
  if (booleanIntersects(first, second)) return true;
  if (first.geometry?.type !== 'LineString' || second.geometry?.type !== 'LineString') return false;
  const a = first.geometry.coordinates.map(localPosition);
  const b = second.geometry.coordinates.map(localPosition);
  const touches = (endpoints: XY[], line: XY[]): boolean =>
    endpoints.some((endpoint) => line.slice(1).some((next, index) => distanceToSegment(endpoint, line[index]!, next) <= 0.003));
  return touches([a[0]!, a.at(-1)!], b) || touches([b[0]!, b.at(-1)!], a);
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
  const [districtCollection, roadsCollection, surfaceCollection, blockCollection, buildingCollection, terrainCollection, overviewCollection] = await Promise.all([
    readCollection('districts'), readCollection('roads'), readCollection('surface'), readCollection('blocks'),
    readCollection('buildings'), readCollection('terrain'), readCollection('overview'),
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

  assert.ok(reserveWoods.length > 0 && beverlyWoods.length > 0);
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
  const townHouses = buildings.filter((building) => building.properties?.kind === 'town-house');
  const blocksById = new Map(blockCollection.features.map((block) => [String(block.properties?.block_id), block as PolygonFeature]));
  assert.ok(townHouses.length <= 2000);
  for (const town of towns) {
    assert.ok(areaKm2(town) >= 0.3 && areaKm2(town) <= 0.9);
    assert.equal(town.properties?.id, undefined);
    assert.equal(town.properties?.name, undefined);
    const sourceTown = reserveTownCenters.find((candidate) => candidate.id === town.properties?.town_id)!;
    assert.ok(booleanPointInPolygon(point(geographicPosition(sourceTown.position)), town));
    const houses = townHouses.filter((house) => house.properties?.block_id === town.properties?.block_id);
    assert.ok(houses.length >= 60 && houses.length <= 200);
    for (const house of houses) {
      assert.ok(booleanWithin(house, blocksById.get(String(house.properties?.block_id))!), 'town house must fit its town block');
      assert.ok(edgeLengths(house).every((length) => length >= 0.01 && length <= 0.025));
      assert.ok(Number(house.properties?.top) >= 5 && Number(house.properties?.top) <= 12);
      assert.equal(Number(house.properties?.key), 0);
      assert.equal(house.properties?.id, undefined);
      assert.equal(house.properties?.name, undefined);
    }
  }

  const hillRoads = roads.filter((road) => road.properties?.class === 'hillroad');
  const hillRoadIds = new Set(hillRoads.map((road) => String(road.properties?.id).replace(/-part-\d+$/, '').replace(/-\d+$/, '')));
  assert.ok(hillRoadIds.size >= 8 && hillRoadIds.size <= 12);
  const mainRoads = roads.filter((road) => ['motorway', 'arterial'].includes(String(road.properties?.class)));
  const a2 = mainRoads.find((road) => road.properties?.id === 'A2');
  const a3 = mainRoads.find((road) => road.properties?.id === 'A3');
  assert.ok(a2 && a3);
  const hillGraph = reachableRoads(a2, [...hillRoads, ...mainRoads]);
  assert.ok(hillRoads.every((road) => hillGraph.has(road)));
  assert.ok(hillGraph.has(a3));
  let maxGrade = 0;
  let maxRoadSegment = 0;
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
      assert.ok(length <= 0.6);
      const steps = Math.max(1, Math.ceil(length / 0.05));
      let previous = beverlyElevationAt(start);
      for (let step = 1; step <= steps; step += 1) {
        const current: XY = [start[0] + (end[0] - start[0]) * step / steps,
          start[1] + (end[1] - start[1]) * step / steps];
        const elevation = beverlyElevationAt(current);
        maxGrade = Math.max(maxGrade, Math.abs(elevation - previous) / (length * 1000 / steps));
        previous = elevation;
      }
    }
  }
  assert.ok(maxGrade <= 0.08);

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

  const villas = buildings.filter((building) => building.properties?.kind === 'villa');
  assert.ok(villas.length >= 1500 && villas.length <= 3000);
  let maximumVillaRoadDistance = 0;
  let minimumVillaElevation = Number.POSITIVE_INFINITY;
  let maximumVillaElevation = 0;
  let maximumVillaSlope = 0;
  for (const villa of villas) {
    const vertices = positions(villa.geometry!).map(localPosition);
    const { width, depth, center } = bounds(villa);
    assert.ok(edgeLengths(villa).every((length) => length >= 0.012 && length <= 0.028));
    assert.ok(Number(villa.properties?.top) >= 6 && Number(villa.properties?.top) <= 14);
    assert.equal(Number(villa.properties?.key), 0);
    assert.equal(Number(villa.properties?.base), 0);
    assert.ok([...vertices, center].every((position) => {
      const elevation = beverlyElevationAt(position);
      const slope = beverlySlopeAt(position);
      minimumVillaElevation = Math.min(minimumVillaElevation, elevation);
      maximumVillaElevation = Math.max(maximumVillaElevation, elevation);
      maximumVillaSlope = Math.max(maximumVillaSlope, slope);
      return elevation <= 240 && slope <= 0.3;
    }));
    const distance = Math.min(...hillRoads.map((road) => roadDistance(center, road))) + Math.hypot(width / 2, depth / 2);
    maximumVillaRoadDistance = Math.max(maximumVillaRoadDistance, distance);
    assert.ok(distance <= 0.09);
  }

  assert.ok(terrainCollection.features.some((feature) => feature.properties?.kind === 'band'));
  assert.ok(terrainCollection.features.some((feature) => feature.properties?.kind === 'contour'));
  assert.ok(terrainCollection.features.filter((feature) => feature.properties?.kind === 'band')
    .every((feature) => feature.geometry?.type === 'Polygon' && Number(feature.properties?.level) >= 0 && Number(feature.properties?.level) % 40 === 0));
  assert.ok(terrainCollection.features.filter((feature) => feature.properties?.kind === 'contour')
    .every((feature) => feature.geometry?.type === 'LineString' && Number(feature.properties?.level) > 0 && Number(feature.properties?.level) % 40 === 0));
  assert.ok(overviewCollection.features.every((feature) => ['wood', 'band'].includes(String(feature.properties?.kind))));
  const houseCounts = towns.map((town) => `${town.properties?.town_id}:${townHouses.filter((house) => house.properties?.block_id === town.properties?.block_id).length}`).join(',');
  console.log(`Beverly: peak ${peak} m, boundary max ${maximumBoundaryElevation} m, coast max ${maximumCoastElevation} m, woods ${(beverlyWoodArea / beverlyArea * 100).toFixed(2)}%, ${hillRoadIds.size} hill roads, max grade ${(maxGrade * 100).toFixed(2)}%, max segment ${(maxRoadSegment * 1000).toFixed(1)} m, ${villas.length} villas, elevation ${minimumVillaElevation}-${maximumVillaElevation} m, max slope ${(maximumVillaSlope * 100).toFixed(2)}%, max road distance ${(maximumVillaRoadDistance * 1000).toFixed(1)} m.`);
  console.log(`Reserve: ${reserveWoods.length} woods patches ${(reserveWoodArea / reserveArea * 100).toFixed(2)}% (${reserveWoods.filter((feature) => areaKm2(feature) > 5).length} >5 km²), ${farms.length} Voronoi farms ${(farmArea / reserveArea * 100).toFixed(2)}%, field sides ${(minimumFarmSide * 1000).toFixed(1)}-${(maximumFarmSide * 1000).toFixed(1)} m, ${towns.length} towns with ${townHouses.length} houses [${houseCounts}], ${ruralRoads.length} rural roads.`);
});
