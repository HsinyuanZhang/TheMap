import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { area, booleanIntersects, booleanValid, booleanWithin, intersect } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson';
import { districts as sourceDistricts, land as sourceLand, points as sourcePoints, roads as sourceRoads, stations as sourceStations, transitLines as sourceTransitLines } from '../data/source';
import { normalizeProse, parseContentDocument } from '../src/content-format';
import { assertMarkdownCoverage, collectClickableIds } from './content-links';

type Properties = Record<string, string | number>;
type Collection = FeatureCollection<Geometry, Properties>;

const directory = resolve('public/data');
const placeDirectory = resolve('content/places');
const names = ['land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois'] as const;
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
} as const;
const fixture = JSON.parse(await readFile(resolve('tests/transit.fixture.json'), 'utf8')) as Record<string, { color: string; stations: string[] }>;

function validateProperties(name: string, feature: Feature<Geometry, Properties>): void {
  assert.ok(feature.properties && typeof feature.properties === 'object', `${name}: properties required`);
  for (const [key, value] of Object.entries(feature.properties)) {
    assert.ok(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)), `${name}.${key}: property must be a finite string or number`);
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
      assert.ok(!seenIds.has(id), `${name}: duplicate id ${id}`);
      seenIds.add(id);
    }
  }
  datasets.set(name, parsed);
}
assert.ok(totalBytes <= 5 * 1024 * 1024, `GeoJSON exceeds 5 MB (${totalBytes} bytes)`);

const landCollection = datasets.get('land')!;
const districtCollection = datasets.get('districts')!;
const parkCollection = datasets.get('parks')!;
const roadCollection = datasets.get('roads')!;
const lineCollection = datasets.get('metro_lines')!;
const stationCollection = datasets.get('metro_stations')!;
const buildingCollection = datasets.get('buildings')!;
const poiCollection = datasets.get('pois')!;

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
for (const feature of districtCollection.features) {
  assert.ok(booleanWithin(feature as Feature<Polygon, Properties>, monaco), `district ${String(feature.properties?.id)} must fit in Monaco land`);
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
assert.ok(Math.abs(districtArea - area(monaco)) < area(monaco) * 1e-9, 'districts must cover the Monaco polygon');
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
  const roadName = requireString(feature.properties!, 'name', 'road');
  if (roadClass === 'arterial' && roadName) namedArterials.add(String(feature.properties!.id));
  if (roadClass === 'street') assert.equal(roadName, '', 'generated streets must remain unnamed');
}
assert.deepEqual([...namedArterials].sort(), ['broadway', 'fifth-avenue', 'queens-road', 'wall-street']);
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
assert.equal(lineCollection.features.length, 3, 'three metro lines required');
assert.equal(stationCollection.features.length, 14, 'fourteen unique metro stations required');
const stationIds = new Set(stationCollection.features.map((feature) => requireString(feature.properties!, 'id', 'station')));
assert.equal(stationIds.size, 14);
for (const feature of stationCollection.features) {
  requireString(feature.properties!, 'name', 'station');
  requireString(feature.properties!, 'lines', 'station');
  requireString(feature.properties!, 'district', 'station');
  assert.ok(feature.properties?.transfer === 0 || feature.properties?.transfer === 1, 'station transfer flag must be numeric');
  const id = String(feature.properties?.id ?? '');
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
  assert.deepEqual(feature.geometry.coordinates, stationCoordinates, `${lineId} geometry must follow its ordered stations`);
}
const transfers = stationCollection.features.filter((feature) => feature.properties?.transfer === 1).map((feature) => feature.properties?.id).sort();
assert.deepEqual(transfers, ['station-strait-exchange', 'station-times-square']);
assert.equal(new Set(sourceTransitLines.flatMap((route) => route.stations)).size, 14);

const originPlace = featureById(poiCollection, 'strait-exchange');
assert.ok(originPlace?.geometry?.type === 'Point');
assert.deepEqual(originPlace.geometry.coordinates, [-150, 40], 'exchange must remain at the exact coordinate origin');
for (const feature of poiCollection.features) {
  requireString(feature.properties!, 'id', 'POI');
  requireString(feature.properties!, 'name', 'POI');
  requireString(feature.properties!, 'category', 'POI');
}
const sourcePointIds = new Set(sourcePoints.map((point) => point.id));
const generatedPointIds = new Set(poiCollection.features.map((feature) => requireString(feature.properties!, 'id', 'POI')));
assert.deepEqual([...generatedPointIds].sort(), [...sourcePointIds].sort(), 'generated POI ids must match source point ids');

const buildings = buildingCollection.features as Feature<Polygon, Properties>[];
assert.ok(buildings.length <= 5000, 'building limit is 5000');
for (const feature of buildings) {
  const height = feature.properties?.height;
  assert.ok(typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 480, 'building height must be between 1 and 480 meters');
  const kind = String(feature.properties?.kind ?? '');
  if (kind === 'urban') assert.ok(height >= 10 && height <= 60);
  if (kind === 'midtown') assert.ok(height >= 40 && height <= 200);
  if (kind === 'financial' || kind === 'reclamation') assert.ok(height >= 80 && height <= 300);
  if (feature.properties?.id !== undefined) requireString(feature.properties, 'name', 'landmark building');
}
const tower = buildings.filter((feature) => feature.properties?.id === 'continental-tower');
assert.equal(tower.length, 1);
assert.equal(tower[0]!.properties?.height, 480);
assert.equal(buildings.filter((feature) => feature.properties?.height === 480).length, 1);
const publicLandmarks = buildings.filter((feature) => feature.properties?.kind === 'public');
assert.deepEqual(publicLandmarks.map((feature) => feature.properties?.id).sort(), ['city-hall', 'hospital', 'library']);

const generatedBuildings = buildings.filter((feature) => feature.properties?.id === undefined);
const landmarkBuildings = buildings.filter((feature) => feature.properties?.id !== undefined);
assert.ok(generatedBuildings.length > 0, 'seeded Manhattan building sample required');
for (const landmark of landmarkBuildings) {
  const id = requireString(landmark.properties!, 'id', 'landmark building');
  const poi = featureById(poiCollection, id);
  assert.ok(poi?.geometry?.type === 'Point', `${id}: landmark must have a matching source point`);
  const vertices = walkCoordinates(landmark.geometry!);
  const center: [number, number] = [
    (Math.min(...vertices.map((position) => position[0]!)) + Math.max(...vertices.map((position) => position[0]!))) / 2,
    (Math.min(...vertices.map((position) => position[1]!)) + Math.max(...vertices.map((position) => position[1]!))) / 2,
  ];
  assert.ok(Math.abs(center[0] - poi.geometry.coordinates[0]!) <= 0.000001, `${id}: building longitude must follow its source point`);
  assert.ok(Math.abs(center[1] - poi.geometry.coordinates[1]!) <= 0.000001, `${id}: building latitude must follow its source point`);
}
for (const building of generatedBuildings) {
  assert.ok(!parkCollection.features.some((park) => booleanIntersects(building, park as Feature<Polygon, Properties>)), 'generated building must not overlap a park');
  assert.ok(!landmarkBuildings.some((landmark) => booleanIntersects(building, landmark)), 'generated building must not overlap a landmark');
  const vertices = walkCoordinates(building.geometry!).map(localPosition);
  const center: [number, number] = [
    (Math.min(...vertices.map(([x]) => x)) + Math.max(...vertices.map(([x]) => x))) / 2,
    (Math.min(...vertices.map(([, y]) => y)) + Math.max(...vertices.map(([, y]) => y))) / 2,
  ];
  const clearance = 0.15 + Math.hypot(
    Math.max(...vertices.map(([x]) => x)) - Math.min(...vertices.map(([x]) => x)),
    Math.max(...vertices.map(([, y]) => y)) - Math.min(...vertices.map(([, y]) => y)),
  ) / 2;
  for (const road of sourceRoads) {
    const points = road.coordinates;
    for (let index = 1; index < points.length; index += 1) {
      assert.ok(distanceToSegment(center, points[index - 1]!, points[index]!) >= clearance - 0.003, 'generated building must stay outside road corridors');
    }
  }
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
assert.equal(stationIds.size, 14, 'station ids are generated without Markdown content');
assert.ok([...stationIds].every((id) => !contentIds.has(id)), 'metro stations must use their own panel data');

assert.equal(sourceDistricts.length, 8);
assert.equal(sourceLand.filter((feature) => feature.kind !== 'monaco').length, 2);
assert.equal(new Set(sourcePoints.map((point) => point.id)).size, sourcePoints.length, 'source POI ids must be unique');
assert.equal(sourceStations.length, 14);
assert.equal(sourceRoads.filter((road) => road.roadClass === 'motorway').length, 3);
assert.equal(sourceTransitLines.length, 3);

console.log(`Validated ${names.length} GeoJSON files (${totalBytes} bytes), ${districtIds.length} districts, ${contentIds.size} places, ${stationIds.size} stations, and ${buildings.length} buildings.`);
