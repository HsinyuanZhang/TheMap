import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon, Position } from 'geojson';
import { districts, land, parks, points, roads, stations, transitLines, type Ring, type XY } from './source';

type Properties = Record<string, string | number>;

const outputDirectory = resolve('public/data');
const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;

function coordinate([x, y]: XY): Position {
  return [
    Number((-150 + x / longitudeScale).toFixed(6)),
    Number((40 + y / latitudeScale).toFixed(6)),
  ];
}

function polygon(ring: Ring): Polygon {
  return { type: 'Polygon', coordinates: [ring.map(coordinate)] };
}

function line(coordinates: Ring): LineString {
  return { type: 'LineString', coordinates: coordinates.map(coordinate) };
}

function point(position: XY): Point {
  return { type: 'Point', coordinates: coordinate(position) };
}

function feature<G extends Geometry>(geometry: G, properties: Properties): Feature<G, Properties> {
  return { type: 'Feature', geometry, properties };
}

function collection(features: Feature<Geometry, Properties>[]): FeatureCollection<Geometry, Properties> {
  return { type: 'FeatureCollection', features };
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function distanceToSegment([x, y]: XY, [x1, y1]: XY, [x2, y2]: XY): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + ratio * dx), y - (y1 + ratio * dy));
}

function nearRoad(position: XY, clearance: number): boolean {
  return roads.some((road) => road.coordinates.slice(1).some((next, index) => (
    distanceToSegment(position, road.coordinates[index]!, next) < clearance
  )));
}

function withinPark(position: XY, clearance: number): boolean {
  return parks.some((park) => {
    const xs = park.ring.map(([x]) => x);
    const ys = park.ring.map(([, y]) => y);
    const [x, y] = position;
    return x >= Math.min(...xs) - clearance && x <= Math.max(...xs) + clearance
      && y >= Math.min(...ys) - clearance && y <= Math.max(...ys) + clearance;
  });
}

function generateBuildings(): Feature<Polygon, Properties>[] {
  const random = randomGenerator(0x4d4f4e41);
  const result: Feature<Polygon, Properties>[] = [];
  const occupied: { position: XY; radius: number }[] = [];
  const addBuilding = (
    id: string,
    name: string,
    position: XY,
    width: number,
    depth: number,
    height: number,
    kind: string,
  ) => {
    const [x, y] = position;
    result.push(feature(polygon([
      [x - width / 2, y - depth / 2],
      [x + width / 2, y - depth / 2],
      [x + width / 2, y + depth / 2],
      [x - width / 2, y + depth / 2],
      [x - width / 2, y - depth / 2],
    ]), { id, name, height, kind }));
    occupied.push({ position, radius: Math.hypot(width, depth) / 2 });
  };

  const landmarks = [
    { id: 'strait-exchange', width: 0.32, depth: 0.3, height: 175, kind: 'financial' },
    { id: 'continental-tower', width: 0.42, depth: 0.42, height: 480, kind: 'continental' },
    { id: 'exchange-square', width: 0.8, depth: 0.42, height: 138, kind: 'reclamation' },
    { id: 'city-hall', width: 0.48, depth: 0.42, height: 82, kind: 'public' },
    { id: 'hospital', width: 0.56, depth: 0.5, height: 96, kind: 'public' },
    { id: 'library', width: 0.4, depth: 0.36, height: 54, kind: 'public' },
  ];
  const pointById = new Map(points.map((place) => [place.id, place]));
  for (const landmark of landmarks) {
    const place = pointById.get(landmark.id);
    if (!place) throw new Error(`Missing point definition for landmark ${landmark.id}.`);
    addBuilding(landmark.id, place.name, place.position, landmark.width, landmark.depth, landmark.height, landmark.kind);
  }

  const candidateRows = [4.45, 5.2, 6, 6.8, 7.6, 8.4];
  const candidateColumns = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5];
  let generated = 0;
  for (const baseY of candidateRows) {
    for (const baseX of candidateColumns) {
      const position: XY = [baseX + (random() - 0.5) * 0.06, baseY + (random() - 0.5) * 0.06];
      const width = 0.19 + random() * 0.05;
      const depth = 0.18 + random() * 0.05;
      const clearance = 0.15 + Math.hypot(width, depth) / 2;
      if (withinPark(position, clearance) || nearRoad(position, clearance)) continue;
      if (occupied.some((building) => Math.hypot(position[0] - building.position[0], position[1] - building.position[1]) < clearance + building.radius)) continue;
      const [x, y] = position;
      const kind = x >= 7 ? 'midtown' : 'urban';
      const minHeight = kind === 'midtown' ? 40 : 10;
      const maxHeight = kind === 'midtown' ? 200 : 60;
      const height = minHeight + Math.floor(random() * (maxHeight - minHeight + 1));
      const ring: Ring = [
        [x - width / 2, y - depth / 2],
        [x + width / 2, y - depth / 2],
        [x + width / 2, y + depth / 2],
        [x - width / 2, y + depth / 2],
        [x - width / 2, y - depth / 2],
      ];
      result.push(feature(polygon(ring), { height, kind }));
      occupied.push({ position, radius: Math.hypot(width, depth) / 2 });
      generated += 1;
    }
  }

  for (let index = 0; index < 6; index += 1) {
    for (let offset = 0; offset < 2; offset += 1) {
      const position: XY = [1.4 + index * 1.15, 1.05 + offset * 0.86];
      const width = 0.32;
      const depth = 0.28;
      const clearance = 0.15 + Math.hypot(width, depth) / 2;
      if (nearRoad(position, clearance) || withinPark(position, clearance)) continue;
      if (occupied.some((building) => Math.hypot(position[0] - building.position[0], position[1] - building.position[1]) < clearance + building.radius)) continue;
      const height = 80 + Math.floor(random() * 221);
      const [x, y] = position;
      result.push(feature(polygon([
        [x - width / 2, y - depth / 2],
        [x + width / 2, y - depth / 2],
        [x + width / 2, y + depth / 2],
        [x - width / 2, y + depth / 2],
        [x - width / 2, y - depth / 2],
      ]), { height, kind: 'reclamation' }));
      occupied.push({ position, radius: Math.hypot(width, depth) / 2 });
      generated += 1;
    }
  }

  if (generated > 5000) throw new Error('Generated building count exceeds 5000.');
  return result;
}

async function writeCollection(name: string, features: Feature<Geometry, Properties>[]): Promise<void> {
  const data = collection(features);
  await writeFile(`${outputDirectory}/${name}.geojson`, `${JSON.stringify(data)}\n`, 'utf8');
}

async function build(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const landFeatures = land.map(({ kind, id, name, ring }) => feature(
    polygon(ring),
    { kind, ...(id ? { id, name: name! } : {}) },
  ));
  const districtFeatures = districts.map(({ id, name, kind, ring }) => feature(polygon(ring), { id, name, kind }));
  const parkFeatures = parks.map(({ id, name, ring }) => feature(polygon(ring), { id, name }));
  const roadFeatures = roads.map(({ id, name, roadClass, coordinates }) => feature(line(coordinates), {
    id, name, class: roadClass,
  }));
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const lineFeatures = transitLines.map(({ id, color, stations: stopIds }) => {
    const route = stopIds.map((stationId) => {
      const station = stationById.get(stationId);
      if (!station) throw new Error(`Metro line ${id} references unknown station ${stationId}.`);
      return station.position;
    });
    return feature(line(route), { id, name: id, color, stations: stopIds.join(',') });
  });
  const lineMembership = new Map<string, string[]>();
  for (const route of transitLines) {
    for (const stationId of route.stations) {
      const memberships = lineMembership.get(stationId) ?? [];
      memberships.push(route.id);
      lineMembership.set(stationId, memberships);
    }
  }
  const stationFeatures = stations.map(({ id, name, district, position }) => {
    const memberships = lineMembership.get(id) ?? [];
    return feature(point(position), {
      id, name, district, lines: memberships.join(','), transfer: memberships.length > 1 ? 1 : 0,
    });
  });
  const buildingFeatures = generateBuildings();
  const poiFeatures = points.map(({ id, name, category, district, position }) => feature(point(position), {
    id, name, category, district,
  }));

  await Promise.all([
    writeCollection('land', landFeatures),
    writeCollection('districts', districtFeatures),
    writeCollection('parks', parkFeatures),
    writeCollection('roads', roadFeatures),
    writeCollection('metro_lines', lineFeatures),
    writeCollection('metro_stations', stationFeatures),
    writeCollection('buildings', buildingFeatures),
    writeCollection('pois', poiFeatures),
  ]);
  console.log(`Generated 8 GeoJSON collections (${buildingFeatures.length} building features).`);
}

await build();
