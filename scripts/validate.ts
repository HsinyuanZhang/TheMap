import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { area, booleanIntersects, booleanPointInPolygon, booleanValid, booleanWithin, difference, intersect, point, union } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, LineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { beverlyHills, coastlineYAtX, districts as sourceDistricts, land as sourceLand, points as sourcePoints, reserveTownCenters, roads as sourceRoads, stations as sourceStations, transitLines as sourceTransitLines } from '../data/source';
import { beverlyElevationAt, beverlySlopeAt } from '../data/generate';
import { pointInRing } from '../data/geometry';
import { hasGroundFootprintAtBidTop, isNumericBuildingKey } from '../data/phase3-invariants';
import { normalizeProse, parseContentDocument } from '../src/content-format';
import { precisionSliverArea, validateDistrictTopology } from './district-topology';
import { assertMarkdownCoverage, collectClickableIds } from './content-links';
import {
  assertAreaCoverage, assertFinalTierTop, assertLabelCoverage, assertNoPositiveAreaOverlap,
  assertRoadClearance, assertTierContinuity, groupBuildingBidsWithinDistrict, polygonIntersectionArea,
  type Road,
} from './data-invariants';

type Properties = Record<string, string | number | boolean>;
type Collection = FeatureCollection<Geometry, Properties>;

const directory = resolve('public/data');
const placeDirectory = resolve('content/places');
const names = ['land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois', 'blocks', 'trees', 'labels', 'boundaries', 'surface', 'terrain', 'overview', 'atlas'] as const;
const expectedDistrictIds = ['manhattan', 'beverly', 'st-germain', 'harlem', 'uptown', 'brooklyn', 'fleet-port', 'reserve'];
const geometryByFile = {
  land: 'Polygon',
  districts: 'Polygon',
  parks: 'Polygon',
  roads: 'LineString',
  metro_lines: 'LineString',
  metro_stations: 'Point',
  buildings: 'Polygon',
  pois: 'Point',
  blocks: 'Polygon',
  trees: 'Polygon',
  labels: 'Point',
  boundaries: 'LineString',
  surface: 'Polygon',
  terrain: 'Polygon|LineString',
  overview: 'Polygon',
  atlas: 'Polygon|Point',
} as const;
const fixture = JSON.parse(await readFile(resolve('tests/transit.fixture.json'), 'utf8')) as Record<string, { color: string; stations: string[] }>;
validateDistrictTopology();

function validateProperties(name: string, feature: Feature<Geometry, Properties>): void {
  assert.ok(feature.properties && typeof feature.properties === 'object', `${name}: properties required`);
  for (const [key, value] of Object.entries(feature.properties)) {
    assert.ok(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)), `${name}.${key}: property must be a finite primitive`);
  }
  if (!feature.geometry) throw new Error(`${name}: missing geometry`);
  assert.ok(booleanValid(feature as Feature<Polygon, Properties>), `${name}: invalid geometry`);
}

function walkCoordinates(geometry: Geometry): Position[] {
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(walkCoordinates);
  const positions: Position[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      positions.push(value as Position);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return positions;
}

function requireString(properties: Properties, key: string, context: string): string {
  const value = properties[key];
  assert.equal(typeof value, 'string', `${context}: ${key} must be a string`);
  return value as string;
}

function localPosition(position: Position): [number, number] {
  return [
    (position[0]! + 150) * 111.32 * Math.cos((40 * Math.PI) / 180),
    (position[1]! - 40) * 110.574,
  ];
}

function geographicPosition([x, y]: readonly [number, number]): Position {
  return [
    Number((-150 + x / (111.32 * Math.cos((40 * Math.PI) / 180))).toFixed(6)),
    Number((40 + y / 110.574).toFixed(6)),
  ];
}

function distanceToSegment(
  [x, y]: readonly [number, number],
  [x1, y1]: readonly [number, number],
  [x2, y2]: readonly [number, number],
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + ratio * dx), y - (y1 + ratio * dy));
}

function roadFeaturesTouch(first: Feature<Geometry, Properties>, second: Feature<Geometry, Properties>): boolean {
  return booleanIntersects(first, second);
}

function roadDistanceFrom(position: readonly [number, number], road: Feature<Geometry, Properties>): number {
  if (road.geometry?.type !== 'LineString') return Number.POSITIVE_INFINITY;
  const path = road.geometry.coordinates.map(localPosition);
  return Math.min(...path.slice(1).map((next, index) => distanceToSegment(position, path[index]!, next)));
}

function roadGraphReachable(
  start: Feature<Geometry, Properties>,
  roads: readonly Feature<Geometry, Properties>[],
): Set<Feature<Geometry, Properties>> {
  const reached = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const candidate of roads) {
      if (!reached.has(candidate) && roadFeaturesTouch(current, candidate)) {
        reached.add(candidate);
        pending.push(candidate);
      }
    }
  }
  return reached;
}

const datasets = new Map<string, Collection>();
let totalBytes = 0;
for (const name of names) {
  const path = resolve(directory, `${name}.geojson`);
  const fileSize = (await stat(path)).size;
  totalBytes += fileSize;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Collection;
  assert.equal(parsed.type, 'FeatureCollection', `${name}: FeatureCollection required`);
  assert.ok(Array.isArray(parsed.features), `${name}: features array required`);
  const seenIds = new Set<string>();
  const buildingNames = new Map<string, string>();
  for (const [index, feature] of parsed.features.entries()) {
    assert.equal(feature.type, 'Feature', `${name}[${index}]: Feature required`);
    assert.ok(geometryByFile[name].split('|').includes(feature.geometry?.type ?? ''), `${name}[${index}]: wrong geometry type`);
    validateProperties(`${name}[${index}]`, feature);
    for (const position of walkCoordinates(feature.geometry!)) {
      assert.ok(position.every(Number.isFinite), `${name}[${index}]: coordinates must be finite`);
      for (const ordinate of position.slice(0, 2)) {
        assert.ok(Math.abs(ordinate * 1_000_000 - Math.round(ordinate * 1_000_000)) < 1e-7, `${name}[${index}]: coordinate precision exceeds six decimals`);
      }
    }
    const id = feature.properties?.id;
    if (typeof id === 'string') {
      if (name === 'buildings') {
        const buildingName = feature.properties?.name;
        assert.equal(typeof buildingName, 'string', `${name}: named building ID ${id} needs a name`);
        const existingName = buildingNames.get(id);
        if (existingName) assert.equal(buildingName, existingName, `${name}: inconsistent name for landmark ${id}`);
        else buildingNames.set(id, buildingName as string);
      } else {
        if (!(name === 'labels' && id === 'reserve')) assert.ok(!seenIds.has(id), `${name}: duplicate id ${id}`);
        seenIds.add(id);
      }
    }
  }
  datasets.set(name, parsed);
}
assert.ok(totalBytes <= 10 * 1024 * 1024, 'GeoJSON exceeds 10 MB');
assert.ok((await stat(resolve(directory, 'atlas.geojson'))).size <= 1_000_000, 'atlas exceeds its 1 MB raw budget');
assert.ok((await stat(resolve(directory, 'buildings.geojson'))).size <= 6 * 1024 * 1024, 'buildings.geojson exceeds 6 MB');
const rawFiles = await Promise.all(names.map((name) => readFile(resolve(directory, name + '.geojson'))));
const gzipBytes = rawFiles.reduce((sum, file) => sum + gzipSync(file).byteLength, 0);
const brotliBytes = rawFiles.reduce((sum, file) => sum + brotliCompressSync(file).byteLength, 0);
assert.ok(gzipBytes <= 2 * 1024 * 1024, 'gzip data budget exceeds 2 MB');
assert.ok(brotliBytes <= 2 * 1024 * 1024, 'Brotli data budget exceeds 2 MB');

const landCollection = datasets.get('land')!;
const districtCollection = datasets.get('districts')!;
const parkCollection = datasets.get('parks')!;
const roadCollection = datasets.get('roads')!;
const lineCollection = datasets.get('metro_lines')!;
const stationCollection = datasets.get('metro_stations')!;
const buildingCollection = datasets.get('buildings')!;
const poiCollection = datasets.get('pois')!;
const roadCellSize = 0.25;
const roadSpatialIndex = new Map<string, Road[]>();
const cellKey = (x: number, y: number) => `${x}:${y}`;
for (const road of roadCollection.features) {
  if (road.geometry?.type !== 'LineString') continue;
  const width = Number(road.properties?.width);
  for (let index = 1; index < road.geometry.coordinates.length; index += 1) {
    const coordinates = [
      localPosition(road.geometry.coordinates[index - 1]!),
      localPosition(road.geometry.coordinates[index]!),
    ] as const;
    const segment: Road = { coordinates, width };
    const minX = Math.floor((Math.min(coordinates[0][0], coordinates[1][0]) - width / 2) / roadCellSize);
    const maxX = Math.floor((Math.max(coordinates[0][0], coordinates[1][0]) + width / 2) / roadCellSize);
    const minY = Math.floor((Math.min(coordinates[0][1], coordinates[1][1]) - width / 2) / roadCellSize);
    const maxY = Math.floor((Math.max(coordinates[0][1], coordinates[1][1]) + width / 2) / roadCellSize);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = cellKey(x, y);
        const bucket = roadSpatialIndex.get(key) ?? [];
        bucket.push(segment);
        roadSpatialIndex.set(key, bucket);
      }
    }
  }
}

function nearbyRoadSegments(ring: readonly [number, number][]): Road[] {
  const minX = Math.floor(Math.min(...ring.map((point) => point[0])) / roadCellSize);
  const maxX = Math.floor(Math.max(...ring.map((point) => point[0])) / roadCellSize);
  const minY = Math.floor(Math.min(...ring.map((point) => point[1])) / roadCellSize);
  const maxY = Math.floor(Math.max(...ring.map((point) => point[1])) / roadCellSize);
  const candidates = new Set<Road>();
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (const road of roadSpatialIndex.get(cellKey(x, y)) ?? []) candidates.add(road);
    }
  }
  return [...candidates];
}

const featureById = (collection: Collection, id: string) => collection.features.find((feature) => feature.properties?.id === id);
for (const feature of landCollection.features) {
  const kind = requireString(feature.properties!, 'kind', 'land');
  assert.ok(['monaco', 'ottoman', 'east-region'].includes(kind), `land: unsupported kind ${kind}`);
  if (kind !== 'monaco') {
    requireString(feature.properties!, 'id', 'neighbor land');
    requireString(feature.properties!, 'name', 'neighbor land');
  }
}

const districtIds = districtCollection.features.map((feature) => requireString(feature.properties!, 'id', 'district'));
assert.deepEqual([...districtIds].sort(), [...expectedDistrictIds].sort(), 'all eight specified districts must exist');
for (const feature of districtCollection.features) {
  requireString(feature.properties!, 'name', 'district');
  assert.ok(['urban', 'military', 'reserve'].includes(requireString(feature.properties!, 'kind', 'district')));
}
const monaco = landCollection.features.find((feature) => feature.properties?.kind === 'monaco') as Feature<Polygon, Properties> | undefined;
assert.ok(monaco, 'Monaco land polygon required');
const monacoRing = monaco.geometry.coordinates[0]!.map(localPosition);
for (const feature of districtCollection.features) {
  const district = feature as Feature<Polygon, Properties>;
  const outsideDistrict = difference({
    type: 'FeatureCollection',
    features: [district, monaco],
  });
  if (outsideDistrict) precisionSliverArea(outsideDistrict.geometry, `district ${String(feature.properties?.id)} outside Monaco`);
}
let overlappingDistrictArea = 0;
for (let first = 0; first < districtCollection.features.length; first += 1) {
  for (let second = first + 1; second < districtCollection.features.length; second += 1) {
    const overlap = intersect({
      type: 'FeatureCollection',
      features: [
        districtCollection.features[first] as Feature<Polygon, Properties>,
        districtCollection.features[second] as Feature<Polygon, Properties>,
      ],
    });
    if (!overlap) continue;
    const firstId = String(districtCollection.features[first]!.properties?.id);
    const secondId = String(districtCollection.features[second]!.properties?.id);
    overlappingDistrictArea += precisionSliverArea(overlap.geometry, `${firstId}/${secondId} district overlap`);
  }
}
let districtUnion: Feature<Polygon | MultiPolygon> = districtCollection.features[0] as Feature<Polygon, Properties>;
for (const district of districtCollection.features.slice(1)) {
  const merged = union({ type: 'FeatureCollection', features: [districtUnion, district as Feature<Polygon, Properties>] });
  assert.ok(merged, 'district polygons must form a nonempty union');
  districtUnion = merged;
}
const uncovered = difference({ type: 'FeatureCollection', features: [monaco as Feature<Polygon, Properties>, districtUnion] });
const outside = difference({ type: 'FeatureCollection', features: [districtUnion, monaco as Feature<Polygon, Properties>] });
const uncoveredArea = uncovered ? precisionSliverArea(uncovered.geometry, 'uncovered Monaco land') : 0;
const outsideArea = outside ? precisionSliverArea(outside.geometry, 'district land outside Monaco') : 0;
const districtArea = districtCollection.features.reduce((sum, feature) => sum + area(feature as Feature<Polygon, Properties>), 0);
assert.ok(Math.abs(districtArea - area(monaco)) <= overlappingDistrictArea + uncoveredArea + outsideArea + 0.001,
  'districts must cover Monaco with only coordinate-precision overlap and boundary slivers');
for (let first = 0; first < landCollection.features.length; first += 1) {
  for (let second = first + 1; second < landCollection.features.length; second += 1) {
    assert.equal(intersect({
      type: 'FeatureCollection',
      features: [
        landCollection.features[first] as Feature<Polygon, Properties>,
        landCollection.features[second] as Feature<Polygon, Properties>,
      ],
    }), null, 'neighbor land polygon interiors must not overlap');
  }
}

for (const feature of parkCollection.features) {
  requireString(feature.properties!, 'id', 'park');
  requireString(feature.properties!, 'name', 'park');
}
const namedArterials = new Set<string>();
for (const feature of roadCollection.features) {
  requireString(feature.properties!, 'id', 'road');
  const roadClass = requireString(feature.properties!, 'class', 'road');
  assert.ok(['motorway', 'arterial', 'local', 'hillroad', 'rural'].includes(roadClass), `invalid road class ${roadClass}`);
  assert.notEqual(roadClass, 'street', 'unused street class must not be exported');
  assert.ok(typeof feature.properties?.width === 'number' && feature.properties.width > 0, 'roads must declare positive corridor widths');
  const roadName = requireString(feature.properties!, 'name', 'road');
  if (roadClass === 'arterial' && roadName) namedArterials.add(String(feature.properties!.id));
  if (['local', 'hillroad', 'rural'].includes(roadClass)) assert.equal(roadName, '', 'generated local roads must remain unnamed');
}
assert.deepEqual([...namedArterials].sort(), ['broadway', 'fifth-avenue', 'promenade', 'queens-road', 'wall-street']);
for (const sourceRoad of sourceRoads.filter((road) => road.roadClass === 'arterial' && road.name)) {
  const outputRoad = featureById(roadCollection, sourceRoad.id);
  assert.ok(outputRoad && outputRoad.geometry?.type === 'LineString', `${sourceRoad.id}: named arterial geometry required`);
  const coordinates = outputRoad.geometry.coordinates.map(localPosition);
  assert.equal(coordinates.length, sourceRoad.coordinates.length, `${sourceRoad.id}: named arterial must retain every authored vertex`);
  for (const [index, expected] of sourceRoad.coordinates.entries()) {
    assert.ok(Math.hypot(coordinates[index]![0] - expected[0], coordinates[index]![1] - expected[1]) <= 0.0001,
      `${sourceRoad.id}: named arterial geometry must remain complete and unchanged`);
  }
}
for (const highway of ['A1', 'A2', 'A3']) {
  const feature = featureById(roadCollection, highway);
  assert.ok(feature, `${highway} required`);
  assert.equal(feature.properties?.class, 'motorway');
}

for (const feature of lineCollection.features) {
  requireString(feature.properties!, 'id', 'metro line');
  requireString(feature.properties!, 'name', 'metro line');
  requireString(feature.properties!, 'color', 'metro line');
  requireString(feature.properties!, 'stations', 'metro line');
}
assert.equal(lineCollection.features.length, sourceTransitLines.length, 'each source metro line must be generated');
assert.equal(stationCollection.features.length, sourceStations.length, 'each source station must be generated');
const stationIds = new Set(stationCollection.features.map((feature) => requireString(feature.properties!, 'id', 'station')));
assert.equal(stationIds.size, sourceStations.length);
assert.deepEqual([...stationIds].sort(), sourceStations.map((station) => station.id).sort());
for (const feature of stationCollection.features) {
  requireString(feature.properties!, 'name', 'station');
  requireString(feature.properties!, 'lines', 'station');
  requireString(feature.properties!, 'district', 'station');
  assert.ok(feature.properties?.transfer === 0 || feature.properties?.transfer === 1, 'station transfer flag must be numeric');
  const id = String(feature.properties?.id ?? '');
  const source = sourceStations.find((station) => station.id === id);
  assert.ok(source, `${id}: station must exist in canonical source`);
  assert.equal(feature.properties?.name, source.name);
  assert.equal(feature.properties?.district, source.district);
  assert.ok(feature.geometry?.type === 'Point');
  const generatedPosition = localPosition(feature.geometry.coordinates);
  assert.ok(Math.hypot(generatedPosition[0] - source.position[0], generatedPosition[1] - source.position[1]) < 0.001, `${id}: generated station must match its source position`);
  const assignedDistrict = districtCollection.features.find((district) => district.properties?.name === source.district);
  assert.ok(assignedDistrict && booleanWithin(feature, assignedDistrict as Feature<Polygon, Properties>), `${id}: station must lie inside its assigned district`);
  const memberships = sourceTransitLines.filter((line) => line.stations.includes(id)).map((line) => line.id);
  assert.equal(String(feature.properties?.lines ?? ''), memberships.join(','), `${id}: line membership must match source`);
  assert.equal(feature.properties?.transfer, memberships.length > 1 ? 1 : 0, `${id}: transfer flag must match line membership`);
}
const stationNames = new Map(stationCollection.features.map((feature) => [
  String(feature.properties?.id ?? ''),
  requireString(feature.properties!, 'name', 'station'),
]));
const stationFeatureById = new Map(stationCollection.features.map((feature) => [
  String(feature.properties?.id ?? ''),
  feature,
]));
for (const [lineId, expected] of Object.entries(fixture)) {
  const feature = featureById(lineCollection, lineId);
  assert.ok(feature, `${lineId} metro line required`);
  assert.equal(feature.properties?.color, expected.color);
  const orderedIds = String(feature.properties?.stations ?? '').split(',');
  assert.deepEqual(orderedIds.map((id) => stationNames.get(id)), expected.stations, `${lineId} stop order`);
  for (const stationId of orderedIds) assert.ok(stationIds.has(stationId), `${lineId} references an unknown station`);
  assert.ok(feature.geometry?.type === 'LineString', `${lineId} route must be a LineString`);
  const stationCoordinates = orderedIds.map((stationId) => {
    const station = stationFeatureById.get(stationId);
    assert.ok(station?.geometry?.type === 'Point', `${lineId} references a station without point geometry: ${stationId}`);
    return station.geometry.coordinates;
  });
  const routePoints = feature.geometry.coordinates.map(localPosition);
  let previousRouteIndex = -1;
  let previousStationId: string | undefined;
  let turnsOverSixtyDegrees = 0;
  for (let stopIndex = 0; stopIndex < stationCoordinates.length; stopIndex += 1) {
    const stop = stationCoordinates[stopIndex]!;
    const currentStationId = orderedIds[stopIndex]!;
    const localStop = localPosition(stop);
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    for (let index = 0; index < routePoints.length; index += 1) {
      const distance = Math.hypot(routePoints[index]![0] - localStop[0], routePoints[index]![1] - localStop[1]);
      if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
    }
    assert.ok(nearestDistance < 0.005, `${lineId}: station must lie on route within 5 m`);
    assert.ok(nearestIndex > previousRouteIndex, `${lineId}: stations must remain ordered along the road route`);
    if (previousStationId) {
      const previousStation = stationFeatureById.get(previousStationId)!;
      const currentStation = stationFeatureById.get(currentStationId)!;
      if (previousStation.properties?.district !== '曼哈顿区' && currentStation.properties?.district !== '曼哈顿区') {
        assert.ok(nearestIndex - previousRouteIndex >= 2, `${lineId}: outside-Manhattan stops need an intermediate road vertex`);
      }
      if (previousStation.properties?.district === '曼哈顿区' && currentStation.properties?.district === '曼哈顿区') {
        const interval = routePoints.slice(previousRouteIndex, nearestIndex + 1);
        const routeLength = interval.slice(1).reduce((sum, point, index) =>
          sum + Math.hypot(point[0] - interval[index]![0], point[1] - interval[index]![1]), 0);
        const straightDistance = Math.hypot(localPosition(stationCoordinates[stopIndex]!)[0] - localPosition(stationCoordinates[stopIndex - 1]!)[0],
          localPosition(stationCoordinates[stopIndex]!)[1] - localPosition(stationCoordinates[stopIndex - 1]!)[1]);
        assert.ok(routeLength / straightDistance <= 1.3, `${lineId}: Manhattan station interval must stay within a 1.3 route-length ratio`);
        for (let index = 1; index < interval.length - 1; index += 1) {
          const before = interval[index - 1]!;
          const corner = interval[index]!;
          const after = interval[index + 1]!;
          const first = [corner[0] - before[0], corner[1] - before[1]];
          const second = [after[0] - corner[0], after[1] - corner[1]];
          const firstLength = Math.hypot(...first);
          const secondLength = Math.hypot(...second);
          if (firstLength === 0 || secondLength === 0) continue;
          const cosine = Math.max(-1, Math.min(1, (first[0]! * second[0]! + first[1]! * second[1]!) / (firstLength * secondLength)));
          const turnDegrees = Math.acos(cosine) * 180 / Math.PI;
          assert.ok(turnDegrees <= 100, `${lineId}: Manhattan route turns must not exceed 100 degrees`);
          if (turnDegrees > 60) turnsOverSixtyDegrees += 1;
        }
      }
    }
    previousRouteIndex = nearestIndex;
    previousStationId = currentStationId;
  }
  assert.ok(turnsOverSixtyDegrees <= 6, `${lineId}: no more than six Manhattan turns may exceed 60 degrees`);
}
const transfers = stationCollection.features.filter((feature) => feature.properties?.transfer === 1).map((feature) => feature.properties?.id).sort();
assert.deepEqual(transfers, ['station-strait-exchange', 'station-times-square']);
assert.equal(new Set(sourceTransitLines.flatMap((route) => route.stations)).size, sourceStations.length);

const originPlace = featureById(poiCollection, 'strait-exchange');
assert.ok(originPlace?.geometry?.type === 'Point');
assert.deepEqual(originPlace.geometry.coordinates, [-150, 40], 'exchange must remain at the exact coordinate origin');
for (const feature of poiCollection.features) {
  requireString(feature.properties!, 'id', 'POI');
  requireString(feature.properties!, 'name', 'POI');
  requireString(feature.properties!, 'category', 'POI');
  const source = sourcePoints.find((point) => point.id === feature.properties?.id);
  assert.ok(source, 'every POI must have a canonical source definition');
  assert.equal(feature.properties?.name, source.name);
  assert.equal(feature.properties?.category, source.category);
  assert.equal(feature.properties?.district, source.district);
  assert.ok(feature.geometry?.type === 'Point');
  const generatedPosition = localPosition(feature.geometry.coordinates);
  assert.ok(Math.hypot(generatedPosition[0] - source.position[0], generatedPosition[1] - source.position[1]) < 0.001);
}
const sourcePointIds = new Set(sourcePoints.map((point) => point.id));
const generatedPointIds = new Set(poiCollection.features.map((feature) => requireString(feature.properties!, 'id', 'POI')));
assert.deepEqual([...generatedPointIds].sort(), [...sourcePointIds].sort(), 'generated POI ids must match source point ids');

const buildings = buildingCollection.features as Feature<Polygon, Properties>[];
assert.ok(buildings.length <= 20000, 'building segment limit is 20000');
const bids = new Map<string, Feature<Polygon, Properties>[]>();
for (const building of buildings) {
  const bid = requireString(building.properties!, 'bid', 'building');
  bids.set(bid, [...(bids.get(bid) ?? []), building]);
}
for (const feature of buildings) {
  const base = feature.properties?.base;
  const height = feature.properties?.height;
  const top = feature.properties?.top;
  assert.ok(typeof base === 'number' && Number.isFinite(base) && base >= 0, 'building base must be finite and nonnegative');
  assert.ok(typeof height === 'number' && Number.isFinite(height) && height > base && height <= 480, 'building height must be finite and between its base and 480 meters');
  assert.ok(typeof top === 'number' && Number.isFinite(top) && top >= height, 'building top must be finite and at least its segment height');
  const kind = String(feature.properties?.kind ?? '');
  assert.ok(['grid', 'financial', 'reclamation', 'landmark', 'monument', 'uptown-support', 'warehouse', 'villa', 'town-house'].includes(kind));
  if (feature.properties?.id !== undefined) requireString(feature.properties, 'name', 'landmark building');
}
assert.ok(bids.size <= 20000, 'total distinct building bids must not exceed 20,000');
const manhattanDistrict = featureById(districtCollection, 'manhattan') as Feature<Polygon, Properties> | undefined;
assert.ok(manhattanDistrict?.geometry.type === 'Polygon', 'Manhattan district polygon is required');
const manhattanBids = groupBuildingBidsWithinDistrict(buildings, manhattanDistrict);
const manhattanBidCount = manhattanBids.size;
assert.ok(manhattanBidCount >= 8000 && manhattanBidCount <= 13000, 'Manhattan building count must be 8,000-13,000 distinct bids');
const tower = buildings.filter((feature) => feature.properties?.id === 'continental-tower');
assert.equal(tower.length, 5);
assert.ok(tower.every((feature) => feature.properties?.top === 480));
assert.equal(buildings.filter((feature) => feature.properties?.height === 480).length, 1);
assert.equal(new Set(tower.map((feature) => feature.properties?.bid)).size, 1);

const generatedBuildings = buildings.filter((feature) => feature.properties?.id === undefined);
const landmarkBuildings = buildings.filter((feature) => feature.properties?.id !== undefined);
assert.ok(generatedBuildings.length > 0, 'seeded Manhattan building sample required');
for (const [bid, segments] of bids) {
  const supportedBy = segments[0]!.properties?.supportedBy;
  const firstBase = Number(segments.find((segment) => Number(segment.properties?.base) > 0)?.properties?.base ?? segments[0]!.properties?.base);
  const bidTop = Number(segments[0]!.properties?.top);
  assert.ok(segments.every((segment) => segment.properties?.supportedBy === supportedBy), bid + ': support reference must be consistent across tiers');
  assert.ok(segments.every((segment) => segment.properties?.top === bidTop), bid + ': building tier tops must agree');
  const isContinentalTower = segments.every((segment) => segment.properties?.id === 'continental-tower');
  if (isContinentalTower) assert.equal(bidTop, 480, 'Continental Tower must reach 480 m');
  else assert.ok(bidTop <= 430, bid + ': non-Continental buildings must not exceed 430 m in any district');
  assertTierContinuity(segments.map((segment) => ({
    base: Number(segment.properties?.base),
    height: Number(segment.properties?.height),
  })), 0);
  assertFinalTierTop(segments.map((segment) => ({
    base: Number(segment.properties?.base),
    height: Number(segment.properties?.height),
  })), bidTop);
  const ordered = [...segments].sort((a, b) => Number(a.properties?.base) - Number(b.properties?.base));
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(booleanWithin(ordered[index]!, ordered[index - 1]!), 'upper building tiers must nest inside lower tiers');
  }
  if (typeof supportedBy === 'string') {
    const support = bids.get(supportedBy);
    assert.ok(support && supportedBy !== bid, bid + ': supported building must reference a distinct building bid');
    const supportOrdered = [...support].sort((a, b) => Number(a.properties?.base) - Number(b.properties?.base));
    const supportBase = Number(supportOrdered[0]!.properties?.base);
    const supportTop = Number(supportOrdered.at(-1)!.properties?.height);
    assert.equal(supportBase, 0, supportedBy + ': support building must start at ground');
    assert.equal(firstBase, supportTop, bid + ': supported building base must equal its support top');
    assert.ok(booleanWithin(ordered[0]!, supportOrdered[0]!), bid + ': support footprint must contain the supported footprint');
  }
}
assert.ok(buildings.every((building) => isNumericBuildingKey(building.properties?.key)),
  'every building feature must have numeric key 0 or 1');
for (const [bid, segments] of bids) {
  assert.ok(hasGroundFootprintAtBidTop(segments.map((segment) => ({ base: segment.properties?.base, top: segment.properties?.top }))),
    `${bid}: base=0 footprints must advertise the full building top`);
}
const keyBids = new Set(buildings.filter((building) => Number(building.properties?.key) === 1).map((building) => String(building.properties?.bid)));
assert.ok(keyBids.size >= 100 && keyBids.size <= 200, 'key buildings must cover 100-200 distinct bids');
assert.ok(buildings.filter((building) => Number(building.properties?.key) === 1).length <= 1200, 'key buildings must use at most 1,200 segments');
for (const landmark of landmarkBuildings) {
  const id = requireString(landmark.properties!, 'id', 'landmark building');
  const poi = featureById(poiCollection, id);
  assert.ok(poi?.geometry?.type === 'Point', `${id}: landmark must have a matching source point`);
  const vertices = walkCoordinates(landmark.geometry!);
  const center: [number, number] = [
    (Math.min(...vertices.map((position) => position[0]!)) + Math.max(...vertices.map((position) => position[0]!))) / 2,
    (Math.min(...vertices.map((position) => position[1]!)) + Math.max(...vertices.map((position) => position[1]!))) / 2,
  ];
  const expectedOffsets: Record<string, readonly (readonly [number, number])[]> = {
    'strait-exchange': [[-0.05, 0.05]],
    'continental-tower': [[0, 0.05]],
    'exchange-square': [[0, 0.06], [-0.065, 0.052], [0, 0.068], [0.065, 0.052]],
    hospital: [[0, 0], [-0.055, 0], [0, 0], [0.055, 0]],
    'old-governors-house': [[0, 0], [-0.065, 0], [0.065, 0]],
    church: [[0, 0], [0.035, 0]],
  };
  const origin = localPosition(poi.geometry.coordinates);
  const actual = localPosition(center);
  const offsets: readonly (readonly [number, number])[] = expectedOffsets[id] ?? [[0, 0]];
  assert.ok(offsets.some(([x, y]) => Math.hypot(actual[0] - origin[0] - x, actual[1] - origin[1] - y) <= 0.002),
    `${id}: building center must follow its source point and defined landmark offset`);
}
const areaFixture = JSON.parse(await readFile(resolve('tests/phase1-geometry.fixture.json'), 'utf8')) as { districtAreasKm2: Record<string, number>; stationsKm: Record<string, [number, number]> };
for (const feature of districtCollection.features) {
  const id = String(feature.properties?.id);
  const actualKm2 = area(feature as Feature<Polygon, Properties>) / 1_000_000;
  const baseline = areaFixture.districtAreasKm2[id];
  if (!['beverly', 'harlem', 'brooklyn', 'reserve'].includes(id)) {
    assert.ok(baseline && Math.abs(actualKm2 - baseline) <= baseline * 0.15, id + ': unchanged district area must stay within 15% of Phase 1');
  } else {
    assert.ok(actualKm2 > 0, id + ': Phase 3 district must have positive area');
  }
}
assertAreaCoverage(districtArea, area(monaco));
const expectedLabelIds = [...districtIds, ...landCollection.features.filter((item) => item.properties?.kind !== 'monaco').map((item) => String(item.properties?.id)), 'reserve'];
const labelCollection = datasets.get('labels')!;
assert.equal(labelCollection.features.length, 11, 'two reserve labels plus one label for each other region are required');
assertLabelCoverage(expectedLabelIds, labelCollection.features.map((item) => String(item.properties?.id)));
assert.equal(labelCollection.features.filter((item) => item.properties?.id === 'reserve').length, 2);
for (const label of labelCollection.features) {
  assert.ok(label.geometry?.type === 'Point');
  const region = [...districtCollection.features, ...landCollection.features].find((item) => item.properties?.id === label.properties?.id);
  assert.ok(region && booleanWithin(label, region as Feature<Polygon, Properties>), 'label must lie inside its mapped polygon');
}
const blockCollection = datasets.get('blocks')!;
const blocksById = new Map(blockCollection.features.filter((item) => typeof item.properties?.block_id === 'string').map((item) => [String(item.properties?.block_id), item]));
const ordinaryBlocks = blockCollection.features.filter((item) =>
  item.properties?.kind === 'block' && ['grid', 'financial', 'reclamation', 'residual'].includes(String(item.properties?.zone)),
);
const blockGrid = new Map<string, Feature<Polygon, Properties>[]>();
const indexedBlockKeys = (item: Feature<Polygon, Properties>): string[] => {
  const points = walkCoordinates(item.geometry!).map(localPosition);
  const size = 0.25;
  const minX = Math.floor(Math.min(...points.map(([x]) => x)) / size);
  const maxX = Math.floor(Math.max(...points.map(([x]) => x)) / size);
  const minY = Math.floor(Math.min(...points.map(([, y]) => y)) / size);
  const maxY = Math.floor(Math.max(...points.map(([, y]) => y)) / size);
  const keys: string[] = [];
  for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) keys.push(x + ':' + y);
  return keys;
};
for (const block of ordinaryBlocks as Feature<Polygon, Properties>[]) {
  const keys = indexedBlockKeys(block);
  const candidates = new Set(keys.flatMap((key) => blockGrid.get(key) ?? []));
  for (const candidate of candidates) {
    assertNoPositiveAreaOverlap(block, candidate, 'ordinary Manhattan blocks must not overlap');
  }
  for (const key of keys) blockGrid.set(key, [...(blockGrid.get(key) ?? []), block]);
}
for (const building of buildings) {
  const parent = blocksById.get(String(building.properties?.block_id));
  assert.ok(parent && booleanWithin(building, parent as Feature<Polygon, Properties>), 'building footprint must fit its block');
  assert.equal(building.properties?.id === undefined, building.properties?.name === undefined, 'only landmarks may have clickable names');
}
const baseFootprints = [...bids].map(([bid, segments]) => ({
  bid,
  feature: [...segments].sort((a, b) => Number(a.properties?.base) - Number(b.properties?.base))[0]!,
})).map((item) => ({ ...item, keys: indexedBlockKeys(item.feature) }));
const footprintGrid = new Map<string, typeof baseFootprints>();
for (const item of baseFootprints) {
  const candidates = new Set(item.keys.flatMap((key) => footprintGrid.get(key) ?? []));
  for (const candidate of candidates) {
    if (item.feature.properties?.supportedBy === candidate.bid || candidate.feature.properties?.supportedBy === item.bid) continue;
    assertNoPositiveAreaOverlap(item.feature, candidate.feature, 'building base footprints must not overlap');
  }
  for (const key of item.keys) footprintGrid.set(key, [...(footprintGrid.get(key) ?? []), item]);
}
for (const station of stationCollection.features.filter((item) => item.properties?.district === '曼哈顿区')) {
  const id = String(station.properties?.id);
  const old = areaFixture.stationsKm[id];
  assert.ok(old);
  const current = localPosition((station.geometry as Point).coordinates);
  assert.ok(Math.hypot(current[0] - old[0], current[1] - old[1]) <= 0.3, id + ': station moved more than 300 m');
}
const treeCollection = datasets.get('trees')!;
const centralTrees = treeCollection.features.filter((item) => item.properties?.park === 'central-park');
const batteryTrees = treeCollection.features.filter((item) => item.properties?.park === 'battery-park');
assert.equal(centralTrees.length, 800);
assert.equal(batteryTrees.length, 150);
const lake = datasets.get('surface')!.features.find((item) => item.properties?.kind === 'lake') as Feature<Polygon, Properties>;
assert.ok(lake, 'Central Park lake surface is required');
assert.ok(booleanWithin(lake, parkCollection.features.find((item) => item.properties?.id === 'central-park') as Feature<Polygon, Properties>));
for (const tree of treeCollection.features) {
  const park = parkCollection.features.find((item) => item.properties?.id === tree.properties?.park);
  assert.ok(park && booleanWithin(tree, park as Feature<Polygon, Properties>));
  assert.ok(!booleanIntersects(tree, lake), 'tree must not intersect the lake');
  assert.ok(Number(tree.properties?.w) >= 12 && Number(tree.properties?.w) <= 22);
  assert.ok(Number(tree.properties?.d) >= 12 && Number(tree.properties?.d) <= 22);
  assert.ok(Number(tree.properties?.h) >= 10 && Number(tree.properties?.h) <= 24);
}
const surfaces = datasets.get('surface')!.features;
const farms = surfaces.filter((item) => item.properties?.kind === 'farm');
assert.ok(farms.length >= 1000 && farms.length <= 2000);
assert.ok(farms.every((farm) => Number.isInteger(farm.properties?.tone) && Number(farm.properties?.tone) >= 0 && Number(farm.properties?.tone) <= 3));
const farmGrid = new Map<string, Feature<Polygon, Properties>[]>();
for (const farm of farms as Feature<Polygon, Properties>[]) {
  const keys = indexedBlockKeys(farm);
  const candidates = new Set(keys.flatMap((key) => farmGrid.get(key) ?? []));
  for (const candidate of candidates) assertNoPositiveAreaOverlap(farm, candidate, 'Voronoi farm cells must not overlap');
  for (const key of keys) farmGrid.set(key, [...(farmGrid.get(key) ?? []), farm]);
}
const fleetPiers = surfaces.filter((item) => item.properties?.kind === 'pier' && item.properties?.sector === 'fleet-port');
assert.ok(fleetPiers.length >= 6 && fleetPiers.length <= 10);
const supportIds = ['city-hall', 'hospital', 'library'];
const supportCounts = supportIds.map((id) => new Set(buildings.filter((item) =>
  String(item.properties?.block_id).startsWith('S-' + id + '-'),
).map((item) => item.properties?.bid)).size);
assert.ok(supportCounts.every((count) => count === 150), 'each Uptown landmark requires 150 linked support buildings');
const supportFeatures = buildings.filter((item) => item.properties?.kind === 'uptown-support');
assert.ok(supportFeatures.every((item) => Number(item.properties?.top) >= 10 && Number(item.properties?.top) <= 45));
for (const support of supportFeatures) {
  const blockId = requireString(support.properties!, 'block_id', 'Uptown support building');
  assert.ok(blockId.startsWith('S-'), 'Uptown support buildings must use stable linked block IDs');
  const siteId = supportIds.find((id) => blockId.startsWith('S-' + id + '-'));
  assert.ok(siteId, `${blockId}: support building must link to one of the three Uptown sites`);
  const site = featureById(poiCollection, siteId);
  assert.ok(site?.geometry?.type === 'Point');
  const vertices = walkCoordinates(support.geometry!).map(localPosition);
  const minX = Math.min(...vertices.map(([x]) => x));
  const maxX = Math.max(...vertices.map(([x]) => x));
  const minY = Math.min(...vertices.map(([, y]) => y));
  const maxY = Math.max(...vertices.map(([, y]) => y));
  const width = maxX - minX;
  const depth = maxY - minY;
  assert.ok(width >= 0.0248 && width <= 0.0602 && depth >= 0.0248 && depth <= 0.0602,
    `${blockId}: support footprint must be 25-60 m on both sides`);
  const anchor = localPosition(site.geometry.coordinates);
  const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
  assert.ok(Math.hypot(center[0] - anchor[0], center[1] - anchor[1]) + Math.hypot(width / 2, depth / 2) <= 0.6002,
    `${blockId}: entire support footprint must remain within 600 m of its site`);
}
assert.ok(buildings.filter((item) => item.properties?.kind === 'warehouse').every((item) => Number(item.properties?.top) <= 25));
const reserve = districtCollection.features.find((item) => item.properties?.id === 'reserve') as Feature<Polygon, Properties>;
assert.ok(buildings.filter((item) => item.properties?.kind !== 'town-house').every((item) => !booleanWithin(item, reserve)), 'only town houses may be generated in the reserve');
assert.ok(buildings.filter((item) => item.properties?.kind === 'town-house').every((item) => booleanWithin(item, reserve)));
const surfaceFeatures = datasets.get('surface')!.features;
const woods = surfaceFeatures.filter((item) => item.properties?.kind === 'wood') as Feature<Polygon, Properties>[];
const reserveWoods = woods.filter((item) => item.properties?.sector === 'reserve');
const beverlyWoods = woods.filter((item) => item.properties?.sector === 'beverly');
const reserveAreaKm2 = area(reserve) / 1_000_000;
const reserveWoodsKm2 = reserveWoods.reduce((sum, item) => sum + area(item) / 1_000_000, 0);
const farmAreaKm2 = farms.reduce((sum, item) => sum + area(item) / 1_000_000, 0);
assert.ok(reserveWoodsKm2 / reserveAreaKm2 >= 0.3 && reserveWoodsKm2 / reserveAreaKm2 <= 0.4, 'reserve woods must cover 30-40% of the reserve');
assert.ok(reserveWoods.every((item) => area(item) / 1_000_000 >= 0.3));
assert.ok(reserveWoods.filter((item) => area(item) / 1_000_000 > 5).length >= 3);
const reserveWoodCenters = reserveWoods.map((wood) => {
  const coordinates = (wood.geometry as Polygon).coordinates[0]!.map(localPosition);
  return [coordinates.reduce((sum, [x]) => sum + x, 0) / coordinates.length,
    coordinates.reduce((sum, [, y]) => sum + y, 0) / coordinates.length] as [number, number];
});
assert.ok(reserveWoodCenters.some(([x, y]) => x < 28 && y > 25), 'reserve north arm must contain woods');
assert.ok(reserveWoodCenters.some(([x]) => x >= 28), 'reserve east arm must contain woods');
const beverly = districtCollection.features.find((item) => item.properties?.id === 'beverly') as Feature<Polygon, Properties>;
const beverlyWoodsKm2 = beverlyWoods.reduce((sum, item) => sum + area(item) / 1_000_000, 0);
const beverlyAreaKm2 = area(beverly) / 1_000_000;
assert.ok(beverlyWoodsKm2 / beverlyAreaKm2 >= 0.35 && beverlyWoodsKm2 / beverlyAreaKm2 <= 0.5, 'Beverly woods must cover 35-50% of its district');
assert.ok(farmAreaKm2 / reserveAreaKm2 >= 0.45 && farmAreaKm2 / reserveAreaKm2 <= 0.55, 'reserve farms must cover 45-55% of the reserve');
const quadrilateralFarms = farms.filter((item) => item.geometry?.type === 'Polygon' && item.geometry.coordinates[0]?.length === 5);
assert.ok(quadrilateralFarms.length / farms.length <= 0.3, 'farm quadrilaterals must not exceed the 30% cap');
for (const farm of farms as Feature<Polygon, Properties>[]) {
  for (const wood of woods) assertNoPositiveAreaOverlap(farm, wood, 'farm fields must not overlap woods');
}
const townBlocks = blockCollection.features.filter((item) => item.properties?.kind === 'town') as Feature<Polygon, Properties>[];
assert.equal(townBlocks.length, 8);
assert.ok(townBlocks.every((town) => area(town) / 1_000_000 >= 0.3 && area(town) / 1_000_000 <= 0.9));
assert.deepEqual(townBlocks.map((town) => String(town.properties?.town_id)).sort(), reserveTownCenters.map((town) => town.id).sort());
for (const town of townBlocks) {
  assert.equal(town.properties?.id, undefined);
  assert.equal(town.properties?.name, undefined);
  const source = reserveTownCenters.find((candidate) => candidate.id === town.properties?.town_id)!;
  assert.ok(booleanPointInPolygon(point(geographicPosition(source.position)), town), `${source.id} must retain its source center`);
  for (const wood of woods) assertNoPositiveAreaOverlap(town, wood, 'towns must not overlap woods');
  for (const farm of farms as Feature<Polygon, Properties>[]) assertNoPositiveAreaOverlap(town, farm, 'towns must not overlap farms');
}
assert.ok(reserveTownCenters.filter((town) => town.position[0] >= 28).length >= 3);
for (let first = 0; first < reserveTownCenters.length; first += 1) {
  for (let second = first + 1; second < reserveTownCenters.length; second += 1) {
    assert.ok(Math.hypot(reserveTownCenters[first]!.position[0] - reserveTownCenters[second]!.position[0], reserveTownCenters[first]!.position[1] - reserveTownCenters[second]!.position[1]) >= 3,
      'reserve towns must be at least 3 km apart');
  }
}
const townHouses = buildings.filter((item) => item.properties?.kind === 'town-house');
assert.ok(townHouses.length <= 2000);
for (const town of townBlocks) {
  const houses = townHouses.filter((item) => item.properties?.block_id === town.properties?.block_id);
  assert.ok(houses.length >= 60 && houses.length <= 200);
  for (const house of houses) {
    const coordinates = walkCoordinates(house.geometry!).map(localPosition);
    const width = Math.max(...coordinates.map(([x]) => x)) - Math.min(...coordinates.map(([x]) => x));
    const depth = Math.max(...coordinates.map(([, y]) => y)) - Math.min(...coordinates.map(([, y]) => y));
    assert.ok(width >= 0.01 && width <= 0.025 && depth >= 0.01 && depth <= 0.025);
    assert.ok(Number(house.properties?.top) >= 5 && Number(house.properties?.top) <= 12);
    assert.equal(Number(house.properties?.key), 0);
    assert.equal(house.properties?.id, undefined);
    assert.equal(house.properties?.name, undefined);
  }
}
const hillRoads = roadCollection.features.filter((item) => item.properties?.class === 'hillroad');
const hillRoadIds = new Set(hillRoads.map((item) => String(item.properties?.id).replace(/-part-\d+$/, '').replace(/-\d+$/, '')));
assert.ok(hillRoadIds.size >= 8 && hillRoadIds.size <= 12);
const mainRoads = roadCollection.features.filter((item) => ['motorway', 'arterial'].includes(String(item.properties?.class)));
const a2Road = mainRoads.find((item) => item.properties?.id === 'A2');
const a3Road = mainRoads.find((item) => item.properties?.id === 'A3');
assert.ok(a2Road && a3Road, 'Beverly access requires A2 and A3');
const hillGraph = roadGraphReachable(a2Road, [...hillRoads, ...mainRoads]);
assert.ok(hillRoads.every((road) => hillGraph.has(road)), 'every hill road must connect through the real road graph to A2');
assert.ok(hillGraph.has(a3Road), 'the hill-road graph must also reach A3');
const ruralRoads = roadCollection.features.filter((item) => item.properties?.class === 'rural');
assert.ok(ruralRoads.length >= 40, 'rural roads must connect towns and form town streets');
assert.ok(ruralRoads.every((road) => road.properties?.name === '' && Math.abs(Number(road.properties?.width) - 0.008) < 1e-8));
const ruralGraphRoads = [...ruralRoads, ...mainRoads];
for (const sourceTown of reserveTownCenters) {
  const position = sourceTown.position;
  const nearestTown = reserveTownCenters.filter((candidate) => candidate.id !== sourceTown.id)
    .map((candidate) => ({ candidate, distance: Math.hypot(candidate.position[0] - position[0], candidate.position[1] - position[1]) }))
    .sort((first, second) => first.distance - second.distance)[0]!.candidate;
  const pairId = `rural-link-${[sourceTown.id, nearestTown.id].sort().join(':').replace(':', '-')}`;
  const neighborLink = ruralRoads.find((road) => road.properties?.id === pairId);
  assert.ok(neighborLink?.geometry?.type === 'LineString', `${sourceTown.id} must link to its nearest town`);
  const linkEnds = [neighborLink.geometry.coordinates[0]!, neighborLink.geometry.coordinates.at(-1)!].map(localPosition);
  const expectedEnds = [position, nearestTown.position];
  assert.ok(linkEnds.every((end) => expectedEnds.some((expected) => Math.hypot(end[0] - expected[0], end[1] - expected[1]) <= 0.003)),
    `${sourceTown.id} town link must reach both stable centers`);
  const highwayLink = ruralRoads.find((road) => road.properties?.id === `rural-highway-${sourceTown.id}`);
  assert.ok(highwayLink?.geometry?.type === 'LineString', `${sourceTown.id} must have a highway/arterial link`);
  const accessCoordinates = highwayLink.geometry.coordinates;
  const accessStart = localPosition(accessCoordinates[0]!);
  const accessEnd = localPosition(accessCoordinates.at(-1)!);
  assert.ok(Math.hypot(accessStart[0] - position[0], accessStart[1] - position[1]) <= 0.003,
    `${sourceTown.id} highway link must begin at its stable center`);
  const nearestMainRoad = mainRoads.map((road) => ({ road, distance: roadDistanceFrom(position, road) }))
    .sort((first, second) => first.distance - second.distance)[0]!.road;
  assert.ok(roadDistanceFrom(accessEnd, nearestMainRoad) <= 0.003, `${sourceTown.id} highway link must touch its nearest main road`);
  const reachable = roadGraphReachable(highwayLink, ruralGraphRoads);
  assert.ok(reachable.has(nearestMainRoad), `${sourceTown.id} rural network must be graph-continuous to the main road`);
  assert.ok(reachable.has(neighborLink), `${sourceTown.id} rural network must join its nearest town`);
}
assert.equal(beverlyHills.length, 7);
let sampledPeak = 0;
for (let x = 9; x <= 28; x += 0.1) for (let y = 0; y <= 9; y += 0.1) sampledPeak = Math.max(sampledPeak, beverlyElevationAt([x, y]));
assert.ok(sampledPeak >= 280 && sampledPeak <= 340, 'Beverly peak must be 280-340 m');
const beverlySourceRing = sourceDistricts.find((district) => district.id === 'beverly')!.ring;
for (let index = 1; index < beverlySourceRing.length; index += 1) {
  const start = beverlySourceRing[index - 1]!;
  const end = beverlySourceRing[index]!;
  const steps = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 0.05));
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    assert.ok(beverlyElevationAt([start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio]) < 40,
      'Beverly boundary elevations must remain below 40 m');
  }
}
for (let x = 9; x <= 28; x += 0.05) for (let y = 0; y < 2.8; y += 0.05) {
  assert.ok(beverlyElevationAt([x, y]) < 40, 'Beverly low-coast elevations must remain below 40 m');
}
assert.equal(beverlyElevationAt([8.99, 5]), 0);
assert.equal(beverlyElevationAt([28.01, 5]), 0);
for (const road of hillRoads) {
  assert.ok(road.geometry?.type === 'LineString');
  assert.equal(road.properties?.name, '');
  assert.ok(Math.abs(Number(road.properties?.width) - 0.012) < 1e-8, 'Beverly hill roads must be 12 m wide');
  const path = road.geometry.coordinates.map(localPosition);
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]!;
    const end = path[index]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    assert.ok(length <= 0.6, 'hill road straight segments must be at most 600 m');
    const steps = Math.max(1, Math.ceil(length / 0.05));
    let previous = beverlyElevationAt(start);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const current: [number, number] = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
      const elevation = beverlyElevationAt(current);
      assert.ok(Math.abs(elevation - previous) / (length * 1000 / steps) <= 0.08, 'hill road grade must remain at or below 8%');
      previous = elevation;
    }
  }
}
const villas = buildings.filter((item) => item.properties?.kind === 'villa');
assert.ok(villas.length >= 1500 && villas.length <= 3000);
const villaRoadDistances: number[] = [];
for (const villa of villas) {
  const vertices = walkCoordinates(villa.geometry!).map(localPosition);
  const center: [number, number] = [(Math.min(...vertices.map(([x]) => x)) + Math.max(...vertices.map(([x]) => x))) / 2,
    (Math.min(...vertices.map(([, y]) => y)) + Math.max(...vertices.map(([, y]) => y))) / 2];
  assert.ok(vertices.every((position) => beverlyElevationAt(position) <= 240 && beverlySlopeAt(position) <= 0.3));
  assert.ok(Number(villa.properties?.top) >= 6 && Number(villa.properties?.top) <= 14);
  assert.equal(Number(villa.properties?.key), 0);
  assert.equal(Number(villa.properties?.base), 0);
  assert.equal(villa.properties?.id, undefined);
  assert.equal(villa.properties?.name, undefined);
  const width = Math.max(...vertices.map(([x]) => x)) - Math.min(...vertices.map(([x]) => x));
  const depth = Math.max(...vertices.map(([, y]) => y)) - Math.min(...vertices.map(([, y]) => y));
  assert.ok(width >= 0.012 && width <= 0.028 && depth >= 0.012 && depth <= 0.028);
  const roadDistance = Math.min(...hillRoads.flatMap((road) => {
    if (road.geometry?.type !== 'LineString') return [Number.POSITIVE_INFINITY];
    const coordinates = road.geometry.coordinates;
    return coordinates.slice(1).map((next, index) => distanceToSegment(center, localPosition(coordinates[index]!), localPosition(next)));
  }));
  villaRoadDistances.push(roadDistance);
  const halfDiagonal = Math.hypot(width / 2, depth / 2);
  assert.ok(roadDistance + halfDiagonal <= 0.09, 'every Beverly villa footprint must be within 90 m of a hill road');
}
const terrainFeatures = datasets.get('terrain')!.features;
assert.ok(terrainFeatures.some((item) => item.properties?.kind === 'band'));
assert.ok(terrainFeatures.some((item) => item.properties?.kind === 'contour'));
assert.ok(terrainFeatures.filter((item) => item.properties?.kind === 'band').every((item) =>
  item.geometry?.type === 'Polygon' && Number(item.properties?.level) >= 0 && Number(item.properties?.level) % 40 === 0));
assert.ok(terrainFeatures.filter((item) => item.properties?.kind === 'contour').every((item) =>
  item.geometry?.type === 'LineString' && Number(item.properties?.level) > 0 && Number(item.properties?.level) % 40 === 0));
assert.ok(datasets.get('overview')!.features.some((item) => item.properties?.kind === 'wood'));
assert.ok(datasets.get('overview')!.features.some((item) => item.properties?.kind === 'band'));
assert.ok(datasets.get('overview')!.features.every((item) => item.properties?.kind === 'wood' || item.properties?.kind === 'band'));
assert.ok(blockCollection.features.every((item) => ['highrise', 'midrise', 'lowrise', 'lowdensity', 'town', 'plaza'].includes(String(item.properties?.type))));
type LocalArea = { rings: [number, number][][]; bounds: [number, number, number, number] };
const localAreas = (features: Feature<Geometry, Properties>[]): LocalArea[] => features.flatMap((item) => {
  if (item.geometry?.type !== 'Polygon') return [];
  const rings = item.geometry.coordinates.map((ring) => ring.map(localPosition));
  const outer = rings[0]!;
  return [{
    rings,
    bounds: [Math.min(...outer.map(([x]) => x)), Math.min(...outer.map(([, y]) => y)),
      Math.max(...outer.map(([x]) => x)), Math.max(...outer.map(([, y]) => y))],
  }];
});
const manhattanRing = sourceDistricts.find((item) => item.id === 'manhattan')!.ring;
const manhattanPoints = manhattanRing;
const manhattanBounds = [
  Math.min(...manhattanPoints.map(([x]) => x)), Math.min(...manhattanPoints.map(([, y]) => y)),
  Math.max(...manhattanPoints.map(([x]) => x)), Math.max(...manhattanPoints.map(([, y]) => y)),
];
const manhattanBlocks = blockCollection.features.filter((item) => item.properties?.kind === 'block');
const manhattanParks = parkCollection.features.filter((item) => item.geometry?.type === 'Polygon');
const areaIndexCellSize = 0.25;
const areaIndex = (areas: LocalArea[]): Map<string, LocalArea[]> => {
  const index = new Map<string, LocalArea[]>();
  for (const area of areas) {
    const [west, south, east, north] = area.bounds;
    for (let x = Math.floor(west / areaIndexCellSize); x <= Math.floor(east / areaIndexCellSize); x += 1) {
      for (let y = Math.floor(south / areaIndexCellSize); y <= Math.floor(north / areaIndexCellSize); y += 1) {
        const key = `${x}:${y}`;
        index.set(key, [...(index.get(key) ?? []), area]);
      }
    }
  }
  return index;
};
const nearbyAreas = (position: readonly [number, number], index: Map<string, LocalArea[]>): LocalArea[] => {
  const x = Math.floor(position[0] / areaIndexCellSize);
  const y = Math.floor(position[1] / areaIndexCellSize);
  const nearby = new Set<LocalArea>();
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
    for (const item of index.get(`${x + dx}:${y + dy}`) ?? []) nearby.add(item);
  }
  return [...nearby];
};
const localAreaContains = (position: readonly [number, number], item: LocalArea): boolean =>
  pointInRing(position, item.rings[0]!) && !item.rings.slice(1).some((ring) => pointInRing(position, ring));
const localAreaEdgeDistance = (position: readonly [number, number], item: LocalArea): number =>
  Math.min(...item.rings.flatMap((ring) => ring.slice(1).map((next, index) => distanceToSegment(position, ring[index]!, next))));
const blockAreas = localAreas(manhattanBlocks);
const blockIndex = areaIndex(blockAreas);
const blockAndParkAreas = [...blockAreas, ...localAreas(manhattanParks)];
const blockAndParkIndex = areaIndex(blockAndParkAreas);
const namedManhattanRoads = roadCollection.features.filter((item) =>
  item.geometry?.type === 'LineString' && item.properties?.name !== '' && ['arterial', 'motorway'].includes(String(item.properties?.class)));
let roadsideSamples = 0;
let roadsideCovered = 0;
const roadsideByName = new Map<string, { samples: number; covered: number }>();
for (const road of namedManhattanRoads) {
  const path = road.geometry!.type === 'LineString' ? road.geometry.coordinates.map(localPosition) : [];
  const name = String(road.properties?.name);
  const width = Number(road.properties?.width);
  const stats = roadsideByName.get(name) ?? { samples: 0, covered: 0 };
  for (let segmentIndex = 1; segmentIndex < path.length; segmentIndex += 1) {
    const start = path[segmentIndex - 1]!;
    const end = path[segmentIndex]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const sampleCount = Math.max(1, Math.ceil(length / 0.05));
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const ratio = (sampleIndex + 0.5) / sampleCount;
      const sample: [number, number] = [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
      if (!pointInRing(sample, manhattanRing)) continue;
      const nearest = Math.min(...nearbyAreas(sample, blockIndex).map((item) => localAreaEdgeDistance(sample, item)));
      if (nearest <= width / 2 + 0.03) {
        roadsideCovered += 1;
        stats.covered += 1;
      }
      roadsideSamples += 1;
      stats.samples += 1;
    }
  }
  roadsideByName.set(name, stats);
}
const roadsidePercent = roadsideCovered / roadsideSamples;
assert.ok(roadsideSamples > 0);
assert.ok(roadsidePercent >= 0.9, `Manhattan named-roadside coverage must be >=90% at road half-width + 30 m; got ${(roadsidePercent * 100).toFixed(2)}%`);
console.log(`Section 8.2 roadside: ${roadsideCovered}/${roadsideSamples} (${(roadsidePercent * 100).toFixed(2)}%) samples within road half-width + 30 m.`);
console.log(`Section 8.2 by road: ${[...roadsideByName].map(([name, stats]) => `${name}=${stats.covered}/${stats.samples}`).join(', ')}`);

const bareLandStep = 0.1;
let bareLandSamples = 0;
let totalLandSamples = 0;
for (let x = Math.floor(manhattanBounds[0] / bareLandStep) * bareLandStep; x < manhattanBounds[2]; x += bareLandStep) {
  for (let y = Math.floor(manhattanBounds[1] / bareLandStep) * bareLandStep; y < manhattanBounds[3]; y += bareLandStep) {
    const sample: [number, number] = [x + bareLandStep / 2, y + bareLandStep / 2];
    if (!pointInRing(sample, manhattanRing)) continue;
    totalLandSamples += 1;
    const nearBlockOrPark = nearbyAreas(sample, blockAndParkIndex).some((item) =>
      localAreaContains(sample, item) || localAreaEdgeDistance(sample, item) <= 0.06);
    if (!nearBlockOrPark) bareLandSamples += 1;
  }
}
const bareLandPercent = bareLandSamples / totalLandSamples;
assert.ok(totalLandSamples > 0);
assert.ok(bareLandPercent <= 0.04, `Manhattan land >60 m from every block or park must be <=4%; got ${(bareLandPercent * 100).toFixed(2)}%`);
console.log(`Section 8.3 Manhattan bare land: ${bareLandSamples}/${totalLandSamples} (${(bareLandPercent * 100).toFixed(2)}%) samples >60 m from every block or park.`);
const summarizeBids = (groups: Iterable<Feature<Polygon, Properties>[]>): {
  bidCount: number;
  medianHeightMeters: number;
  above150mBids: number;
  above150mPercent: number;
  above300mBids: number;
  maximumHeightMeters: number;
} => {
  const tops = [...groups].map((segments) => Number(segments[0]!.properties?.top)).sort((a, b) => a - b);
  const middle = Math.floor(tops.length / 2);
  const medianHeightMeters = tops.length % 2 === 0
    ? (tops[middle - 1]! + tops[middle]!) / 2
    : tops[middle]!;
  const above150mBids = tops.filter((height) => height > 150).length;
  return {
    bidCount: tops.length,
    medianHeightMeters,
    above150mBids,
    above150mPercent: above150mBids / tops.length,
    above300mBids: tops.filter((height) => height > 300).length,
    maximumHeightMeters: tops.at(-1)!,
  };
};
const fullRegionStats = summarizeBids(bids.values());
const manhattanStats = summarizeBids(manhattanBids.values());
assert.ok(manhattanStats.medianHeightMeters >= 20 && manhattanStats.medianHeightMeters <= 35, 'Manhattan median height is outside 20-35 m');
assert.ok(manhattanStats.above150mPercent >= 0.03 && manhattanStats.above150mPercent <= 0.07, '3-7% of Manhattan buildings must exceed 150 m');
assert.ok(manhattanStats.above300mBids >= 5 && manhattanStats.above300mBids <= 60, '5-60 Manhattan buildings must exceed 300 m');
assert.equal(fullRegionStats.maximumHeightMeters, 480);
const hotspots = [
  { center: [0.1, 0.3] as const, sigma: 0.8 },
  { center: [4.6, 1.5] as const, sigma: 1.5 },
  { center: [7.1, 5.4] as const, sigma: 1 },
];
const fifthAvenue = sourceRoads.find((road) => road.id === 'fifth-avenue')!;
const manhattanOrdinaryBids = [...manhattanBids.values()].filter((segments) => {
  const kind = String(segments[0]?.properties?.kind);
  return ['grid', 'financial', 'reclamation'].includes(kind);
});
const highOrdinary = manhattanOrdinaryBids.filter((segments) => Number(segments[0]?.properties?.top) > 90);
const flatShare = highOrdinary.filter((segments) => segments.length === 1).length / highOrdinary.length;
assert.ok(flatShare >= 0.2 && flatShare <= 0.4, 'high-building flat-top share should be about 30%');
for (const segments of manhattanOrdinaryBids) {
  const top = Number(segments[0]?.properties?.top);
  if (top <= 90) assert.equal(segments.length, 1);
  else if (top <= 170) assert.ok(segments.length === 1 || segments.length === 2);
  else assert.ok(segments.length === 1 || segments.length === 4);
  if (top <= 90) continue;
  const vertices = walkCoordinates(segments[0]!.geometry!).map(localPosition);
  const center: [number, number] = [
    (Math.min(...vertices.map((point) => point[0])) + Math.max(...vertices.map((point) => point[0]))) / 2,
    (Math.min(...vertices.map((point) => point[1])) + Math.max(...vertices.map((point) => point[1]))) / 2,
  ];
  const outsideHotspots = hotspots.every((item) => Math.hypot(center[0] - item.center[0], center[1] - item.center[1]) > 2.5 * item.sigma);
  const fifthDistance = Math.min(...fifthAvenue.coordinates.slice(1).map((next, index) =>
    distanceToSegment(center, fifthAvenue.coordinates[index]!, next)));
  if (outsideHotspots && fifthDistance > 0.2) assert.ok(top <= 90, 'high ordinary buildings must stay in a hotspot or Fifth Avenue band');
}
for (const road of roadCollection.features) requireString(road.properties!, 'name', 'road');
for (const line of lineCollection.features) {
  if (line.geometry?.type !== 'LineString') continue;
  const route = line.geometry.coordinates.map(localPosition);
  for (let index = 1; index < route.length; index += 1) {
    const midpoint: [number, number] = [(route[index - 1]![0] + route[index]![0]) / 2, (route[index - 1]![1] + route[index]![1]) / 2];
    const onRoad = roadCollection.features.some((road) => {
      if (road.geometry?.type !== 'LineString') return false;
      const coordinates = road.geometry.coordinates;
      return coordinates.slice(1).some((next, segment) => distanceToSegment(midpoint, localPosition(coordinates[segment]!), localPosition(next)) < 0.005);
    });
    if (midpoint[0] <= 9.2 && midpoint[1] <= 9.2) assert.ok(onRoad, 'Manhattan metro route segment must follow a road centerline');
  }
}
for (const park of parkCollection.features) assert.ok(booleanWithin(park, monaco), 'parks must lie inside Monaco');
for (const poi of poiCollection.features) {
  assert.ok(poi.geometry?.type === 'Point');
  const position = localPosition(poi.geometry.coordinates);
  const onLandBoundary = monacoRing.slice(1).some((end, index) => distanceToSegment(position, monacoRing[index]!, end) <= 0.001);
  assert.ok(booleanWithin(poi, monaco) || onLandBoundary, 'places must lie inside or on the Monaco land boundary');
}
for (const station of stationCollection.features) assert.ok(booleanWithin(station, monaco), 'stations must lie inside Monaco land');
for (const block of blockCollection.features) assert.ok(booleanWithin(block, monaco), 'blocks must lie inside Monaco land');
const plazas = blockCollection.features.filter((item) => item.properties?.kind === 'plaza');
assert.equal(plazas.length, 7);
const plazaHoles: Feature<Polygon, Properties>[] = plazas.flatMap((plaza) => {
  if (plaza.geometry?.type !== 'Polygon' || plaza.geometry.coordinates.length !== 2) return [];
  return [{
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [plaza.geometry.coordinates[1]!] },
  } as Feature<Polygon, Properties>];
});
assert.equal(plazaHoles.length, 3, 'landmark plazas must reserve three footprints');
const plazaHoleByLandmark = new Map<string, Feature<Polygon, Properties>>();
for (const id of ['strait-exchange', 'continental-tower', 'exchange-square']) {
  const poi = featureById(poiCollection, id);
  assert.ok(poi?.geometry?.type === 'Point', `${id}: plaza hole requires a source point`);
  const matchingHoles = plazaHoles.filter((hole) => booleanWithin(poi, hole));
  assert.equal(matchingHoles.length, 1, `${id}: exactly one plaza hole must contain its source point`);
  plazaHoleByLandmark.set(id, matchingHoles[0]!);
  const landmark = landmarkBuildings.filter((building) => building.properties?.id === id);
  assert.ok(landmark.length > 0 && landmark.every((building) => booleanWithin(building, matchingHoles[0]!)),
    `${id}: landmark footprints must occupy their matching plaza hole`);
}
const plazaOuters = plazas.map((plaza) => {
  assert.ok(plaza.geometry?.type === 'Polygon');
  return {
    type: 'Feature',
    properties: plaza.properties!,
    geometry: { type: 'Polygon', coordinates: [plaza.geometry.coordinates[0]!] },
  } as Feature<Polygon, Properties>;
});
for (const building of buildings) {
  assert.ok(!parkCollection.features.some((park) => booleanIntersects(building, park as Feature<Polygon, Properties>)),
    'every building footprint must avoid parks');
  const ring = walkCoordinates(building.geometry!).map(localPosition) as [number, number][];
  assertRoadClearance(ring, nearbyRoadSegments(ring));

  const id = typeof building.properties?.id === 'string' ? building.properties.id : undefined;
  const matchingHole = id ? plazaHoleByLandmark.get(id) : undefined;
  for (const plaza of plazas) {
    if (id && plaza.properties?.monument_id === id) {
      assert.ok(booleanWithin(building, plaza as Feature<Polygon, Properties>), `${id}: monument components must fit their reserved ground`);
    } else {
      assertNoPositiveAreaOverlap(building, plaza as Feature<Polygon, Properties>, 'building footprint must not overlap an unrelated plaza');
    }
  }
  const intersectingHoles = plazaHoles.filter((hole) => polygonIntersectionArea(building, hole) > 0.01);
  assert.ok(intersectingHoles.every((hole) => hole === matchingHole),
    'only the landmark assigned to a plaza may occupy its reserved hole');
  if (matchingHole) {
    assert.ok(booleanWithin(building, matchingHole), `${id}: entire footprint must fit its matching plaza hole`);
  } else {
    for (const outer of plazaOuters) {
      if (id && outer.properties?.monument_id === id) assert.ok(booleanWithin(building, outer), `${id}: building must fit its monument plaza`);
      else assertNoPositiveAreaOverlap(building, outer, 'non-landmark building must stay outside plaza reserves');
    }
  }
}
for (const station of stationCollection.features.filter((item) => item.properties?.district === '曼哈顿区')) {
  const position = localPosition((station.geometry as Point).coordinates);
  const intersectingRoads = roadCollection.features.filter((road) => {
    if (road.geometry?.type !== 'LineString') return false;
    const coordinates = road.geometry.coordinates;
    return coordinates.slice(1).some((next, index) => distanceToSegment(position, localPosition(coordinates[index]!), localPosition(next)) < 0.005);
  });
  assert.ok(intersectingRoads.length >= 2, 'Manhattan stations must snap to actual road intersections');
}
for (const route of lineCollection.features) {
  if (route.geometry?.type !== 'LineString') continue;
  for (const block of blockCollection.features.filter((item) => item.properties?.kind === 'block')) {
    assert.ok(!booleanIntersects(route, block), 'metro route must not cross a visible block');
  }
  for (const exclusion of blockCollection.features.filter((item) => item.properties?.kind === 'plaza' && typeof item.properties?.monument_id === 'string')) {
    assert.ok(!booleanIntersects(route, exclusion), `metro route must not cross the ${String(exclusion.properties?.monument_id)} monument exclusion`);
  }
}
for (const surface of farms) {
  assert.ok(booleanWithin(surface, reserve));
  const coordinates = walkCoordinates(surface.geometry!).map(localPosition);
  const width = Math.max(...coordinates.map((point) => point[0])) - Math.min(...coordinates.map((point) => point[0]));
  const depth = Math.max(...coordinates.map((point) => point[1])) - Math.min(...coordinates.map((point) => point[1]));
  assert.ok(width >= 0.15 && width <= 0.6 && depth >= 0.15 && depth <= 0.6, 'farm fields must be 150-600 m across');
}
const warehouseBids = new Set(buildings.filter((item) => item.properties?.kind === 'warehouse').map((item) => item.properties?.bid));
assert.equal(warehouseBids.size, 16, 'eight piers require two warehouse footprints each');
const exchangeStacks = new Set(buildings.filter((item) => item.properties?.id === 'exchange-square').map((item) => item.properties?.bid));
assert.equal(exchangeStacks.size, 4, 'Exchange Square podium and towers must be separate physical stacks');
for (const building of buildings.filter((item) => ['grid', 'financial', 'reclamation', 'uptown-support', 'warehouse'].includes(String(item.properties?.kind)))) {
  const coordinates = walkCoordinates(building.geometry!).map(localPosition);
  const maxEdge = coordinates.slice(1).reduce((max, point, index) => Math.max(max, Math.hypot(point[0] - coordinates[index]![0], point[1] - coordinates[index]![1])), 0);
  assert.ok(maxEdge <= 0.12, 'ordinary building footprint edge must not exceed 120 m');
}
const placeFiles = (await readdir(placeDirectory)).filter((file) => file.endsWith('.md'));
const contentIds = new Set<string>();
for (const file of placeFiles) {
  const document = parseContentDocument(await readFile(resolve(placeDirectory, file), 'utf8'));
  assert.equal(`${document.metadata.id}.md`, file, `${file}: filename must match id`);
  assert.ok(normalizeProse(document.body).length > 0, `${file}: body must not be empty`);
  assert.ok(!contentIds.has(document.metadata.id), `duplicate content id ${document.metadata.id}`);
  contentIds.add(document.metadata.id);
}
const clickableIds = collectClickableIds({
  land: landCollection,
  districts: districtCollection,
  parks: parkCollection,
  roads: roadCollection,
  buildings: buildingCollection,
  pois: poiCollection,
});
assertMarkdownCoverage(contentIds, clickableIds);
assert.equal(stationIds.size, sourceStations.length, 'station ids are generated without Markdown content');
assert.ok([...stationIds].every((id) => !contentIds.has(id)), 'metro stations must use their own panel data');

assert.equal(sourceDistricts.length, Object.keys(areaFixture.districtAreasKm2).length);
assert.equal(sourceLand.filter((feature) => feature.kind !== 'monaco').length, 2);
assert.equal(new Set(sourcePoints.map((point) => point.id)).size, sourcePoints.length, 'source POI ids must be unique');
assert.equal(new Set(sourceStations.map((station) => station.id)).size, sourceStations.length);
assert.equal(sourceRoads.filter((road) => road.roadClass === 'motorway').length, 3);
assert.equal(new Set(sourceTransitLines.map((line) => line.id)).size, sourceTransitLines.length);
const wallStreet = roadCollection.features.find((road) => road.properties?.id === 'wall-street');
const promenade = roadCollection.features.find((road) => road.properties?.id === 'promenade');
assert.equal(surfaces.filter((item) => item.properties?.kind === 'pier' && item.properties?.sector === 'south-coast').length, 7);
const starFerryPiers = surfaces.filter((item) => item.properties?.kind === 'pier' && item.properties?.sector === 'star-ferry');
const fleetPortPiers = surfaces.filter((item) => item.properties?.kind === 'pier' && item.properties?.sector === 'fleet-port');
assert.equal(starFerryPiers.length, 1, 'exactly one dedicated Star Ferry pier is required');
assert.equal(fleetPortPiers.length, 8, 'Fleet Port pier count must remain unchanged');
assert.equal(surfaces.filter((item) => item.properties?.kind === 'pier').length, 16, 'all pier polygons must be preserved');
const sourceStarFerry = sourcePoints.find((item) => item.id === 'star-ferry');
const generatedStarFerry = poiCollection.features.find((item) => item.properties?.id === 'star-ferry');
assert.ok(sourceStarFerry && generatedStarFerry?.geometry?.type === 'Point');
const starFerryFeature = starFerryPiers[0];
assert.ok(starFerryFeature?.geometry?.type === 'Polygon');
const starFerryPolygon = starFerryFeature as Feature<Polygon, Properties>;
assert.equal(starFerryPolygon.properties?.id, sourceStarFerry.id);
assert.equal(starFerryPolygon.properties?.name, sourceStarFerry.name);
assert.ok(booleanPointInPolygon(generatedStarFerry as Feature<Point, Properties>, starFerryPolygon), 'Star Ferry pier must contain its existing POI');
assert.ok(monaco);
const starFerryShoreY = coastlineYAtX(sourceStarFerry.position[0]);
const starFerryLandPoint = point(geographicPosition([sourceStarFerry.position[0], starFerryShoreY + 0.02]));
const starFerrySeaPoint = point(geographicPosition([sourceStarFerry.position[0], starFerryShoreY - 0.02]));
assert.ok(booleanPointInPolygon(starFerryLandPoint, monaco), 'land-side sample must lie on Monaco land');
assert.ok(!booleanPointInPolygon(starFerrySeaPoint, monaco), 'sea-side sample must lie outside Monaco land');
assert.ok(booleanPointInPolygon(starFerryLandPoint, starFerryPolygon), 'Star Ferry pier must reach land');
assert.ok(booleanPointInPolygon(starFerrySeaPoint, starFerryPolygon), 'Star Ferry pier must reach the sea');
assert.ok(Number(wallStreet?.properties?.width) >= 0.018 && Number(wallStreet?.properties?.width) <= 0.02);
assert.equal(promenade?.properties?.width, 0.008);
assert.ok(wallStreet && !parkCollection.features.some((park) => booleanIntersects(wallStreet, park)));
assert.ok(promenade && !parkCollection.features.some((park) => booleanIntersects(promenade, park)));
for (const block of ordinaryBlocks as Feature<Polygon, Properties>[]) {
  const points = walkCoordinates(block.geometry!).map(localPosition);
  const minX = Math.min(...points.map(([x]) => x));
  const maxX = Math.max(...points.map(([x]) => x));
  const maxY = Math.max(...points.map(([, y]) => y));
  const zone = String(block.properties?.zone);
  const roundingToleranceKm = 0.0001;
  if (zone === 'grid') assert.ok(minX >= 0.2 - roundingToleranceKm && maxX <= 9.2 + roundingToleranceKm && Math.min(...points.map(([, y]) => y)) >= 3.55 - roundingToleranceKm);
  if (zone === 'financial') assert.ok(maxX < 2.75 + roundingToleranceKm && maxY < 3.4 + roundingToleranceKm);
  if (zone === 'reclamation') assert.ok(minX >= 2.75 - roundingToleranceKm && maxY < 3.4 + roundingToleranceKm);
}
const monuments = buildings.filter((building) => building.properties?.kind === 'monument');
const monumentIds = new Set(monuments.map((building) => String(building.properties?.id)));
assert.deepEqual([...monumentIds].sort(), ['church', 'old-governors-house', 'republic-monument']);
for (const id of monumentIds) {
  const pieces = monuments.filter((building) => building.properties?.id === id);
  assert.ok(pieces.every((building) => building.properties?.key === 1));
  assert.equal(new Set(pieces.map((building) => building.properties?.name)).size, 1);
  assert.ok(contentIds.has(id));
}
const routeFor = (id: string): Feature<LineString, Properties> => featureById(lineCollection, id) as Feature<LineString, Properties>;
const stationRouteIndex = (route: Feature<LineString, Properties>, id: string): number => {
  const target = localPosition((stationFeatureById.get(id)!.geometry as Point).coordinates);
  return route.geometry.coordinates.findIndex((coordinate) => {
    const position = localPosition(coordinate);
    return Math.hypot(position[0] - target[0], position[1] - target[1]) < 0.005;
  });
};
const u1Route = routeFor('U1');
const u1Positions = u1Route.geometry.coordinates.map(localPosition);
const straitIndex = stationRouteIndex(u1Route, 'station-strait-exchange');
const timesIndex = stationRouteIndex(u1Route, 'station-times-square');
const centralIndex = stationRouteIndex(u1Route, 'station-central-park');
assert.ok(u1Positions.slice(straitIndex, timesIndex + 1).some((position) => Math.hypot(position[0] - 4.5, position[1] - 3.35) < 0.005), 'U1 must use Broadway');
for (let index = timesIndex + 1; index <= centralIndex; index += 1) {
  const midpoint: [number, number] = [(u1Positions[index - 1]![0] + u1Positions[index]![0]) / 2, (u1Positions[index - 1]![1] + u1Positions[index]![1]) / 2];
  assert.ok(fifthAvenue.coordinates.slice(1).some((next, segment) => distanceToSegment(midpoint, fifthAvenue.coordinates[segment]!, next) < 0.005), 'U1 Times Square-Central Park must use Fifth Avenue');
}
const u2Route = routeFor('U2');
const u2Positions = u2Route.geometry.coordinates.map(localPosition);
const continentalIndex = stationRouteIndex(u2Route, 'station-continental-tower');
const exchangeIndex = stationRouteIndex(u2Route, 'station-exchange-square');
const reclamationRoads = roadCollection.features.filter((road) => String(road.properties?.id).startsWith('reclaim-h'));
for (let index = continentalIndex + 1; index <= exchangeIndex; index += 1) {
  const midpoint: [number, number] = [(u2Positions[index - 1]![0] + u2Positions[index]![0]) / 2, (u2Positions[index - 1]![1] + u2Positions[index]![1]) / 2];
  assert.ok(reclamationRoads.some((road) => {
    if (road.geometry?.type !== 'LineString') return false;
    const coordinates = road.geometry.coordinates;
    return coordinates.slice(1).some((next, segment) =>
      distanceToSegment(midpoint, localPosition(coordinates[segment]!), localPosition(next)) < 0.005,
    );
  }), 'U2 Continental Tower-Exchange Square must use the reclamation main road');
}

console.log(`Validated ${names.length} GeoJSON files (${totalBytes} raw bytes), ${districtIds.length} districts, ${contentIds.size} places, ${stationIds.size} stations, and ${buildings.length} building segments.`);
console.log(`Full region: ${fullRegionStats.bidCount} distinct bids, median ${fullRegionStats.medianHeightMeters} m, above 150 m ${fullRegionStats.above150mBids} (${(fullRegionStats.above150mPercent * 100).toFixed(2)}%), above 300 m ${fullRegionStats.above300mBids}, maximum ${fullRegionStats.maximumHeightMeters} m.`);
console.log(`Manhattan: ${manhattanStats.bidCount} distinct bids, median ${manhattanStats.medianHeightMeters} m, above 150 m ${manhattanStats.above150mBids} (${(manhattanStats.above150mPercent * 100).toFixed(2)}%), above 300 m ${manhattanStats.above300mBids}, maximum ${manhattanStats.maximumHeightMeters} m, flat tops among ordinary >90 m ${(flatShare * 100).toFixed(2)}%; gzip ${gzipBytes} bytes; Brotli ${brotliBytes} bytes.`);
console.log(`Beverly: ${beverlyHills.length} source hills, ${hillRoadIds.size} hill roads, ${villas.length} villas; road access within 90 m ${(villaRoadDistances.filter((distance) => distance <= 0.09).length / villas.length * 100).toFixed(2)}%, maximum gap ${(Math.max(...villaRoadDistances) * 1000).toFixed(1)} m; forest coverage ${(beverlyWoodsKm2 / beverlyAreaKm2 * 100).toFixed(2)}%.`);
console.log(`Reserve: ${reserveWoods.length} woods patches covering ${(reserveWoodsKm2 / reserveAreaKm2 * 100).toFixed(2)}%, ${farms.length} farms covering ${(farmAreaKm2 / reserveAreaKm2 * 100).toFixed(2)}%, ${townBlocks.length} towns, ${townHouses.length} houses.`);
console.log(`Section 8.3 Manhattan bare land: ${bareLandSamples}/${totalLandSamples} 100 m samples (${(bareLandSamples / totalLandSamples * 100).toFixed(2)}%) were >60 m from every block or park.`);
