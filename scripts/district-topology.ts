import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { area, booleanPointInPolygon, booleanValid, featureCollection, intersect, point } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { distanceToSegment, pointInRing, reversePath, samePoint, splitPathAtX, splitPathAtY } from '../data/geometry';
import {
  coastline, districtLabelPositions, districts, generatedBoundaries, internalBoundaries, land, stations,
  type Ring, type XY,
} from '../data/source';

export interface DistrictTopologyReport {
  areasKm2: Record<string, number>;
  movedStations: Array<{ id: string; district: string; position: XY }>;
  labelCounts: Record<string, number>;
  monacoAreaKm2: number;
  districtUnionAreaKm2: number;
}

const expectedDistrictIds = ['manhattan', 'central', 'beverly', 'st-germain', 'harlem', 'uptown', 'brooklyn', 'fleet-port', 'reserve'];
const targetAreasKm2: Record<string, number> = {
  beverly: 115,
  harlem: 96,
  brooklyn: 96,
  reserve: 407,
  'st-germain': 128,
  uptown: 128,
};
const phase2AreasKm2: Record<string, number> = {
  manhattan: 96.68181175331127,
  'fleet-port': 102.3748249282795,
};
const phase2GeometryHashes: Record<string, string> = {
  monaco: '2ac93d4b32372523eb76ea1608dbf588816d1e6ba51f9def9a9be7738a114955',
  manhattan: '0386c487eb282573c41b53aad0dd0bcc8215a5cf458e8227968f264c08abd1ee',
};
const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;

export function precisionSliverArea(geometry: Polygon | MultiPolygon, label: string): number {
  const coordinateRoundingMeters = Math.hypot(longitudeScale, latitudeScale) * 0.001;
  const ringsByPolygon = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return ringsByPolygon.reduce((total, rings) => {
    assert.equal(rings.length, 1, `${label}: polygon must only be rounding noise`);
    const ring = rings[0]!;
    assert.equal(ring.length, 4, `${label}: rounding sliver must be a thin triangle`);
    const local = ring.map(([longitude, latitude]): XY => [
      (longitude + 150) * longitudeScale, (latitude - 40) * latitudeScale,
    ]);
    const longestEdgeMeters = Math.max(...local.slice(1).map((position, index) =>
      Math.hypot(position[0] - local[index]![0], position[1] - local[index]![1]) * 1000));
    const sliverAreaMeters = area({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    const widthMeters = 2 * sliverAreaMeters / longestEdgeMeters;
    assert.ok(longestEdgeMeters > 0 && widthMeters <= coordinateRoundingMeters,
      `${label}: substantive area ${sliverAreaMeters.toFixed(3)} m² (width ${widthMeters.toFixed(4)} m)`);
    return total + sliverAreaMeters;
  }, 0);
}

function ringArea(ring: readonly (readonly number[])[]): number {
  const signedArea = ring.slice(1).reduce((sum, position, index) => {
    const previous = ring[index]!;
    return sum + previous[0]! * position[1]! - position[0]! * previous[1]!;
  }, 0) / 2;
  return Math.abs(signedArea);
}

function planarArea(ring: Ring): number {
  return ringArea(ring);
}

function geometryArea(geometry: Polygon | MultiPolygon): number {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, rings) => total + ringArea(rings[0]!) - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

function polygonFeature(ring: Ring): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring.map(([x, y]) => [x, y])] },
  };
}

function intersectionArea(first: Ring, second: Ring): number {
  const overlap = intersect(featureCollection([polygonFeature(first), polygonFeature(second)]));
  return overlap ? geometryArea(overlap.geometry as Polygon | MultiPolygon) : 0;
}

function outputGeometryHash(ring: Ring): string {
  const geometry = {
    type: 'Polygon',
    coordinates: [ring.map(([x, y]) => [
      Number((-150 + x / longitudeScale).toFixed(6)),
      Number((40 + y / latitudeScale).toFixed(6)),
    ])],
  };
  return createHash('sha256').update(JSON.stringify(geometry)).digest('hex');
}

function containsPath(ring: Ring, path: Ring): boolean {
  const uniqueRing = ring.filter((point, index) => index === 0 || !samePoint(point, ring[index - 1]!));
  const uniquePath = path.filter((point, index) => index === 0 || !samePoint(point, path[index - 1]!));
  for (let start = 0; start < uniqueRing.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < uniquePath.length; offset += 1) {
      if (!samePoint(uniqueRing[(start + offset) % uniqueRing.length]!, uniquePath[offset]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

export function validateDistrictTopology(): DistrictTopologyReport {
  const districtById = new Map(districts.map((district) => [district.id, district]));
  assert.deepEqual([...districtById.keys()].sort(), [...expectedDistrictIds].sort(), 'district IDs must remain stable');
  const monaco = land.find((region) => region.kind === 'monaco');
  assert.ok(monaco, 'Monaco land polygon is required');

  for (const [id, expectedHash] of Object.entries(phase2GeometryHashes)) {
    const ring: Ring | undefined = id === 'monaco' ? monaco.ring : districtById.get(id)?.ring;
    assert.ok(ring, `${id} baseline geometry is required`);
    assert.equal(outputGeometryHash(ring), expectedHash, `${id} geometry must remain byte-for-byte identical to Phase 2`);
  }

  const areasKm2 = Object.fromEntries(districts.map((district) => [district.id, planarArea(district.ring)]));
  const fleet = districtById.get('fleet-port')!;
  const fleetBaselineArea = phase2AreasKm2['fleet-port']!;
  assert.ok(Math.abs(areasKm2['fleet-port']! - fleetBaselineArea) <= fleetBaselineArea * 0.005,
    'Fleet Port area must stay within 0.5% of Phase 2');
  const fleetCoast = fleet.ring.filter(p => coastline.slice(1).some((b, i) => distanceToSegment(p, coastline[i]!, b) < 1e-8));
  const fleetCoastCoordinates = fleetCoast.map(([x, y]) => [
    Number((-150 + x / longitudeScale).toFixed(6)), Number((40 + y / latitudeScale).toFixed(6)),
  ]);
  assert.equal(fleetCoast.length, 56, 'Fleet Port coastline vertex count must remain unchanged');
  assert.equal(createHash('sha256').update(JSON.stringify(fleetCoastCoordinates)).digest('hex'),
    '61d083977ca23f292473f049e28c94b132de5633adfb61247c40509009233710',
    'Fleet Port coastline vertices must remain identical to Phase 2');
  for (const [id, neighbour] of [['uptown-fleet-port', 'uptown'], ['fleet-port-reserve', 'reserve']] as const) {
    const boundary = internalBoundaries.find(b => b.id === id)?.coordinates;
    assert.ok(boundary, `${id}: Fleet Port shared boundary is required`);
    assert.ok(containsPath(fleet.ring, boundary) || containsPath(fleet.ring, reversePath(boundary)), `${id}: Fleet Port must use its complete shared boundary`);
    const ring = districtById.get(neighbour)!.ring;
    assert.ok(containsPath(ring, boundary) || containsPath(ring, reversePath(boundary)), `${id}: neighbouring boundary vertices must be identical`);
  }
  assert.ok(areasKm2.central! >= 46 && areasKm2.central! <= 62, 'Central area must be 46–62 km²');
  for (const id of ['manhattan-central', 'st-germain-central', 'central-beverly']) {
    const path = internalBoundaries.find((boundary) => boundary.id === id)?.coordinates;
    assert.ok(path, `${id} boundary is required`);
    const neighbour = id === 'central-beverly' ? 'beverly' : id.split('-central')[0]!;
    assert.ok(containsPath(districtById.get('central')!.ring, path)
      || containsPath(districtById.get('central')!.ring, reversePath(path)), `${id} must bound Central`);
    assert.ok(containsPath(districtById.get(neighbour)!.ring, path)
      || containsPath(districtById.get(neighbour)!.ring, reversePath(path)), `${id} must be shared`);
  }
  for (const [id, target] of Object.entries(targetAreasKm2)) {
    const actual = areasKm2[id]!;
    assert.ok(Math.abs(actual - target) <= target * 0.15, `${id} area ${actual.toFixed(3)} km² must be within 15% of ${target} km²`);
  }
  for (const [id, baseline] of Object.entries(phase2AreasKm2)) {
    const actual = areasKm2[id]!;
    assert.ok(Math.abs(actual - baseline) <= baseline * 0.02, `${id} area ${actual.toFixed(3)} km² must stay within 2% of Phase 2 (${baseline.toFixed(3)} km²)`);
  }

  const monacoFeature = polygonFeature(monaco.ring);
  assert.ok(booleanValid(monacoFeature), 'Monaco land geometry must be valid');
  const monacoAreaKm2 = planarArea(monaco.ring);
  for (const district of districts) {
    const feature = polygonFeature(district.ring);
    assert.ok(booleanValid(feature), `${district.id} geometry must be valid`);
    const outsideArea: number = planarArea(district.ring) - intersectionArea(district.ring, monaco.ring);
    assert.ok(Math.abs(outsideArea) <= 1e-7, `${district.id} must remain inside Monaco land`);
  }
  for (let first = 0; first < districts.length; first += 1) {
    for (let second = first + 1; second < districts.length; second += 1) {
      const overlap = intersectionArea(districts[first]!.ring, districts[second]!.ring);
      assert.ok(overlap <= 1e-7, `${districts[first]!.id} and ${districts[second]!.id} overlap by ${overlap.toFixed(9)} km²`);
    }
  }
  const districtUnionAreaKm2 = Object.values(areasKm2).reduce((sum, area) => sum + area, 0);
  assert.ok(Math.abs(districtUnionAreaKm2 - monacoAreaKm2) <= 0.001, 'districts must tile Monaco without gaps or excess area');

  const eastBoundary = generatedBoundaries.find((boundary) => boundary.id === 'reserve-city-east')?.coordinates;
  const beverlyHarlem = internalBoundaries.find((boundary) => boundary.id === 'beverly-harlem')?.coordinates;
  const harlemBrooklyn = internalBoundaries.find((boundary) => boundary.id === 'harlem-brooklyn')?.coordinates;
  const northBoundary = generatedBoundaries.find((boundary) => boundary.id === 'north-border')?.coordinates;
  assert.ok(eastBoundary && beverlyHarlem && harlemBrooklyn && northBoundary, 'shared district and reserve boundaries are required');
  const [coastTo17, eastUpper] = splitPathAtY(eastBoundary, 17);
  const [eastLower, eastMiddle] = splitPathAtY(coastTo17, 9);
  assert.equal(eastLower.at(-1)![1], 9);
  assert.equal(eastMiddle[0]![1], 9);
  assert.equal(eastMiddle.at(-1)![1], 17);
  assert.equal(eastUpper[0]![1], 17);
  assert.ok(containsPath(districtById.get('beverly')!.ring, eastLower), 'Beverly must use the coast-to-y9 east-edge segment');
  assert.ok(containsPath(districtById.get('harlem')!.ring, eastMiddle), 'Harlem must use the y9-to-y17 east-edge segment');
  assert.ok(containsPath(districtById.get('brooklyn')!.ring, eastUpper), 'Brooklyn must use the y17-to-y25 east-edge segment');
  assert.ok(containsPath(districtById.get('beverly')!.ring, reversePath(beverlyHarlem)), 'Beverly must share its y9 edge with Harlem');
  assert.ok(containsPath(districtById.get('harlem')!.ring, beverlyHarlem), 'Harlem must share its y9 edge with Beverly');
  assert.ok(containsPath(districtById.get('harlem')!.ring, reversePath(harlemBrooklyn)), 'Harlem must share its y17 edge with Brooklyn');
  assert.ok(containsPath(districtById.get('brooklyn')!.ring, harlemBrooklyn), 'Brooklyn must share its y17 edge with Harlem');

  const reserve = districtById.get('reserve')!;
  assert.ok(pointInRing([20, 30], reserve.ring), 'reserve north arm must exist');
  assert.ok(pointInRing([33, 15], reserve.ring), 'reserve east arm must exist');
  assert.ok(!pointInRing([20, 20], reserve.ring), 'reserve must remain one L-shaped polygon');
  assert.ok(containsPath(reserve.ring, reversePath(eastBoundary)), 'reserve must share the complete east edge with the three urban districts');
  const [, splitNorth] = splitPathAtX(northBoundary, 13);
  const reserveNorth = splitNorth.filter((position, index) => index === 0 || !samePoint(position, splitNorth[index - 1]!));
  assert.ok(containsPath(reserve.ring, reversePath(reserveNorth)), 'reserve must separate the cities from the outer north border');
  assert.ok(containsPath(reserve.ring, [[36, 0.2], [36, 34]]), 'reserve must separate the cities from the outer east border');
  const sixCities = ['manhattan', 'central', 'beverly', 'st-germain', 'harlem', 'uptown', 'brooklyn'];
  for (const id of sixCities) {
    const ring = districtById.get(id)!.ring;
    assert.ok(ring.every(([x, y]) => Math.abs(x - 36) > 1e-8 && Math.abs(y - 34) > 1e-8), `${id} must not touch the outer north/east border`);
  }

  const movedStationDistricts: Record<string, string> = {
    'station-beverly': '比弗利区',
    'station-beverly-east': '比弗利区',
    'station-harlem': '哈林区',
    'station-brooklyn': '布鲁克林区',
    'station-reserve-south': '保留地',
  };
  const movedStations = Object.entries(movedStationDistricts).map(([id, districtName]) => {
    const station = stations.find((candidate) => candidate.id === id);
    const district = districts.find((candidate) => candidate.name === districtName);
    assert.ok(station && district, `${id} must have a source station and assigned district`);
    assert.equal(station.district, districtName, `${id} district assignment must remain stable`);
    assert.ok(booleanPointInPolygon(point([...station.position]), polygonFeature(district.ring)), `${id} at ${station.position} must lie in ${districtName}`);
    return { id, district: station.district, position: station.position };
  });

  const regionIds = [
    ...districts.map((district) => district.id),
    ...land.filter((region) => region.kind !== 'monaco' && region.id).map((region) => region.id!),
  ];
  assert.equal(new Set(regionIds).size, regionIds.length, 'mapped region IDs must be unique');
  const labelCounts = Object.fromEntries(regionIds.map((id) => [id, districtLabelPositions[id]?.length ?? 1]));
  assert.equal(labelCounts.reserve, 2, 'reserve must have exactly two labels');
  for (const id of regionIds.filter((id) => id !== 'reserve')) assert.equal(labelCounts[id], 1, `${id} must have one label`);
  assert.equal(Object.values(labelCounts).reduce((sum, count) => sum + count, 0), 12, 'all mapped regions must have exactly twelve labels');

  return { areasKm2, movedStations, labelCounts, monacoAreaKm2, districtUnionAreaKm2 };
}
