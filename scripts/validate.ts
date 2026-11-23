import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { area, booleanIntersects, booleanValid, booleanWithin, intersect } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, LineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { districts as sourceDistricts, land as sourceLand, points as sourcePoints, roads as sourceRoads, stations as sourceStations, transitLines as sourceTransitLines } from '../data/source';
import { normalizeProse, parseContentDocument } from '../src/content-format';
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
const names = ['land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois', 'blocks', 'trees', 'labels', 'boundaries', 'surface'] as const;
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
} as const;
const fixture = JSON.parse(await readFile(resolve('tests/transit.fixture.json'), 'utf8')) as Record<string, { color: string; stations: string[] }>;

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
    assert.equal(feature.geometry?.type, geometryByFile[name], `${name}[${index}]: wrong geometry type`);
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
        assert.ok(!seenIds.has(id), `${name}: duplicate id ${id}`);
        seenIds.add(id);
      }
    }
  }
  datasets.set(name, parsed);
}
assert.ok(totalBytes <= 10 * 1024 * 1024, 'GeoJSON exceeds 10 MB');
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
  const overlap: Feature<Polygon | MultiPolygon, Properties> | null = intersect({
    type: 'FeatureCollection',
    features: [district, monaco],
  }) as Feature<Polygon | MultiPolygon, Properties> | null;
  assert.ok(overlap && Math.abs(area(overlap) - area(district)) <= area(district) * 1e-6, `district ${String(feature.properties?.id)} must fit in Monaco land`);
}
for (let first = 0; first < districtCollection.features.length; first += 1) {
  for (let second = first + 1; second < districtCollection.features.length; second += 1) {
    assert.equal(intersect({
      type: 'FeatureCollection',
      features: [
        districtCollection.features[first] as Feature<Polygon, Properties>,
        districtCollection.features[second] as Feature<Polygon, Properties>,
      ],
    }), null, 'district polygon interiors must not overlap');
  }
}
const districtArea = districtCollection.features.reduce((sum, feature) => sum + area(feature as Feature<Polygon, Properties>), 0);
assert.ok(Math.abs(districtArea - area(monaco)) < area(monaco) * 2e-8, 'districts must cover the Monaco polygon within six-decimal rounding tolerance');
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
  assert.ok(['motorway', 'arterial', 'street'].includes(roadClass), `invalid road class ${roadClass}`);
  assert.ok(typeof feature.properties?.width === 'number' && feature.properties.width > 0, 'roads must declare positive corridor widths');
  const roadName = requireString(feature.properties!, 'name', 'road');
  if (roadClass === 'arterial' && roadName) namedArterials.add(String(feature.properties!.id));
  if (roadClass === 'street') assert.equal(roadName, '', 'generated streets must remain unnamed');
}
assert.deepEqual([...namedArterials].sort(), ['broadway', 'fifth-avenue', 'promenade', 'queens-road', 'wall-street']);
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
    }
    previousRouteIndex = nearestIndex;
    previousStationId = currentStationId;
  }
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
  assert.ok(['grid', 'financial', 'reclamation', 'landmark', 'uptown-support', 'warehouse'].includes(kind));
  if (feature.properties?.id !== undefined) requireString(feature.properties, 'name', 'landmark building');
}
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
  const firstBase = Number(segments[0]!.properties?.base);
  const bidTop = Number(segments[0]!.properties?.top);
  assert.ok(segments.every((segment) => segment.properties?.supportedBy === supportedBy), bid + ': support reference must be consistent across tiers');
  assert.ok(segments.every((segment) => segment.properties?.top === bidTop), bid + ': building tier tops must agree');
  const isContinentalTower = segments.every((segment) => segment.properties?.id === 'continental-tower');
  if (isContinentalTower) assert.equal(bidTop, 480, 'Continental Tower must reach 480 m');
  else assert.ok(bidTop <= 430, bid + ': non-Continental buildings must not exceed 430 m in any district');
  assertTierContinuity(segments.map((segment) => ({
    base: Number(segment.properties?.base),
    height: Number(segment.properties?.height),
  })), typeof supportedBy === 'string' ? firstBase : 0);
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
    'exchange-square': [[0, 0], [-0.065, -0.008], [0, 0.008], [0.065, -0.008]],
    hospital: [[0, 0], [-0.055, 0], [0, 0], [0.055, 0]],
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
  assert.ok(baseline && Math.abs(actualKm2 - baseline) <= baseline * 0.15, id + ': area must stay within 15% of Phase 1');
}
assertAreaCoverage(districtArea, area(monaco));
const expectedLabelIds = [...districtIds, ...landCollection.features.filter((item) => item.properties?.kind !== 'monaco').map((item) => String(item.properties?.id))];
const labelCollection = datasets.get('labels')!;
assert.equal(labelCollection.features.length, 10, 'exactly ten area labels are required');
assertLabelCoverage(expectedLabelIds, labelCollection.features.map((item) => String(item.properties?.id)));
for (const label of labelCollection.features) {
  assert.ok(label.geometry?.type === 'Point');
  const region = [...districtCollection.features, ...landCollection.features].find((item) => item.properties?.id === label.properties?.id);
  assert.ok(region && booleanWithin(label, region as Feature<Polygon, Properties>), 'label must lie inside its mapped polygon');
}
const blockCollection = datasets.get('blocks')!;
const blocksById = new Map(blockCollection.features.filter((item) => typeof item.properties?.block_id === 'string').map((item) => [String(item.properties?.block_id), item]));
const ordinaryBlocks = blockCollection.features.filter((item) =>
  item.properties?.kind === 'block' && ['grid', 'financial', 'reclamation'].includes(String(item.properties?.zone)),
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
assert.ok(farms.length >= 600 && farms.length <= 1000);
const fleetPiers = surfaces.filter((item) => item.properties?.kind === 'pier' && item.properties?.sector === 'fleet-port');
assert.ok(fleetPiers.length >= 6 && fleetPiers.length <= 10);
const supportCounts = ['city-hall', 'hospital', 'library'].map((id) => new Set(buildings.filter((item) => item.properties?.block_id === 'S-' + id).map((item) => item.properties?.bid)).size);
assert.ok(supportCounts.every((count) => count >= 150 && count <= 300));
assert.ok(buildings.filter((item) => item.properties?.kind === 'uptown-support').every((item) => Number(item.properties?.top) >= 10 && Number(item.properties?.top) <= 45));
assert.ok(buildings.filter((item) => item.properties?.kind === 'warehouse').every((item) => Number(item.properties?.top) <= 25));
const reserve = districtCollection.features.find((item) => item.properties?.id === 'reserve') as Feature<Polygon, Properties>;
assert.ok(buildings.every((item) => !booleanWithin(item, reserve)), 'Reserve must not contain buildings');
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
assert.equal(plazas.length, 4);
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
    assertNoPositiveAreaOverlap(building, plaza as Feature<Polygon, Properties>, 'building footprint must not overlap a plaza');
  }
  const intersectingHoles = plazaHoles.filter((hole) => polygonIntersectionArea(building, hole) > 0.01);
  assert.ok(intersectingHoles.every((hole) => hole === matchingHole),
    'only the landmark assigned to a plaza may occupy its reserved hole');
  if (matchingHole) {
    assert.ok(booleanWithin(building, matchingHole), `${id}: entire footprint must fit its matching plaza hole`);
  } else {
    for (const outer of plazaOuters) {
      assertNoPositiveAreaOverlap(building, outer, 'non-landmark building must stay outside plaza reserves');
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
}
for (const surface of farms) {
  assert.ok(booleanWithin(surface, reserve));
  const coordinates = walkCoordinates(surface.geometry!).map(localPosition);
  const width = Math.max(...coordinates.map((point) => point[0])) - Math.min(...coordinates.map((point) => point[0]));
  const depth = Math.max(...coordinates.map((point) => point[1])) - Math.min(...coordinates.map((point) => point[1]));
  assert.ok(width >= 0.3 && width <= 0.8 && depth >= 0.3 && depth <= 0.8, 'farm tiles must be 300-800 m across');
}
const warehouseBids = new Set(buildings.filter((item) => item.properties?.kind === 'warehouse').map((item) => item.properties?.bid));
assert.ok(warehouseBids.size >= 10 && warehouseBids.size <= 20);
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
  if (zone === 'financial') assert.ok(maxX < 2.55 + roundingToleranceKm && maxY < 3.4 + roundingToleranceKm);
  if (zone === 'reclamation') assert.ok(minX >= 2.75 - roundingToleranceKm && maxY < 3.4 + roundingToleranceKm);
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
