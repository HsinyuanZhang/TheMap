import {
  booleanDisjoint, booleanValid, booleanWithin, buffer, difference, featureCollection, intersect, isobands, isolines,
  lineIntersect, lineString, point, pointOnFeature, simplify, voronoi,
} from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from "geojson";
import {
  closeRing, distanceToSegment, pointInRing, polygonArea, rectangleRing, reversePath,
} from "./geometry";
import { airport, airportAircraft, airportApron, airportPiers, airportPosition, airportRing, airportRunways, airportTaxiways } from "./phase4-config";
import { metroPaths, regionalArterials } from "./phase4-roads";
import { cleanRoundedPath, finalizeRoadNetwork, prepareRoadNetwork } from "./phase4-network";
import { roundHillroadTurns } from "./hillroad-arcs";
import { beverlyHeight } from "../src/terrain-elevation";
import {
  coastline, coastlineYAtX, districts, generatedBoundaries, land, parks, points,
  districtLabelPositions, reserveTownCenters, roads as sourceRoads, stations, transitLines, urbanGrid,
  type RoadDefinition, type Ring, type XY,
} from "./source";

type Properties = Record<string, string | number | boolean>;
type GeoFeature = Feature<Geometry, Properties>;
type Collection = FeatureCollection<Geometry, Properties>;

const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;
export const keyBuildingThresholdMeters = 210;
const coordinate = ([x, y]: XY): Position => [
  Number((-150 + x / longitudeScale).toFixed(6)),
  Number((40 + y / latitudeScale).toFixed(6)),
];
const localFromCoordinate = ([longitude, latitude]: Position): XY => [
  (longitude! + 150) * longitudeScale,
  (latitude! - 40) * latitudeScale,
];

function polygonGeometry(rings: readonly Ring[]): Polygon {
  const geometry: Polygon = { type: "Polygon", coordinates: rings.map((ring, index) => {
    const signedArea = ring.slice(1).reduce((sum, point, offset) => {
      const previous = ring[offset]!;
      return sum + previous[0] * point[1] - point[0] * previous[1];
    }, 0);
    const wantsPositive = index === 0;
    const oriented = (signedArea > 0) === wantsPositive ? ring : reversePath(ring);
    const result: Position[] = [];
    for (const point of oriented.map(coordinate)) {
      const previous = result[result.length - 1];
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) result.push(point);
    }
    if (result.length > 0 && (result[0]![0] !== result.at(-1)![0] || result[0]![1] !== result.at(-1)![1])) result.push(result[0]!);
    if (result.length < 4) throw new Error("Polygon ring collapsed at six-decimal coordinate precision.");
    return result;
  }) };
  if (booleanValid(geometry)) return geometry;
  const repaired = simplify({ type: "Feature", properties: {}, geometry }, { tolerance: 0.000001, highQuality: true }).geometry;
  if (!booleanValid(repaired)) throw new Error("Polygon is invalid after six-decimal coordinate rounding.");
  return repaired;
}
const lineGeometry = (coordinates: readonly XY[]): LineString => ({ type: "LineString", coordinates: coordinates.map(coordinate) });
const pointGeometry = (position: XY): Point => ({ type: "Point", coordinates: coordinate(position) });
const feature = <G extends Geometry>(geometry: G, properties: Properties): Feature<G, Properties> => ({ type: "Feature", geometry, properties });
const collection = (features: GeoFeature[]): Collection => ({ type: "FeatureCollection", features });
const close = (ring: readonly XY[]): Ring => closeRing(ring);

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = rng(0x4d4f4e41);
let landRand = rng(0x4c414e44);
const localPolygon = (ring: Ring): Feature<Polygon> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [ring.map(([x, y]) => [x, y])] },
});
const within = (ring: Ring, container: Ring): boolean => booleanWithin(localPolygon(ring), localPolygon(container));
const disjoint = (a: Ring, b: Ring): boolean => booleanDisjoint(localPolygon(a), localPolygon(b));

function localPolygonWithHoles(rings: readonly Ring[]): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: rings.map((ring) => ring.map(([x, y]) => [x, y])) },
  };
}

function polygonPieces(geometry: Polygon | MultiPolygon): Ring[][] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((rings) => rings.map((ring) => ring.map(([x, y]) => [x, y] as XY)));
}

function bufferedLocalGeometry(geographicGeometry: Polygon | MultiPolygon, distanceKm: number): Feature<Polygon | MultiPolygon, Properties> {
  const padded = buffer(feature(geographicGeometry, {}), distanceKm, { units: "kilometers" }) ?? feature(geographicGeometry, {});
  const geographicPolygons = padded.geometry.type === "Polygon" ? [padded.geometry.coordinates] : padded.geometry.coordinates;
  const polygons: Position[][][] = geographicPolygons.map((polygon) => polygon.map((ring) => {
    const localRing = close(ring.map((position) => localFromCoordinate([position[0]!, position[1]!])));
    return localRing.map(([x, y]): Position => [x, y]);
  }));
  if (polygons.length === 1) return feature({ type: "Polygon", coordinates: polygons[0]! }, {});
  return feature({ type: "MultiPolygon", coordinates: polygons }, {});
}

function intersectWithRing(rings: readonly Ring[], clip: Ring): Ring[][] {
  const overlap = intersect(featureCollection([localPolygonWithHoles(rings), localPolygon(clip)]));
  return overlap ? polygonPieces(overlap.geometry) : [];
}

function subtractPolygon(
  subject: Feature<Polygon | MultiPolygon>,
  obstacle: Feature<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> | null {
  return difference(featureCollection([subject, obstacle]));
}

function planarArea(rings: readonly Ring[]): number {
  return rings.reduce((sum, ring, index) => sum + (index === 0 ? 1 : -1) * polygonArea(ring), 0);
}

function roadBufferRing(start: XY, end: XY, radius: number): Ring | undefined {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;
  const offset: XY = [-dy / length * radius, dx / length * radius];
  const extendedStart: XY = [start[0] - dx / length * radius, start[1] - dy / length * radius];
  const extendedEnd: XY = [end[0] + dx / length * radius, end[1] + dy / length * radius];
  return close([
    [extendedStart[0] + offset[0], extendedStart[1] + offset[1]],
    [extendedEnd[0] + offset[0], extendedEnd[1] + offset[1]],
    [extendedEnd[0] - offset[0], extendedEnd[1] - offset[1]],
    [extendedStart[0] - offset[0], extendedStart[1] - offset[1]],
  ]);
}

function clipBlockPieces(
  ring: Ring,
  districtRing: Ring,
  roads: RoadIndex,
  coast: RoadIndex,
): Ring[][] {
  let pieces = intersectWithRing([ring], districtRing);
  const candidates = [
    ...parks.map((park) => localPolygon(park.ring)),
    ...plazaExclusions.map((exclusion) => localPolygon(exclusion)),
    ...nearbyRoadSegments(ring, roads, 0.04).map((segment) => roadBufferRing(segment.start, segment.end, segment.width / 2 + 0.01))
      .filter((buffer): buffer is Ring => buffer !== undefined).map(localPolygon),
    ...nearbyRoadSegments(ring, coast, 0.04).map((segment) => roadBufferRing(segment.start, segment.end, segment.width / 2))
      .filter((buffer): buffer is Ring => buffer !== undefined).map(localPolygon),
  ];
  for (const obstacle of candidates) {
    const next: Ring[][] = [];
    for (const polygon of pieces) {
      const differenceResult = subtractPolygon(localPolygonWithHoles(polygon), obstacle);
      if (differenceResult) next.push(...polygonPieces(differenceResult.geometry));
    }
    pieces = next;
    if (pieces.length === 0) break;
  }
  return pieces.filter((polygon) => planarArea(polygon) >= 0.0015);
}
const monaco = land.find((item) => item.kind === "monaco")!;
const districtById = new Map(districts.map((district) => [district.id, district]));
const pointById = new Map(points.map((point) => [point.id, point]));
const parkById = new Map(parks.map((park) => [park.id, park]));

function cross(a: XY, b: XY): number {
  return a[0] * b[1] - a[1] * b[0];
}
function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  const ab: XY = [b[0] - a[0], b[1] - a[1]];
  const cd: XY = [d[0] - c[0], d[1] - c[1]];
  const denominator = cross(ab, cd);
  if (Math.abs(denominator) > 1e-10) {
    const ac: XY = [c[0] - a[0], c[1] - a[1]];
    const t = cross(ac, cd) / denominator;
    const u = cross(ac, ab) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    distanceToSegment(a, c, d), distanceToSegment(b, c, d),
    distanceToSegment(c, a, b), distanceToSegment(d, a, b),
  );
}

interface RoadSegment {
  start: XY;
  end: XY;
  width: number;
}

type RoadIndex = Map<string, RoadSegment[]>;
const roadCellSize = 0.25;
const roadCellKey = (x: number, y: number) => x + ":" + y;

function buildRoadIndex(roads: readonly RoadDefinition[]): RoadIndex {
  const index: RoadIndex = new Map();
  for (const road of roads) {
    for (let segmentIndex = 1; segmentIndex < road.coordinates.length; segmentIndex += 1) {
      const segment: RoadSegment = {
        start: road.coordinates[segmentIndex - 1]!,
        end: road.coordinates[segmentIndex]!,
        width: road.width,
      };
      const radius = road.width / 2;
      const minX = Math.floor((Math.min(segment.start[0], segment.end[0]) - radius) / roadCellSize);
      const maxX = Math.floor((Math.max(segment.start[0], segment.end[0]) + radius) / roadCellSize);
      const minY = Math.floor((Math.min(segment.start[1], segment.end[1]) - radius) / roadCellSize);
      const maxY = Math.floor((Math.max(segment.start[1], segment.end[1]) + radius) / roadCellSize);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = roadCellKey(x, y);
          const bucket = index.get(key) ?? [];
          bucket.push(segment);
          index.set(key, bucket);
        }
      }
    }
  }
  return index;
}

function nearbyRoadSegments(ring: Ring, index: RoadIndex, extra: number): RoadSegment[] {
  const minX = Math.floor((Math.min(...ring.map(([x]) => x)) - extra) / roadCellSize);
  const maxX = Math.floor((Math.max(...ring.map(([x]) => x)) + extra) / roadCellSize);
  const minY = Math.floor((Math.min(...ring.map(([, y]) => y)) - extra) / roadCellSize);
  const maxY = Math.floor((Math.max(...ring.map(([, y]) => y)) + extra) / roadCellSize);
  const candidates = new Set<RoadSegment>();
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (const segment of index.get(roadCellKey(x, y)) ?? []) candidates.add(segment);
    }
  }
  return [...candidates];
}

function polygonRoadIntrusion(ring: Ring, road: RoadSegment, extra = 0): boolean {
  const clearance = road.width / 2 + extra;
  for (let edge = 1; edge < ring.length; edge += 1) {
    if (segmentDistance(road.start, road.end, ring[edge - 1]!, ring[edge]!) < clearance - 1e-7) return true;
  }
  return pointInRing(road.start, ring);
}

function centerOf(ring: Ring): XY {
  const points = ring.slice(0, -1);
  return [
    points.reduce((sum, [x]) => sum + x, 0) / points.length,
    points.reduce((sum, [, y]) => sum + y, 0) / points.length,
  ];
}

function addRoad(
  output: RoadDefinition[],
  id: string,
  name: string,
  roadClass: RoadDefinition["roadClass"],
  width: number,
  coordinates: readonly XY[],
): void {
  const path: XY[] = [coordinates[0]!];
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const steps = roadClass === "hillroad" ? Math.max(1, Math.ceil(distance / 0.5)) : 1;
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      path.push([start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio]);
    }
  }
  output.push({ id, name, roadClass, width, coordinates: path });
}

function clipRoadsAroundLandmarks(roads: readonly RoadDefinition[], sites: readonly Ring[]): RoadDefinition[] {
  const siteBounds = sites.map((ring) => ({
    minX: Math.min(...ring.map(([x]) => x)),
    maxX: Math.max(...ring.map(([x]) => x)),
    minY: Math.min(...ring.map(([, y]) => y)),
    maxY: Math.max(...ring.map(([, y]) => y)),
  }));
  const clippedRoads: RoadDefinition[] = [];
  for (const road of roads) {
    if (road.roadClass === "arterial" && road.name) {
      clippedRoads.push(road);
      continue;
    }
    const exclusions = siteBounds.map((bounds) => ({
      minX: bounds.minX - road.width / 2 - 0.001,
      maxX: bounds.maxX + road.width / 2 + 0.001,
      minY: bounds.minY - road.width / 2 - 0.001,
      maxY: bounds.maxY + road.width / 2 + 0.001,
    }));
    const pieces: XY[][] = [];
    let clipped = false;
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const start = road.coordinates[index - 1]!;
      const end = road.coordinates[index]!;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const intervals: [number, number][] = [];
      for (const bounds of exclusions) {
        let enter = 0;
        let exit = 1;
        for (const [origin, delta, minimum, maximum] of [
          [start[0], dx, bounds.minX, bounds.maxX],
          [start[1], dy, bounds.minY, bounds.maxY],
        ]) {
          if (Math.abs(delta) < 1e-12) {
            if (origin < minimum || origin > maximum) {
              enter = 1;
              exit = 0;
              break;
            }
          } else {
            const first = (minimum - origin) / delta;
            const second = (maximum - origin) / delta;
            enter = Math.max(enter, Math.min(first, second));
            exit = Math.min(exit, Math.max(first, second));
          }
        }
        if (enter <= exit && exit >= 0 && enter <= 1) intervals.push([Math.max(0, enter), Math.min(1, exit)]);
      }
      if (intervals.length > 0) clipped = true;
      intervals.sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      const appendOutside = (from: number, to: number): void => {
        if (to - from <= 1e-9) return;
        const first: XY = [start[0] + dx * from, start[1] + dy * from];
        const last: XY = [start[0] + dx * to, start[1] + dy * to];
        const previous = pieces.at(-1);
        const endpoint = previous?.at(-1);
        if (previous && endpoint && Math.hypot(endpoint[0] - first[0], endpoint[1] - first[1]) < 1e-8) previous.push(last);
        else pieces.push([first, last]);
      };
      for (const [from, to] of intervals) {
        appendOutside(cursor, from);
        cursor = Math.max(cursor, to);
      }
      appendOutside(cursor, 1);
    }
    if (!clipped) clippedRoads.push(road);
    else for (const [index, coordinates] of pieces.entries()) {
      clippedRoads.push({ ...road, id: `${road.id}-part-${index}`, coordinates });
    }
  }
  return clippedRoads;
}

function clipLineAtParks(a: XY, b: XY, parksToAvoid: readonly { ring: Ring }[]): XY[][] {
  const samples = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.025));
  const pieces: XY[][] = [];
  let current: XY[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const point: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const blocked = parksToAvoid.some((park) => pointInRing(point, park.ring));
    if (blocked) {
      if (current.length > 1) pieces.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

function generateRoadNetwork(): RoadDefinition[] {
  const result = [...sourceRoads];
  let sequence = 0;

  for (const [id, coordinates] of metroPaths()) addRoad(result, `metro-corridor-${id}`, "", "local", 0.022, coordinates);

  const grid = urbanGrid.grid;
  for (let x = grid.west; x + grid.blockWidth <= grid.east; x += grid.stepX) {
    const lineX = Number((x + grid.blockWidth + (grid.stepX - grid.blockWidth) / 2).toFixed(6));
    const segments = clipLineAtParks([lineX, 3.42], [lineX, 9.18], parks);
    for (const coordinates of segments) addRoad(result, "grid-v-" + sequence++, "", "street", 0.024, coordinates);
  }
  for (let y = grid.south; y <= 9.15; y += grid.stepY) {
    const lineY = Number((y + grid.blockDepth + (grid.stepY - grid.blockDepth) / 2).toFixed(6));
    const segments = clipLineAtParks([0.15, lineY], [9.35, lineY], parks);
    for (const coordinates of segments) addRoad(result, "grid-h-" + sequence++, "", "street", 0.018, coordinates);
  }

  const financial = urbanGrid.financial;
  const angle = financial.angleDegrees * Math.PI / 180;
  const origin: XY = [0.15, 0.75];
  const rotate = (u: number, v: number): XY => [
    origin[0] + u * Math.cos(angle) - v * Math.sin(angle),
    origin[1] + u * Math.sin(angle) + v * Math.cos(angle),
  ];
  for (let u = financial.bounds[0]; u + financial.blockWidth < financial.bounds[2]; u += financial.stepX) {
    const lineU = u + financial.blockWidth + (financial.stepX - financial.blockWidth) / 2;
    const a = rotate(lineU, financial.bounds[1]);
    const b = rotate(lineU, financial.bounds[3]);
    for (const segment of clipLineAtParks(a, b, parks)) addRoad(result, "finance-v-" + sequence++, "", "street", financial.roadWidth, segment);
  }
  for (let v = financial.bounds[1]; v + financial.blockDepth < financial.bounds[3]; v += financial.stepY) {
    const lineV = v + financial.blockDepth + (financial.stepY - financial.blockDepth) / 2;
    const a = rotate(financial.bounds[0], lineV);
    const b = rotate(financial.bounds[2], lineV);
    for (const segment of clipLineAtParks(a, b, parks)) addRoad(result, "finance-h-" + sequence++, "", "street", financial.roadWidth, segment);
  }

  const reclamation = urbanGrid.reclamation;
  const reclamationAngle = reclamation.angleDegrees * Math.PI / 180;
  const reclamationOrigin: XY = [reclamation.bounds[0], reclamation.bounds[1]];
  const rotateReclamation = (point: XY): XY => {
    const dx = point[0] - reclamationOrigin[0];
    const dy = point[1] - reclamationOrigin[1];
    return [
      reclamationOrigin[0] + dx * Math.cos(reclamationAngle) - dy * Math.sin(reclamationAngle),
      reclamationOrigin[1] + dx * Math.sin(reclamationAngle) + dy * Math.cos(reclamationAngle),
    ];
  };
  for (let x = reclamation.bounds[0]; x <= reclamation.bounds[2]; x += reclamation.stepX) {
    const centerX = x + reclamation.blockWidth + 0.015;
    const a = rotateReclamation([centerX, reclamation.bounds[1]]);
    const b = rotateReclamation([centerX, reclamation.bounds[3]]);
    for (const segment of clipLineAtParks(a, b, parks)) addRoad(result, "reclaim-v-" + sequence++, "", "street", reclamation.roadWidth, segment);
  }
  for (let y = reclamation.bounds[1]; y <= reclamation.bounds[3]; y += reclamation.stepY) {
    const lineY = y + reclamation.blockDepth + reclamation.roadWidth / 2;
    const a = rotateReclamation([reclamation.bounds[0], lineY]);
    const b = rotateReclamation([reclamation.bounds[2], lineY]);
    for (const segment of clipLineAtParks(a, b, parks)) addRoad(result, "reclaim-h-" + sequence++, "", "street", reclamation.roadWidth, segment);
  }

  return result;
}

const hotspots = [
  { center: [0.1, 0.3] as XY, peak: 340, sigma: 0.8, a: 0.45, k: 1 },
  { center: [4.6, 1.5] as XY, peak: 330, sigma: 1.5, a: 0.1, k: 3 },
  { center: [7.1, 5.4] as XY, peak: 280, sigma: 1, a: 0, k: 6 },
];

function distanceToPath(position: XY, coordinates: readonly XY[]): number {
  return Math.min(...coordinates.slice(1).map((next, index) => distanceToSegment(position, coordinates[index]!, next)));
}

const fifthRoad = sourceRoads.find((road) => road.id === "fifth-avenue")!;

function buildingHeight(position: XY): number {
  const u1 = rand();
  const u2 = rand();
  let height = 10 + 26 * u1;
  for (const hotspot of hotspots) {
    const distance = Math.hypot(position[0] - hotspot.center[0], position[1] - hotspot.center[1]);
    height += hotspot.peak * Math.exp(-(distance * distance) / (2 * hotspot.sigma * hotspot.sigma))
      * (hotspot.a + (1 - hotspot.a) * u2 ** hotspot.k);
  }
  const fifthDistance = distanceToPath(position, fifthRoad.coordinates);
  height += 70 * Math.exp(-(fifthDistance * fifthDistance) / (2 * 0.2 ** 2)) * rand();
  if (hotspots.every((hotspot) => Math.hypot(position[0] - hotspot.center[0], position[1] - hotspot.center[1]) > 2.5 * hotspot.sigma) && fifthDistance > 0.2) {
    height = Math.min(height, 89);
  }
  return Math.min(430, Math.max(12, Math.round(height)));
}

const buildingFeatures: Feature<Polygon, Properties>[] = [];
const blockFeatures: Feature<Polygon, Properties>[] = [];
let nextBuildingId = 0;
let nextBlockId = 0;

function localRect(center: XY, width: number, depth: number, angle = 0, origin: XY = center): Ring {
  return rectangleRing(center, width, depth, angle * Math.PI / 180, origin);
}

function buildingSegments(
  position: XY,
  width: number,
  depth: number,
  top: number,
  kind: string,
  blockId: string,
  angle = 0,
  landmark?: { id: string; name: string; color?: string },
  fixedTiers?: readonly { base?: number; top: number; width: number; depth: number }[],
  supportedBy?: string,
): string {
  const bid = landmark ? "L-" + landmark.id + "-" + nextBuildingId++ : "B" + String(nextBuildingId++).padStart(5, "0");
  const generatedSegments = fixedTiers ?? (() => {
    const isFlat = top > 90 && rand() < 0.3;
    const baseFractions = top > 170 ? [0, 0.16, 0.72, 0.93, 1] : top > 90 ? [0, 0.25, 1] : [0, 1];
    if (isFlat) return [{ base: 0, top, width, depth }];
    const scaleFactors = top > 170 ? [1, 0.8, 0.58, 0.3] : top > 90 ? [1, 0.78] : [1];
    const fractions = [...baseFractions];
    for (let index = 1; index < fractions.length - 1; index += 1) {
      const previous = fractions[index - 1]!;
      const current = fractions[index]!;
      const next = fractions[index + 1]!;
      const perturbation = (rand() - 0.5) * 0.2 * Math.min(current - previous, next - current);
      fractions[index] = current + perturbation;
    }
    let previousWidth = width;
    let previousDepth = depth;
    return scaleFactors.map((scale, index) => {
      const tierWidth = index === 0 ? width : Math.min(width * scale * (0.9 + rand() * 0.2), previousWidth - 0.002);
      const tierDepth = index === 0 ? depth : Math.min(depth * scale * (0.9 + rand() * 0.2), previousDepth - 0.002);
      previousWidth = tierWidth;
      previousDepth = tierDepth;
      return {
        base: index === 0 ? 0 : Math.round(top * fractions[index]!),
        top: Math.round(top * fractions[index + 1]!),
        width: tierWidth,
        depth: tierDepth,
      };
    });
  })();
  const segments = supportedBy && (generatedSegments[0]?.base ?? 0) > 0
    ? [{ base: 0, top: generatedSegments[0]!.base!, width, depth }, ...generatedSegments]
    : generatedSegments;
  const key = landmark || kind === "monument" || top >= keyBuildingThresholdMeters ? 1 : 0;

  let base = 0;
  for (const segment of segments) {
    const segmentBase = segment.base ?? base;
    const ring = localRect(position, segment.width, segment.depth, angle);
    const props: Properties = {
      bid, base: segmentBase, height: segment.top, top, key, kind, block_id: blockId,
      ...(landmark ? { id: landmark.id, name: landmark.name, ...(landmark.color ? { color: landmark.color } : {}) } : {}),
      ...(supportedBy ? { supportedBy } : {}),
    };
    buildingFeatures.push(feature(polygonGeometry([ring]), props));
    base = segment.top;
  }
  return bid;
}

const plazaExclusions: Ring[] = [];
const roadExclusions: Ring[] = [];

function footprintAllowed(ring: Ring, roads: RoadIndex, extra = 0): boolean {
  if (!within(ring, monaco.ring)) return false;
  if (parks.some((park) => !disjoint(ring, park.ring))) return false;
  if (plazaExclusions.some((plaza) => !disjoint(ring, plaza))) return false;
  if (nearbyRoadSegments(ring, roads, extra).some((road) => polygonRoadIntrusion(ring, road, extra))) return false;
  return true;
}

function addBlock(ring: Ring, zone: string, kind = "block"): string {
  return addBlockPolygon([ring], zone, kind);
}

function addBlockPolygon(rings: readonly Ring[], zone: string, kind = "block"): string {
  const blockId = "M" + String(nextBlockId++).padStart(5, "0");
  blockFeatures.push(feature(polygonGeometry(rings), { block_id: blockId, kind, zone }));
  return blockId;
}

function generateBlockBuildings(
  ring: Ring,
  zone: string,
  width: number,
  depth: number,
  roads: RoadIndex,
  coast: RoadIndex,
  angle = 0,
  rows = 1,
  allowOutsideGrid = false,
  blockZone = zone,
): void {
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (zone === "grid" && !allowOutsideGrid && (minX < 0.2 - 1e-7 || maxX > 9.2 + 1e-7 || minY < 3.55 - 1e-7 || maxY > 9.2 + 1e-7)) return;
  if (zone === "financial" && (maxX >= 2.75 || maxY >= 3.4)) return;
  if (zone === "reclamation" && (minX < 2.75 || maxY >= 3.4)) return;
  const pieces = clipBlockPieces(ring, districtById.get("manhattan")!.ring, roads, coast);
  const sourceCenter = centerOf(ring);
  const radians = angle * Math.PI / 180;
  const widthAxis: XY = [Math.cos(radians), Math.sin(radians)];
  const depthAxis: XY = [-Math.sin(radians), Math.cos(radians)];
  const alongWidth = width >= depth;
  const longAxis = alongWidth ? widthAxis : depthAxis;
  const crossAxis = alongWidth ? depthAxis : widthAxis;
  const longSize = alongWidth ? width : depth;
  const crossSize = alongWidth ? depth : width;
  for (const piece of pieces) {
    const exterior = piece[0]!;
    const blockId = addBlockPolygon(piece, blockZone);
    const exportedBlock = blockFeatures.at(-1)!;
    const longSetback = 0.006;
    const edgeSetback = 0.004;
    const gap = 0.006;
    const alongCoordinates = exterior.map(([x, y]) =>
      (x - sourceCenter[0]) * longAxis[0] + (y - sourceCenter[1]) * longAxis[1]);
    const crossCoordinates = exterior.map(([x, y]) =>
      (x - sourceCenter[0]) * crossAxis[0] + (y - sourceCenter[1]) * crossAxis[1]);
    const longStart = Math.max(-longSize / 2 + longSetback, Math.min(...alongCoordinates) + longSetback);
    const longEnd = Math.min(longSize / 2 - longSetback, Math.max(...alongCoordinates) - longSetback);
    const crossStart = Math.max(-crossSize / 2 + edgeSetback, Math.min(...crossCoordinates) + edgeSetback);
    const crossEnd = Math.min(crossSize / 2 - edgeSetback, Math.max(...crossCoordinates) - edgeSetback);
    const availableCross = crossEnd - crossStart;
    if (longEnd - longStart < 0.05 || availableCross <= 0) continue;
    const minimumRowDepth = 0.02;
    const rowsCount = Math.min(rows, Math.max(1, Math.floor((availableCross + gap) / (minimumRowDepth + gap))));
    const rowDepth = (availableCross - (rowsCount - 1) * gap) / rowsCount;
    for (let row = 0; row < rowsCount; row += 1) {
      let offset = longStart;
      const rowCenter = crossStart + rowDepth / 2 + row * (rowDepth + gap);
      while (offset + 0.05 <= longEnd + 1e-7) {
        const lotWidth = Math.min(0.05 + rand() * 0.025, longEnd - offset);
        if (lotWidth < 0.05) break;
        const localX = offset + lotWidth / 2;
        const position: XY = [
          sourceCenter[0] + longAxis[0] * localX + crossAxis[0] * rowCenter,
          sourceCenter[1] + longAxis[1] * localX + crossAxis[1] * rowCenter,
        ];
        if (rand() >= 0.04) {
          const roundingSetback = blockZone === "residual" ? 0.0015 : 0;
          const buildingWidth = (alongWidth ? lotWidth : rowDepth) - roundingSetback * 2;
          const buildingDepth = (alongWidth ? rowDepth : lotWidth) - roundingSetback * 2;
          const footprint = localRect(position, buildingWidth, buildingDepth, angle);
          if (booleanWithin(localPolygon(footprint), localPolygonWithHoles(piece))
            && booleanWithin(feature(polygonGeometry([footprint]), {}), exportedBlock)
            && footprintAllowed(footprint, roads, 0)) {
            const top = buildingHeight(position);
            buildingSegments(position, buildingWidth, buildingDepth, top, zone, blockId, angle);
          }
        }
        offset += lotWidth + gap;
      }
    }
  }
}

function addPlazaAndLandmarks(): void {
  plazaExclusions.length = 0;
  roadExclusions.length = 0;
  const strait = pointById.get("strait-exchange")!;
  const continental = pointById.get("continental-tower")!;
  const straitOuter = localRect(strait.position, 0.2, 0.2);
  const straitHole = localRect(strait.position, 0.18, 0.18);
  plazaExclusions.push(straitOuter);
  blockFeatures.push(feature(polygonGeometry([straitOuter, reversePath(straitHole)]), { kind: "plaza", zone: "manhattan" }));
  const towerOuter = localRect(continental.position, 0.2, 0.2);
  const towerHole = localRect(continental.position, 0.16, 0.18);
  plazaExclusions.push(towerOuter);
  blockFeatures.push(feature(polygonGeometry([towerOuter, reversePath(towerHole)]), { kind: "plaza", zone: "manhattan" }));
  const timesSquare = pointById.get("times-square")!;
  const timesSquareRing = localRect(timesSquare.position, 0.15, 0.25);
  plazaExclusions.push(timesSquareRing);
  blockFeatures.push(feature(polygonGeometry([timesSquareRing]), { kind: "plaza", zone: "manhattan" }));

  const straitCenter: XY = [strait.position[0] - 0.05, strait.position[1] + 0.05];
  const straitFootprint = localRect(straitCenter, 0.07, 0.07);
  const straitBlock = addBlock(straitFootprint, "landmark", "block");
  const towerCenter: XY = [continental.position[0], continental.position[1] + 0.05];
  const towerFootprint = localRect(towerCenter, 0.06, 0.07);
  const towerBlock = addBlock(towerFootprint, "landmark", "block");
  const straitName = strait.name;
  buildingSegments(straitCenter, 0.07, 0.07, 70, "landmark", straitBlock, 0, { id: strait.id, name: straitName }, [
    { top: 45, width: 0.07, depth: 0.07 },
    { base: 45, top: 70, width: 0.06, depth: 0.05 },
  ]);
  const continentalName = continental.name;
  buildingSegments(towerCenter, 0.06, 0.07, 480, "landmark", towerBlock, 0, { id: continental.id, name: continentalName, color: "#b56b48" }, [
    { top: 55, width: 0.06, depth: 0.07 },
    { top: 290, width: 0.05, depth: 0.06 },
    { top: 400, width: 0.04, depth: 0.05 },
    { top: 450, width: 0.03, depth: 0.04 },
    { top: 480, width: 0.012, depth: 0.02 },
  ]);

  const exchange = pointById.get("exchange-square")!;
  const podiumCenter: XY = [exchange.position[0], exchange.position[1] + 0.06];
  const exchangeOuter = localRect(exchange.position, 0.22, 0.22);
  const exchangeHole = localRect(exchange.position, 0.19, 0.21);
  plazaExclusions.push(exchangeOuter);
  blockFeatures.push(feature(polygonGeometry([exchangeOuter, reversePath(exchangeHole)]), { kind: "plaza", zone: "manhattan" }));
  const podiumRing = localRect(podiumCenter, 0.19, 0.08);
  const podiumBlock = addBlock(podiumRing, "landmark", "block");
  const podiumBid = buildingSegments(podiumCenter, 0.19, 0.08, 25, "landmark", podiumBlock, 0, { id: exchange.id, name: exchange.name }, [
    { top: 25, width: 0.19, depth: 0.08 },
  ]);
  const towerOffsets: XY[] = [[-0.065, 0], [0, 0], [0.065, 0]];
  for (let index = 0; index < towerOffsets.length; index += 1) {
    const offset = towerOffsets[index]!;
    const position: XY = [podiumCenter[0] + offset[0], podiumCenter[1] + (index === 1 ? 0.008 : -0.008)];
    const footprint = localRect(position, 0.052, 0.052);
    const block = addBlock(footprint, "landmark", "block");
    const towerHeight = [150, 175, 190][index]!;
    buildingSegments(position, 0.052, 0.052, towerHeight + 25, "landmark", block, 0, { id: exchange.id, name: exchange.name }, [
      { base: 25, top: towerHeight + 25, width: 0.042, depth: 0.042 },
    ], podiumBid);
  }

  const cityHall = pointById.get("city-hall")!;
  const cityHallBlock = addBlock(localRect(cityHall.position, 0.12, 0.08), "landmark", "block");
  buildingSegments(cityHall.position, 0.12, 0.08, 95, "landmark", cityHallBlock, 0, { id: cityHall.id, name: cityHall.name }, [
    { top: 60, width: 0.12, depth: 0.08 },
    { top: 95, width: 0.04, depth: 0.04 },
  ]);
  const hospital = pointById.get("hospital")!;
  const hospitalPodiumRing = localRect(hospital.position, 0.2, 0.13);
  roadExclusions.push(hospitalPodiumRing);
  const hospitalPodiumBlock = addBlock(hospitalPodiumRing, "landmark", "block");
  const hospitalPodiumBid = buildingSegments(hospital.position, 0.2, 0.13, 20, "landmark", hospitalPodiumBlock, 0, { id: hospital.id, name: hospital.name }, [
    { top: 20, width: 0.2, depth: 0.13 },
  ]);
  for (let index = 0; index < 3; index += 1) {
    const position: XY = [hospital.position[0] - 0.055 + index * 0.055, hospital.position[1]];
    const block = addBlock(localRect(position, 0.046, 0.1), "landmark", "block");
    buildingSegments(position, 0.046, 0.1, 80, "landmark", block, 0, { id: hospital.id, name: hospital.name }, [
      { base: 20, top: 80, width: 0.038, depth: 0.085 },
    ], hospitalPodiumBid);
  }
  const library = pointById.get("library")!;
  const libraryBlock = addBlock(localRect(library.position, 0.1, 0.07), "landmark", "block");
  buildingSegments(library.position, 0.1, 0.07, 30, "landmark", libraryBlock, 0, { id: library.id, name: library.name }, [
    { top: 30, width: 0.1, depth: 0.07 },
  ]);

  const governors = pointById.get("old-governors-house")!;
  const governorCourtyard = localRect(governors.position, 0.22, 0.16);
  plazaExclusions.push(governorCourtyard);
  roadExclusions.push(governorCourtyard);
  blockFeatures.push(feature(polygonGeometry([governorCourtyard]), { kind: "plaza", zone: "beverly", monument_id: governors.id }));
  const governorBlock = addBlock(localRect(governors.position, 0.07, 0.03), "beverly", "block");
  buildingSegments(governors.position, 0.07, 0.03, 18, "monument", governorBlock, 0, { id: governors.id, name: governors.name });
  for (const offset of [-0.065, 0.065]) {
    const position: XY = [governors.position[0] + offset, governors.position[1]];
    const block = addBlock(localRect(position, 0.024, 0.02), "beverly", "block");
    buildingSegments(position, 0.024, 0.02, 12, "monument", block, 0, { id: governors.id, name: governors.name });
  }

  const church = pointById.get("church")!;
  const churchBlockRing = localRect(church.position, 0.22, 0.12);
  plazaExclusions.push(churchBlockRing);
  roadExclusions.push(churchBlockRing);
  blockFeatures.push(feature(polygonGeometry([churchBlockRing]), { kind: "plaza", zone: "manhattan", monument_id: church.id }));
  const churchBlock = addBlock(localRect(church.position, 0.055, 0.022), "monument", "block");
  buildingSegments(church.position, 0.055, 0.022, 25, "monument", churchBlock, 0, { id: church.id, name: church.name });
  const bellPosition: XY = [church.position[0] + 0.035, church.position[1]];
  const bellBlock = addBlock(localRect(bellPosition, 0.01, 0.01), "monument", "block");
  buildingSegments(bellPosition, 0.01, 0.01, 70, "monument", bellBlock, 0, { id: church.id, name: church.name });

  const republic = pointById.get("republic-monument")!;
  const plazaRing = close(Array.from({ length: 48 }, (_, index) => {
    const angle = index * Math.PI / 24;
    return [republic.position[0] + 0.08 * Math.cos(angle), republic.position[1] + 0.08 * Math.sin(angle)] as XY;
  }));
  plazaExclusions.push(plazaRing);
  roadExclusions.push(plazaRing);
  blockFeatures.push(feature(polygonGeometry([plazaRing]), { kind: "plaza", zone: "uptown", monument_id: republic.id }));
  const columnBlock = addBlock(localRect(republic.position, 0.014, 0.014), "monument", "block");
  buildingSegments(republic.position, 0.014, 0.014, 58, "monument", columnBlock, 0, { id: republic.id, name: republic.name }, [
    { top: 8, width: 0.014, depth: 0.014 },
    { base: 8, top: 58, width: 0.005, depth: 0.005 },
  ]);
}

function generateManhattanBlocks(roads: RoadIndex, coast: RoadIndex): void {
  const { grid, financial, reclamation } = urbanGrid;
  for (let x = grid.west; x + grid.blockWidth <= grid.east; x += grid.stepX) {
    for (let y = grid.south; y + grid.blockDepth <= 9.2; y += grid.stepY) {
      const ring = localRect([x + grid.blockWidth / 2, y + grid.blockDepth / 2], grid.blockWidth, grid.blockDepth);
      generateBlockBuildings(ring, "grid", grid.blockWidth, grid.blockDepth, roads, coast, 0, 2);
    }
  }
  const financialAngle = financial.angleDegrees * Math.PI / 180;
  const origin: XY = [0.15, 0.75];
  for (let u = financial.bounds[0]; u + financial.blockWidth < financial.bounds[2]; u += financial.stepX) {
    for (let v = financial.bounds[1]; v + financial.blockDepth < financial.bounds[3]; v += financial.stepY) {
      const center: XY = [origin[0] + (u + financial.blockWidth / 2) * Math.cos(financialAngle) - (v + financial.blockDepth / 2) * Math.sin(financialAngle),
        origin[1] + (u + financial.blockWidth / 2) * Math.sin(financialAngle) + (v + financial.blockDepth / 2) * Math.cos(financialAngle)];
      const ring = localRect(center, financial.blockWidth, financial.blockDepth, financial.angleDegrees);
      generateBlockBuildings(ring, "financial", financial.blockWidth, financial.blockDepth, roads, coast, financial.angleDegrees);
    }
  }
  for (let x = reclamation.bounds[0]; x + reclamation.blockWidth < reclamation.bounds[2]; x += reclamation.stepX) {
    for (let y = reclamation.bounds[1]; y + reclamation.blockDepth < reclamation.bounds[3]; y += reclamation.stepY) {
      const center: XY = [x + reclamation.blockWidth / 2, y + reclamation.blockDepth / 2];
      const ring = localRect(center, reclamation.blockWidth, reclamation.blockDepth, reclamation.angleDegrees, [reclamation.bounds[0], reclamation.bounds[1]]);
      generateBlockBuildings(ring, "reclamation", reclamation.blockWidth, reclamation.blockDepth, roads, coast, reclamation.angleDegrees, 2);
    }
  }

  const obstacleCellSize = 0.25;
  type IndexedBlock = { rings: Ring[]; bounds: [number, number, number, number] };
  const obstacleIndex = new Map<string, IndexedBlock[]>();
  for (const block of blockFeatures.filter((item) => item.properties?.kind === "block" && item.geometry?.type === "Polygon")) {
    if (block.geometry.type !== "Polygon") continue;
    const rings = block.geometry.coordinates.map((ring) => ring.map(localFromCoordinate));
    const outer = rings[0]!;
    const bounds: [number, number, number, number] = [
      Math.min(...outer.map(([x]) => x)), Math.min(...outer.map(([, y]) => y)),
      Math.max(...outer.map(([x]) => x)), Math.max(...outer.map(([, y]) => y)),
    ];
    const entry = { rings, bounds };
    for (let x = Math.floor(bounds[0] / obstacleCellSize); x <= Math.floor(bounds[2] / obstacleCellSize); x += 1) {
      for (let y = Math.floor(bounds[1] / obstacleCellSize); y <= Math.floor(bounds[3] / obstacleCellSize); y += 1) {
        const key = x + ":" + y;
        obstacleIndex.set(key, [...(obstacleIndex.get(key) ?? []), entry]);
      }
    }
  }
  const blockObstaclesFor = (ring: Ring): Ring[][] => {
    const xs = ring.map(([x]) => x);
    const ys = ring.map(([, y]) => y);
    const minX = Math.floor(Math.min(...xs) / obstacleCellSize);
    const maxX = Math.floor(Math.max(...xs) / obstacleCellSize);
    const minY = Math.floor(Math.min(...ys) / obstacleCellSize);
    const maxY = Math.floor(Math.max(...ys) / obstacleCellSize);
    const candidates = new Set<IndexedBlock>();
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      for (const item of obstacleIndex.get(x + ":" + y) ?? []) candidates.add(item);
    }
    return [...candidates]
      .filter((item) => item.bounds[0] <= Math.max(...xs) && item.bounds[2] >= Math.min(...xs)
        && item.bounds[1] <= Math.max(...ys) && item.bounds[3] >= Math.min(...ys))
      .map((item) => item.rings);
  };
  const manhattan = districtById.get("manhattan")!.ring;
  const west = Math.min(...manhattan.map(([x]) => x));
  const east = Math.max(...manhattan.map(([x]) => x));
  const south = Math.min(...manhattan.map(([, y]) => y));
  const north = Math.max(...manhattan.map(([, y]) => y));
  const fillWidth = 0.2;
  const fillDepth = 0.12;
  const fillStepX = 0.24;
  const fillStepY = 0.18;
  for (let x = Math.floor(west / fillStepX) * fillStepX; x < east; x += fillStepX) {
    for (let y = Math.floor(south / fillStepY) * fillStepY; y < north; y += fillStepY) {
      const ring = localRect([x + fillWidth / 2, y + fillDepth / 2], fillWidth, fillDepth);
      const localCandidate = localPolygon(ring);
      const overlapsExistingBlock = blockObstaclesFor(ring).some((obstacle) =>
        !booleanDisjoint(localCandidate, localPolygonWithHoles(obstacle)));
      if (overlapsExistingBlock) continue;
      generateBlockBuildings(ring, "grid", fillWidth, fillDepth, roads, coast, 0, 1, true, "residual");
    }
  }
}

function onRingBoundary(point: XY, ring: Ring): boolean {
  return ring.slice(1).some((end, index) => distanceToSegment(point, ring[index]!, end) < 1e-8);
}

function clipLineToRing(line: readonly XY[], ring: Ring): XY[][] {
  const result: XY[][] = [];
  let current: XY[] = [];
  const append = (point: XY): void => {
    const previous = current[current.length - 1];
    if (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) > 1e-8) current.push(point);
  };
  const flush = (): void => {
    if (current.length > 1) result.push(current);
    current = [];
  };
  const region = localPolygon(ring);
  for (let segmentIndex = 1; segmentIndex < line.length; segmentIndex += 1) {
    const start = line[segmentIndex - 1]!;
    const end = line[segmentIndex]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const squaredLength = dx * dx + dy * dy;
    const intersections = lineIntersect(lineString([[start[0], start[1]], [end[0], end[1]]]), region).features.map((item) => [
      item.geometry.coordinates[0]!,
      item.geometry.coordinates[1]!,
    ] as XY);
    const cuts = [start, ...intersections, end]
      .map((point) => ({
        point,
        t: squaredLength === 0 ? 0 : ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / squaredLength,
      }))
      .filter((item) => item.t >= -1e-8 && item.t <= 1 + 1e-8)
      .sort((a, b) => a.t - b.t)
      .filter((item, index, all) => index === 0 || Math.abs(item.t - all[index - 1]!.t) > 1e-8);
    for (let index = 1; index < cuts.length; index += 1) {
      const first = cuts[index - 1]!.point;
      const second = cuts[index]!.point;
      const midpoint: XY = [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
      if (pointInRing(midpoint, ring) || onRingBoundary(midpoint, ring)) {
        append(first);
        append(second);
      } else {
        flush();
      }
    }
  }
  flush();
  return result;
}



const beverlyDistrict = districtById.get("beverly")!;
const reserveDistrict = districtById.get("reserve")!;

function elevationAt(x: number, y: number): number {
  return beverlyHeight(x, y);
}

function elevationSlope(x: number, y: number): number {
  const halfStep = 0.025;
  const east = (elevationAt(x + halfStep, y) - elevationAt(x - halfStep, y)) / 50;
  const north = (elevationAt(x, y + halfStep) - elevationAt(x, y - halfStep)) / 50;
  return Math.hypot(east, north);
}

export function beverlyElevationAt(position: XY): number {
  return elevationAt(position[0], position[1]);
}

export function beverlySlopeAt(position: XY): number {
  return elevationSlope(position[0], position[1]);
}

function generateBeverlyTerrain(): {
  bands: Feature<Polygon, Properties>[];
  contours: Feature<LineString, Properties>[];
  contourPaths: Array<{ level: number; path: XY[] }>;
} {
  const points: Feature<Point, { elevation: number }>[] = [];
  for (let y = 0; y <= 9.0001; y += 0.2) {
    for (let x = 9; x <= 28.0001; x += 0.2) points.push(point([x, y], { elevation: elevationAt(x, y) }));
  }
  const grid = featureCollection(points);
  const breaks = Array.from({ length: 9 }, (_, index) => index * 40);
  const bandSource = isobands(grid, breaks, {
    zProperty: "elevation",
    breaksProperties: breaks.slice(0, -1).map((level) => ({ level, kind: "band" })),
  });
  const bands: Feature<Polygon, Properties>[] = [];
  for (const source of bandSource.features) {
    const smoothed = simplify(source, { tolerance: 0.04, highQuality: true });
    const clipped = intersect(featureCollection<Polygon | MultiPolygon>([
      smoothed as Feature<Polygon | MultiPolygon>,
      localPolygon(beverlyDistrict.ring),
    ]));
    if (!clipped) continue;
    for (const polygon of polygonPieces(clipped.geometry)) {
      bands.push(feature(polygonGeometry(polygon), {
        kind: "band",
        level: Number(source.properties?.level ?? 0),
      }));
    }
  }
  const contourLevels = breaks.slice(1, -1);
  const contourSource = isolines(grid, contourLevels, {
    zProperty: "elevation",
    breaksProperties: contourLevels.map((level) => ({ level, kind: "contour" })),
  });
  const contours: Feature<LineString, Properties>[] = [];
  for (const source of contourSource.features) {
    const smoothed = simplify(source, { tolerance: 0.04, highQuality: true });
    const level = Number(source.properties?.level ?? 0);
    for (const path of (smoothed.geometry as MultiLineString).coordinates) {
      const localPath = path.map(([x, y]) => [x, y] as XY);
      for (const segment of clipLineToRing(localPath, beverlyDistrict.ring)) {
        contours.push(feature(lineGeometry(segment), {
          kind: "contour",
          level,
        }));
      }
    }
  }
  return { bands, contours, contourPaths: generateBeverlyRoadContours() };
}

export function generateBeverlyRoadContours(): Array<{ level: number; path: XY[] }> {
  const points: Feature<Point, { elevation: number }>[] = [];
  for (let y = 0; y <= 9.0001; y += 0.05) {
    for (let x = 9; x <= 28.0001; x += 0.05) points.push(point([x, y], { elevation: elevationAt(x, y) }));
  }
  const levels = Array.from({ length: 7 }, (_, index) => (index + 1) * 40);
  const source = isolines(featureCollection(points), levels, {
    zProperty: "elevation",
    breaksProperties: levels.map((level) => ({ level, kind: "contour" })),
  });
  const paths: Array<{ level: number; path: XY[] }> = [];
  for (const contour of source.features) {
    const level = Number(contour.properties?.level ?? 0);
    for (const path of (contour.geometry as MultiLineString).coordinates) {
      const localPath = path.map(([x, y]) => [x, y] as XY);
      for (const segment of clipLineToRing(localPath, beverlyDistrict.ring)) {
        if (segment.length >= 4) paths.push({ level, path: segment });
      }
    }
  }
  return paths;
}

function irregularEllipse(center: XY, radiusX: number, radiusY: number, phase: number, steps = 48): Ring {
  const points: XY[] = [];
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    const radius = 1 + 0.055 * Math.sin(3 * angle + phase) + 0.025 * Math.cos(5 * angle - phase);
    points.push([
      center[0] + Math.cos(angle) * radiusX * radius,
      center[1] + Math.sin(angle) * radiusY * radius,
    ]);
  }
  return close(points);
}

function smoothLandNoise(x: number, y: number, phase: number): number {
  return 0.5 * Math.sin(x * 0.83 + phase) * Math.cos(y * 1.07 - phase)
    + 0.3 * Math.sin(x * 1.51 - y * 0.67 + phase * 1.8)
    + 0.2 * Math.cos(y * 1.93 + x * 0.41 - phase * 0.7);
}

function forestEllipse(center: XY, radiusX: number, radiusY: number, phase: number, random: () => number, angleOffset = 0): Ring {
  const points: XY[] = [];
  const fieldPhase = phase + random() * Math.PI * 2;
  const steps = 256;
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    const x = Math.cos(angle) * radiusX;
    const y = Math.sin(angle) * radiusY;
    const organicNoise = 0.2 * smoothLandNoise(center[0] + x, center[1] + y, fieldPhase)
      + 0.4 * Math.sin(2 * angle + fieldPhase)
      + 0.3 * Math.cos(3 * angle - phase)
      + 0.1 * Math.sin(5 * angle + fieldPhase * 0.6);
    const radius = 1 + 0.25 * organicNoise;
    points.push([
      center[0] + (x * Math.cos(angleOffset) - y * Math.sin(angleOffset)) * radius,
      center[1] + (x * Math.sin(angleOffset) + y * Math.cos(angleOffset)) * radius,
    ]);
  }
  return close(points);
}

function woodlandDistrictInsets(ring: Ring): Ring[] {
  return polygonPieces(bufferedLocalGeometry(polygonGeometry([ring]), -0.02).geometry)
    .map((polygon) => polygon[0]!)
    .filter((polygon) => polygon.length >= 4);
}

function generateWoods(towns: readonly TownArea[], preserveLandRandomSequence = true): { features: Feature<Polygon, Properties>[]; rings: Ring[] } {
  const woods: Feature<Polygon, Properties>[] = [];
  const rings: Ring[] = [];
  const ringOwners: string[] = [];
  const woodlandRand = rng(0x574f4f44);
  const beverlyForestBoundary = woodlandDistrictInsets(beverlyDistrict.ring);
  const beverlyPatches = [
    { center: [10.7, 5.6] as XY, rx: 0.75, ry: 1.15, phase: 0.2, angle: -0.35 },
    { center: [13.6, 6.6] as XY, rx: 1.2, ry: 3.3, phase: 0.8, angle: 0.12 },
    { center: [16.3, 5.0] as XY, rx: 0.6, ry: 4.2, phase: 1.8, angle: -0.05 },
    { center: [19.2, 6.7] as XY, rx: 1.4, ry: 2.5, phase: 2.7, angle: 0.3 },
    { center: [22.2, 5.2] as XY, rx: 0.45, ry: 4.6, phase: 3.5, angle: 0.0 },
    { center: [24.4, 6.6] as XY, rx: 1.12, ry: 4.2, phase: 4.3, angle: 0.0 },
    { center: [27.0, 5.6] as XY, rx: 0.7, ry: 4.5, phase: 5.1, angle: 0.1 },
  ];
  for (const patchPlan of beverlyPatches) {
    const patch = forestEllipse(patchPlan.center, patchPlan.rx, patchPlan.ry, patchPlan.phase, woodlandRand, patchPlan.angle);
    for (const clipRing of beverlyForestBoundary) for (const clipped of intersectWithRing([patch], clipRing)) {
      for (const piece of polygonPieces(localPolygonWithHoles(clipped).geometry)) {
        if (planarArea(piece) < 0.3) continue;
        if (rings.some((ring) => !disjoint(piece[0]!, ring))) throw new Error("Beverly woods must not overlap.");
        const localPolygon = feature(localPolygonWithHoles(piece).geometry, { kind: "wood", sector: "beverly" });
        woods.push(feature(polygonGeometry(piece), localPolygon.properties));
        rings.push(piece[0]!);
        ringOwners.push(patchPlan.center.join(","));
      }
    }
  }

  const reservePatches = [
    { center: [15.5, 32.0] as XY, rx: 4.75, ry: 2.3, phase: 0.2, angle: 0.1 },
    { center: [25.3, 32.2] as XY, rx: 2.8, ry: 2.4, phase: 1.1, angle: -0.3 },
    { center: [29.9, 31.3] as XY, rx: 0.7, ry: 0.8, phase: 2.5, angle: 0.62 },
    { center: [33.4, 31.5] as XY, rx: 1.5, ry: 2.0, phase: 3.2, angle: 1.05 },
    { center: [34.0, 21.0] as XY, rx: 2.0, ry: 3.5, phase: 0.7, angle: -0.17 },
    { center: [33.7, 13.4] as XY, rx: 1.5, ry: 2.8, phase: 1.9, angle: 0.35 },
    { center: [33.7, 5.0] as XY, rx: 2.3, ry: 4.25, phase: 2.8, angle: -0.35 },
  ];
  const reserveForestBoundary = woodlandDistrictInsets(reserveDistrict.ring);
  for (const patch of reservePatches) {
    const ring = forestEllipse(patch.center, patch.rx, patch.ry, patch.phase, woodlandRand, patch.angle);
    for (const clipRing of reserveForestBoundary) for (const piece of intersectWithRing([ring], clipRing)) {
      for (const part of polygonPieces(localPolygonWithHoles(piece).geometry)) {
        if (planarArea(part) < 0.3) continue;
        const wood = feature(localPolygonWithHoles(part).geometry, { kind: "wood", sector: "reserve" });
        const overlappingTown = towns.find((town) => !disjoint(part[0]!, town.ring));
        const overlappingPatch = rings.findIndex((existing) => !disjoint(part[0]!, existing));
        if (overlappingTown || overlappingPatch >= 0) {
          throw new Error(`Reserve wood at ${patch.center} overlaps ${overlappingTown?.id ?? `forest at ${ringOwners[overlappingPatch]}`}.`);
        }
        woods.push(feature(polygonGeometry(part), wood.properties));
        rings.push(part[0]!);
        ringOwners.push(patch.center.join(","));
      }
    }
  }
  if (preserveLandRandomSequence) for (let index = 0; index < beverlyPatches.length + reservePatches.length; index += 1) landRand();
  return { features: woods, rings };
}

interface TownArea {
  id: string;
  center: XY;
  ring: Ring;
}

function createTownAreas(): TownArea[] {
  return reserveTownCenters.map(({ id, position }, index) => {
    const ring = irregularEllipse(position, 0.37, 0.37, index * 0.6, 40);
    const clipped = intersectWithRing([ring], reserveDistrict.ring);
    const polygon = clipped.sort((a, b) => planarArea(b) - planarArea(a))[0];
    if (!polygon || planarArea(polygon) < 0.3 || planarArea(polygon) > 0.9) {
      throw new Error(`Reserve town ${id} does not meet its land-area requirement.`);
    }
    return { id, center: position, ring: polygon[0]! };
  });
}

export function generateWoodlandsForValidation() {
  rand = rng(0x4d4f4e41);
  landRand = rng(0x4c414e44);
  const towns = createTownAreas();
  const woods = generateWoods(towns, false);
  const farms = generateFarmAndPortSurfaces(woods.rings, towns, woods.features)
    .filter((surface) => surface.properties?.kind === "farm");
  return {
    woods: woods.features,
    farms,
    towns: towns.map(({ id, ring }) => feature(polygonGeometry([ring]), { id })),
    districts: {
      beverly: feature(polygonGeometry([beverlyDistrict.ring]), { id: "beverly" }),
      reserve: feature(polygonGeometry([reserveDistrict.ring]), { id: "reserve" }),
    },
  };
}

function generateBeverlyRoads(
  output: RoadDefinition[],
  contours: readonly { level: number; path: XY[] }[],
): void {
  const gridSize = 0.05;
  const columns = 381;
  const rows = 133;
  const positionAt = (id: number): XY => [9 + (id % columns) * gridSize, 2.35 + Math.floor(id / columns) * gridSize];
  const gridId = ([x, y]: XY): number => Math.round((y - 2.35) / gridSize) * columns + Math.round((x - 9) / gridSize);
  const roadClearance = 0.012 / 2 + 0.001;
  const routeExclusions = roadExclusions.map((ring) => ({
    minX: Math.min(...ring.map(([x]) => x)) - roadClearance,
    maxX: Math.max(...ring.map(([x]) => x)) + roadClearance,
    minY: Math.min(...ring.map(([, y]) => y)) - roadClearance,
    maxY: Math.max(...ring.map(([, y]) => y)) + roadClearance,
  }));
  const segmentHitsBounds = (start: XY, end: XY, bounds: { minX: number; maxX: number; minY: number; maxY: number }): boolean => {
    let enter = 0;
    let exit = 1;
    for (const [origin, delta, minimum, maximum] of [
      [start[0], end[0] - start[0], bounds.minX, bounds.maxX],
      [start[1], end[1] - start[1], bounds.minY, bounds.maxY],
    ]) {
      if (Math.abs(delta) < 1e-12) {
        if (origin < minimum || origin > maximum) return false;
        continue;
      }
      const first = (minimum - origin) / delta;
      const second = (maximum - origin) / delta;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
      if (enter > exit) return false;
    }
    return exit >= 0 && enter <= 1;
  };
  const segmentAvoidsExclusions = (start: XY, end: XY): boolean => routeExclusions.every((bounds) => !segmentHitsBounds(start, end, bounds));
  const pathAvoidsExclusions = (path: readonly XY[]): boolean => path.slice(1).every((position, index) =>
    segmentAvoidsExclusions(path[index]!, position));
  const allowed = Array.from({ length: columns * rows }, (_, id) => pointInRing(positionAt(id), beverlyDistrict.ring)
    && routeExclusions.every((bounds) => {
      const [x, y] = positionAt(id);
      return x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY;
    }));
  const heights = Float64Array.from(allowed, (_, id) => elevationAt(...positionAt(id)));
  const directions: readonly XY[] = [
    [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
    [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2],
    ...[3, 4, 5].flatMap(long => [-1, 1].flatMap(x => [-1, 1].flatMap(y => [[x * long, y], [x, y * long]] as XY[]))),
    ...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [[x * 3, y * 2], [x * 2, y * 3]] as XY[])),
  ];
  const gradeLimit = 0.08;
  const routeGradeLimit = 0.075;
  const runSlots = 7;
  const directionSlots = directions.length + 1;
  const statesPerNode = runSlots * directionSlots;
  const routeStraightLimit = 0.45;
  const nodeOf = (state: number): number => Math.floor(state / statesPerNode);
  const directionOf = (state: number): number => Math.floor(state / runSlots) % directionSlots;
  const runOf = (state: number): number => state % runSlots;
  const safeEdges = new Map<string, boolean>();
  const route = (start: XY, goal: XY): XY[] => {
    const from = gridId(start);
    const to = gridId(goal);
    if (!allowed[from] || !allowed[to]) throw new Error("Beverly hill-road endpoint falls outside the district.");
    const distances = new Float64Array(allowed.length * statesPerNode).fill(Number.POSITIVE_INFINITY);
    const previous = new Int32Array(distances.length).fill(-1);
    const visited = new Uint8Array(distances.length);
    const pending: Array<{ id: number; priority: number }> = [];
    const add = (id: number, priority: number): void => {
      let index = pending.length;
      pending.push({ id, priority });
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (pending[parent]!.priority <= pending[index]!.priority) break;
        [pending[index], pending[parent]] = [pending[parent]!, pending[index]!];
        index = parent;
      }
    };
    const remove = (): { id: number; priority: number } => {
      const first = pending[0]!;
      const last = pending.pop()!;
      if (pending.length > 0) {
        pending[0] = last;
        let index = 0;
        while (2 * index + 1 < pending.length) {
          let child = 2 * index + 1;
          if (child + 1 < pending.length && pending[child + 1]!.priority < pending[child]!.priority) child += 1;
          if (pending[index]!.priority <= pending[child]!.priority) break;
          [pending[index], pending[child]] = [pending[child]!, pending[index]!];
          index = child;
        }
      }
      return first;
    };
    const startState = (from * directionSlots + directions.length) * runSlots;
    distances[startState] = 0;
    add(startState, Math.hypot(start[0] - goal[0], start[1] - goal[1]));
    while (pending.length > 0) {
      const currentState = remove().id;
      const current = nodeOf(currentState);
      if (visited[currentState]) continue;
      if (current === to) {
        const path: XY[] = [];
        for (let cursor = currentState; cursor !== -1; cursor = previous[cursor]!) path.push(positionAt(nodeOf(cursor)));
        return path.reverse();
      }
      visited[currentState] = 1;
      const x = current % columns;
      const y = Math.floor(current / columns);
      const first = positionAt(current);
      for (const [directionIndex, [dx, dy]] of directions.entries()) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows) continue;
        const next = nextY * columns + nextX;
        if (!allowed[next]) continue;
        const priorDirection = directions[directionOf(currentState)];
        if (priorDirection && (priorDirection[0] * dx + priorDirection[1] * dy)
          / Math.hypot(...priorDirection) / Math.hypot(dx, dy) < Math.cos(12 * Math.PI / 180)) continue;
        const second = positionAt(next);
        const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
        const edgeId = `${Math.min(current, next)}:${Math.max(current, next)}`;
        if (!segmentAvoidsExclusions(first, second)) {
          safeEdges.set(edgeId, false);
          continue;
        }
        let safe = safeEdges.get(edgeId);
        if (safe === undefined) {
          const samples = Math.ceil(length / 0.05);
          let priorHeight = heights[current]!;
          safe = true;
          for (let sample = 1; sample <= samples; sample += 1) {
            const ratio = sample / samples;
            const height = elevationAt(first[0] + (second[0] - first[0]) * ratio, first[1] + (second[1] - first[1]) * ratio);
            if (Math.abs(height - priorHeight) / (length * 1000 / samples) > routeGradeLimit) {
              safe = false;
              break;
            }
            priorHeight = height;
          }
          safeEdges.set(edgeId, safe);
        }
        if (!safe) continue;
        const runCount = directionIndex === directionOf(currentState) ? runOf(currentState) + 1 : 1;
        if (runCount >= runSlots || runCount * length > routeStraightLimit + 1e-9) continue;
        const nextState = (next * directionSlots + directionIndex) * runSlots + runCount;
        if (visited[nextState]) continue;
        const grade = Math.abs(heights[next]! - heights[current]!) / (length * 1000);
        const cost = distances[currentState]! + length * (1 + grade * 8);
        if (cost >= distances[nextState]!) continue;
        distances[nextState] = cost;
        previous[nextState] = currentState;
        add(nextState, cost + Math.hypot(second[0] - goal[0], second[1] - goal[1]));
      }
    }
    throw new Error(`No grade-limited Beverly route from ${start} to ${goal}.`);
  };

  const sampledGrade = (path: readonly XY[]): number => {
    let maximum = 0;
    for (let index = 1; index < path.length; index += 1) {
      const start = path[index - 1]!;
      const end = path[index]!;
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const samples = Math.max(1, Math.ceil(length / 0.05));
      let previous = elevationAt(start[0], start[1]);
      for (let sample = 1; sample <= samples; sample += 1) {
        const ratio = sample / samples;
        const current = elevationAt(start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio);
        maximum = Math.max(maximum, Math.abs(current - previous) / (length * 1000 / samples));
        previous = current;
      }
    }
    return maximum;
  };
  const gradeSafeGridAnchors = (position: XY): XY[] => {
    const center = gridId(position);
    const centerX = center % columns;
    const centerY = Math.floor(center / columns);
    const candidates: Array<{ position: XY; distance: number }> = [];
    for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
      for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
        const x = centerX + offsetX;
        const y = centerY + offsetY;
        if (x < 0 || x >= columns || y < 0 || y >= rows) continue;
        const id = y * columns + x;
        if (!allowed[id]) continue;
        const candidate = positionAt(id);
        const distance = Math.hypot(candidate[0] - position[0], candidate[1] - position[1]);
        if (distance > 0.25 || !segmentAvoidsExclusions(position, candidate)
          || sampledGrade([position, candidate]) > routeGradeLimit) continue;
        candidates.push({ position: candidate, distance });
      }
    }
    return candidates.sort((first, second) => first.distance - second.distance).map(({ position: candidate }) => candidate);
  };
  const maximumStraightRun = (path: readonly XY[]): number => {
    const coordinateCellDiagonal = Math.hypot(longitudeScale * 1e-6, latitudeScale * 1e-6);
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
  };
  const longestStraightRunBounds = (path: readonly XY[]): { start: number; end: number; length: number } => {
    const coordinateCellDiagonal = Math.hypot(longitudeScale * 1e-6, latitudeScale * 1e-6);
    let runStart = 0;
    let runLength = 0;
    let bestLength = 0;
    let bestStart = 0;
    let bestEnd = 0;
    let previous: XY | undefined;
    let previousLength = 0;
    const consider = (end: number): void => {
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
        bestEnd = end;
      }
    };
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
        if (dot > 0 && cross / previousLength <= coordinateCellDiagonal) runLength += length;
        else {
          consider(index - 1);
          runStart = index - 1;
          runLength = length;
        }
      } else {
        runStart = index - 1;
        runLength = length;
      }
      previous = start;
      previousLength = length;
    }
    consider(path.length - 1);
    return { start: bestStart, end: bestEnd, length: bestLength };
  };
  const smoothPath = (path: readonly XY[]): XY[] => {
    if (path.length < 3) return [...path];
    const smoothed: XY[] = [path[0]!];
    for (let index = 1; index < path.length; index += 1) {
      const start = path[index - 1]!;
      const end = path[index]!;
      smoothed.push([
        start[0] * 0.75 + end[0] * 0.25,
        start[1] * 0.75 + end[1] * 0.25,
      ]);
      smoothed.push([
        start[0] * 0.25 + end[0] * 0.75,
        start[1] * 0.25 + end[1] * 0.75,
      ]);
    }
    smoothed.push(path.at(-1)!);
    return smoothed;
  };
  const rerouteLongStraightRuns = (source: readonly XY[]): XY[] => {
    let path = [...source];
    while (true) {
      const span = longestStraightRunBounds(path);
      if (span.length <= 0.6 - 0.00014) return path;
      if (span.end <= span.start) throw new Error("Cannot reroute a zero-length Beverly hill-road straight run.");
      const start = path[span.start]!;
      const end = path[span.end]!;
      let replacement: XY[] | undefined;
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      for (const amplitude of [0.06, -0.06, 0.04, -0.04, 0.02, -0.02]) {
        if (replacement || !length) break;
        const count = Math.max(32, Math.ceil(length / 0.02));
        const curved: XY[] = Array.from({ length: count + 1 }, (_, i) => {
          const t = i / count, offset = amplitude * Math.sin(t * Math.PI) ** 2;
          return [start[0] + (end[0] - start[0]) * t - (end[1] - start[1]) / length * offset,
            start[1] + (end[1] - start[1]) * t + (end[0] - start[0]) / length * offset];
        });
        if (curved.every(p => pointInRing(p, beverlyDistrict.ring)) && pathAvoidsExclusions(curved)
          && sampledGrade(curved) <= gradeLimit && maximumStraightRun(curved) < 0.6 - 0.00014) replacement = curved;
      }
      let routeError = "no candidate path met the exported grade, curvature, district, and landmark constraints";
      const failures: string[] = [];
      const startAnchors = gradeSafeGridAnchors(start);
      const endAnchors = gradeSafeGridAnchors(end);
      for (const startAnchor of startAnchors) {
        if (replacement) break;
        for (const endAnchor of endAnchors) {
          try {
            const gridPath = route(startAnchor, endAnchor);
            const candidates = [smoothPath(gridPath), gridPath];
            for (const [candidateIndex, candidate] of candidates.entries()) {
              const joined: XY[] = [];
              for (const position of [start, ...candidate, end]) {
                if (!joined.length || Math.hypot(position[0] - joined.at(-1)![0], position[1] - joined.at(-1)![1]) > 1e-8) {
                  joined.push(position);
                }
              }
              const grade = sampledGrade(joined);
              const straightRun = maximumStraightRun(joined);
              const inDistrict = joined.slice(1).every((position) => pointInRing(position, beverlyDistrict.ring));
              const clearOfLandmarks = pathAvoidsExclusions(joined);
              if (inDistrict && clearOfLandmarks && grade <= gradeLimit
                && straightRun <= 0.6 - 0.00014 && straightRun < span.length) {
                replacement = joined;
                break;
              }
              failures.push(`${candidateIndex === 0 ? "smoothed" : "grid"}: grade ${(grade * 100).toFixed(3)}%, straight ${(straightRun * 1000).toFixed(1)}m, district ${inDistrict}, landmarks ${clearOfLandmarks}`);
            }
            if (replacement) break;
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (replacement) break;
      }
      if (!replacement) routeError = failures.slice(-4).join("; ") || routeError;
      if (!replacement) {
        throw new Error(`Cannot grade-constrain the Beverly straight run from ${start} to ${end}: ${routeError}.`);
      }
      path = [...path.slice(0, span.start), ...replacement.slice(1, -1), ...path.slice(span.end)];
    }
  };
  const connectToContour = (arterialPoint: XY, gridPoint: XY, loop: readonly XY[], preferred: XY): { index: number; path: XY[] } => {
    const candidates = loop.map((contourPoint, index) => ({
      index,
      contourPoint,
      distance: Math.hypot(contourPoint[0] - preferred[0], contourPoint[1] - preferred[1]),
    })).sort((first, second) => first.distance - second.distance);
    let lastError = "no contour point met the sampled connector constraints";
    for (const { index, contourPoint } of candidates) {
      const goalId = gridId(contourPoint);
      if (!allowed[goalId] || sampledGrade([positionAt(goalId), contourPoint]) > gradeLimit) continue;
      try {
        const gridPath = route(gridPoint, contourPoint);
        for (const candidate of [smoothPath(smoothPath(smoothPath(gridPath))), smoothPath(gridPath), gridPath]) {
          const path: XY[] = [];
          for (const position of [arterialPoint, ...candidate, contourPoint]) {
            if (!path.length || Math.hypot(position[0] - path.at(-1)![0], position[1] - path.at(-1)![1]) > 1e-8) {
              path.push(position);
            }
          }
          if (path.slice(1).every((position) => pointInRing(position, beverlyDistrict.ring))
            && pathAvoidsExclusions(path)
            && sampledGrade(path) <= gradeLimit) return { index, path };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`No sampled-grade Beverly connector from ${arterialPoint} to contour near ${preferred}: ${lastError}.`);
  };

  const a2 = output.find((road) => road.id === "A2");
  const a3 = output.find((road) => road.id === "A3");
  if (!a2 || !a3) throw new Error("Beverly contour roads require A2 and A3 arterial routes.");
  const insertRoadVertex = (road: RoadDefinition, position: XY): XY => {
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const start = road.coordinates[index - 1]!;
      const end = road.coordinates[index]!;
      const segmentLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (Math.hypot(position[0] - start[0], position[1] - start[1]) < 1e-8) return start;
      if (Math.hypot(position[0] - end[0], position[1] - end[1]) < 1e-8) return end;
      if (distanceToSegment(position, start, end) <= 1e-8 && segmentLength > 0) {
        road.coordinates = [...road.coordinates.slice(0, index), position, ...road.coordinates.slice(index)];
        return position;
      }
    }
    throw new Error(`Cannot snap Beverly hill-road access to ${road.id}.`);
  };
  const a2Anchor = insertRoadVertex(a2, closestPointOnRoad([19.1, 2.35], a2));
  const a2Start: XY = [19.1, 2.35];
  const a3Anchor = insertRoadVertex(a3, closestPointOnRoad([28, 9], a3));
  const a3Start: XY = [27.6, 8.75];
  const a3StartId = gridId(a3Start);
  if (!allowed[gridId(a2Start)] || !allowed[a3StartId]) {
    throw new Error("Beverly A2/A3 connector starts must lie inside the road-search grid.");
  }

  const eligibleContours = contours
    .filter(({ level, path }) => [200, 240].includes(level)
      && Math.hypot(path[0]![0] - path.at(-1)![0], path[0]![1] - path.at(-1)![1]) <= 0.001
      && sampledGrade(path) <= gradeLimit)
    .sort((first, second) => first.level - second.level)
    .slice(0, 2);
  if (eligibleContours.length !== 2) throw new Error("Two closed Beverly contours must meet the sampled grade limit.");

  const arc = (path: readonly XY[], start: number, end: number): XY[] => {
    const result: XY[] = [path[start]!];
    let index = start;
    while (index !== end) {
      index = (index + 1) % path.length;
      result.push(path[index]!);
    }
    return result;
  };
  for (const contour of eligibleContours) {
    let loop = contour.path.slice(0, -1);
    if (loop.length < 4) throw new Error(`Beverly ${contour.level} m contour has too few points for a road loop.`);
    const firstAccess = connectToContour(a2Anchor, a2Start, loop, [25.5, 4.2]);
    const arrival = firstAccess.path.at(-2)!, joint = loop[firstAccess.index]!, following = loop[(firstAccess.index + 1) % loop.length]!;
    if ((joint[0] - arrival[0]) * (following[0] - joint[0]) + (joint[1] - arrival[1]) * (following[1] - joint[1]) < 0) {
      loop = loop.reverse();
      firstAccess.index = loop.length - 1 - firstAccess.index;
    }
    const secondAccess = contour.level === 200
      ? connectToContour(a3Anchor, a3Start, loop, a3Anchor)
      : undefined;
    const start = firstAccess.index;
    const end = secondAccess?.index ?? (start + Math.floor(loop.length / 2)) % loop.length;
    if (start === end) throw new Error(`Beverly ${contour.level} m contour cannot be split into connected road arcs.`);
    const firstArc = arc(loop, start, end);
    const secondArc = arc(loop, end, start);
    if (contour.level === 200) {
      const uniqueLoop = loop.slice(0, -1);
      const ordered = [...uniqueLoop.slice(start), ...uniqueLoop.slice(0, start), uniqueLoop[start]!];
      const routedPath = rerouteLongStraightRuns([...firstAccess.path, ...ordered.slice(1)]);
      const arcs = Array.from({ length: 4 }, (_, index) => routedPath.slice(
        Math.floor(index * (routedPath.length - 1) / 4),
        Math.floor((index + 1) * (routedPath.length - 1) / 4) + 1,
      ));
      for (const [index, path] of arcs.entries()) {
        const grade = sampledGrade(path);
        if (grade > gradeLimit) throw new Error(`Beverly 200 m road arc exceeds the sampled grade limit: ${(grade * 100).toFixed(2)}%.`);
        const suffix = String.fromCharCode(97 + index);
        const roadId = index === 0 ? `hillroad-access-200-${suffix}` : `hillroad-contour-200-${suffix}`;
        addRoad(output, roadId, "", "hillroad", 0.012, path);
      }
      continue;
    }
    const splitArc = (path: readonly XY[]): [XY[], XY[]] => {
      const midpoint = Math.floor((path.length - 1) / 2);
      return [path.slice(0, midpoint + 1), path.slice(midpoint)];
    };
    const firstParts = splitArc(firstArc);
    const secondParts = splitArc(secondArc);
    const roadPaths = contour.level === 160
      ? [
        [...firstAccess.path, ...firstParts[0].slice(1)],
        firstParts[1],
        [...secondAccess!.path, ...secondParts[0].slice(1)],
        secondParts[1],
      ]
      : [
        [...firstAccess.path, ...firstParts[0].slice(1)],
        firstParts[1],
        secondParts[0],
        secondParts[1],
      ];
    const suffixes = ["a", "b", "c", "d"];
    for (const [index, sourcePath] of roadPaths.entries()) {
      const path = rerouteLongStraightRuns(sourcePath);
      if (sampledGrade(path) > gradeLimit) {
        throw new Error(`Beverly ${contour.level} m road arc exceeds the sampled 8% grade limit.`);
      }
      const suffix = suffixes[index]!;
      const isAccess = contour.level === 160 && (suffix === "a" || suffix === "c");
      const roadId = isAccess
        ? `hillroad-access-${contour.level}-${suffix}`
        : `hillroad-contour-${contour.level}-${suffix}`;
      addRoad(output, roadId, "", "hillroad", 0.012, path);
    }
  }
}

function closestPointOnRoad(position: XY, road: RoadDefinition): XY {
  let closest = road.coordinates[0]!;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < road.coordinates.length; index += 1) {
    const start = road.coordinates[index - 1]!;
    const end = road.coordinates[index]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const squared = dx * dx + dy * dy;
    const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((position[0] - start[0]) * dx + (position[1] - start[1]) * dy) / squared));
    const projection: XY = [start[0] + dx * t, start[1] + dy * t];
    const distance = Math.hypot(position[0] - projection[0], position[1] - projection[1]);
    if (distance < minimum) {
      minimum = distance;
      closest = projection;
    }
  }
  return closest;
}

function curvedRuralPath(start: XY, end: XY, bend: number): XY[] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy) || 1;
  const middle: XY = [
    (start[0] + end[0]) / 2 - dy / length * bend,
    (start[1] + end[1]) / 2 + dx / length * bend,
  ];
  return [start, middle, end];
}

function generateRuralRoads(output: RoadDefinition[], towns: readonly TownArea[]): void {
  const highways = output.filter((road) => road.roadClass === "motorway" || road.roadClass === "arterial");
  const connections = new Set<string>();
  for (const town of towns) {
    const nearestTown = towns.filter((candidate) => candidate.id !== town.id)
      .map((candidate) => ({ candidate, distance: Math.hypot(candidate.center[0] - town.center[0], candidate.center[1] - town.center[1]) }))
      .sort((a, b) => a.distance - b.distance)[0]!.candidate;
    const townPair = [town.id, nearestTown.id].sort().join(":");
    if (!connections.has(townPair)) {
      connections.add(townPair);
      addRoad(output, `rural-link-${townPair.replace(":", "-")}`, "", "rural", 0.008, curvedRuralPath(town.center, nearestTown.center, 0.18));
    }
    const nearestRoad = highways.map((road) => ({ road, point: closestPointOnRoad(town.center, road) }))
      .map((item) => ({ ...item, distance: Math.hypot(item.point[0] - town.center[0], item.point[1] - town.center[1]) }))
      .sort((a, b) => a.distance - b.distance)[0]!;
    addRoad(output, `rural-highway-${town.id}`, "", "rural", 0.008, curvedRuralPath(town.center, nearestRoad.point, 0.12));
    addRoad(output, `rural-main-${town.id}`, "", "rural", 0.008, [[town.center[0] - 0.23, town.center[1]], town.center, [town.center[0] + 0.23, town.center[1]]]);
    for (let branch = 0; branch < 3; branch += 1) {
      const offset = -0.18 + branch * 0.18;
      addRoad(output, `rural-branch-${town.id}-${branch + 1}`, "", "rural", 0.008,
        [[town.center[0] + offset, town.center[1]], [town.center[0] + offset, town.center[1] + (branch % 2 === 0 ? 0.17 : -0.17)]]);
    }
  }
}


function randomInsideRing(ring: Ring, width: number, depth: number): XY {
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  for (let attempt = 0; attempt < 100000; attempt += 1) {
    const center: XY = [
      Math.min(...xs) + width / 2 + rand() * (Math.max(...xs) - Math.min(...xs) - width),
      Math.min(...ys) + depth / 2 + rand() * (Math.max(...ys) - Math.min(...ys) - depth),
    ];
    const footprint = localRect(center, width, depth);
    if (within(footprint, ring)) return center;
  }
  throw new Error("Unable to sample a polygon footprint inside its region.");
}

function generateFarmAndPortSurfaces(
  woodsRings: readonly Ring[],
  towns: readonly TownArea[],
  woodsFeatures: readonly Feature<Polygon, Properties>[],
): Feature<Polygon, Properties>[] {
  const surfaces: Feature<Polygon, Properties>[] = [...woodsFeatures];
  const reserve = districtById.get("reserve")!;
  const reserveBounds = {
    west: Math.min(...reserve.ring.map(([x]) => x)),
    east: Math.max(...reserve.ring.map(([x]) => x)),
    south: Math.min(...reserve.ring.map(([, y]) => y)),
    north: Math.max(...reserve.ring.map(([, y]) => y)),
  };
  const seedFeatures: Feature<Point, Properties>[] = [];
  const seedBuckets = new Map<string, XY[]>();
  const seedSpacing = 0.16;
  for (let attempt = 0; attempt < 160_000 && seedFeatures.length < 2400; attempt += 1) {
    const candidate: XY = [
      reserveBounds.west + landRand() * (reserveBounds.east - reserveBounds.west),
      reserveBounds.south + landRand() * (reserveBounds.north - reserveBounds.south),
    ];
    if (!pointInRing(candidate, reserve.ring)
      || woodsRings.some((ring) => pointInRing(candidate, ring))
      || towns.some((town) => pointInRing(candidate, town.ring))) continue;
    const cellX = Math.floor(candidate[0] / seedSpacing);
    const cellY = Math.floor(candidate[1] / seedSpacing);
    let tooClose = false;
    for (let x = cellX - 1; x <= cellX + 1 && !tooClose; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1 && !tooClose; y += 1) {
        for (const prior of seedBuckets.get(`${x}:${y}`) ?? []) {
          if (Math.hypot(candidate[0] - prior[0], candidate[1] - prior[1]) < seedSpacing) tooClose = true;
        }
      }
    }
    if (tooClose) continue;
    seedBuckets.set(`${cellX}:${cellY}`, [...(seedBuckets.get(`${cellX}:${cellY}`) ?? []), candidate]);
    seedFeatures.push(point([candidate[0], candidate[1]], { seed: seedFeatures.length }));
  }
  if (seedFeatures.length < 2200) throw new Error(`Reserve farm tessellation produced only ${seedFeatures.length} Voronoi seeds.`);

  let farmableRegion = bufferedLocalGeometry(polygonGeometry([reserve.ring]), -0.01);
  const exclusions = [
    ...woodsFeatures.filter((wood) => wood.properties?.sector === "reserve")
      .map((wood) => bufferedLocalGeometry(wood.geometry, 0.01)),
    ...towns.map((town) => bufferedLocalGeometry(polygonGeometry([town.ring]), 0.01)),
  ];
  for (const exclusion of exclusions) {
    const remaining = subtractPolygon(farmableRegion, exclusion);
    if (!remaining) throw new Error("Reserve farmable region was fully excluded by woods and towns.");
    farmableRegion = feature(remaining.geometry, {});
  }
  const cells = voronoi(featureCollection(seedFeatures), {
    bbox: [reserveBounds.west, reserveBounds.south, reserveBounds.east, reserveBounds.north],
  });
  const orderedCells = cells.features
    .filter((cell): cell is Feature<Polygon, Properties> => cell.geometry?.type === "Polygon")
    .map((cell) => ({ cell, rank: landRand() }))
    .sort((a, b) => a.rank - b.rank);
  const reserveArea = planarArea([reserve.ring]);
  let farmArea = 0;
  let farmCount = 0;
  for (const { cell } of orderedCells) {
    if (farmArea >= reserveArea * 0.5 || farmCount >= 2000) break;
    const vertices = cell.geometry.coordinates[0]!.slice(0, -1)
      .map((position): XY => [position[0]!, position[1]!]);
    if (vertices.length < 3) continue;
    const center: XY = [
      vertices.reduce((sum, position) => sum + position[0], 0) / vertices.length,
      vertices.reduce((sum, position) => sum + position[1], 0) / vertices.length,
    ];
    const inset = close(vertices.map(([x, y]) => [center[0] + (x - center[0]) * 0.975, center[1] + (y - center[1]) * 0.975]));
    const overlap = intersect(featureCollection([localPolygon(inset), farmableRegion]));
    if (!overlap) continue;
    for (const polygon of polygonPieces(overlap.geometry)) {
      const outer = polygon[0]!;
      const xs = outer.map(([x]) => x);
      const ys = outer.map(([, y]) => y);
      const width = Math.max(...xs) - Math.min(...xs);
      const depth = Math.max(...ys) - Math.min(...ys);
      const area = planarArea(polygon);
      if (width < 0.15 || depth < 0.15 || width > 0.6 || depth > 0.6 || area < 0.008) continue;
      const geometry = polygonGeometry(polygon);
      const rounded = geometry.coordinates[0]!.map(localFromCoordinate);
      const roundedWidth = Math.max(...rounded.map(p => p[0])) - Math.min(...rounded.map(p => p[0]));
      const roundedDepth = Math.max(...rounded.map(p => p[1])) - Math.min(...rounded.map(p => p[1]));
      if (roundedWidth < 0.15 || roundedDepth < 0.15 || roundedWidth > 0.6 || roundedDepth > 0.6) continue;
      if (farmArea + area > reserveArea * 0.53) continue;
      const tone = Math.abs(Math.floor((center[0] * 17 + center[1] * 23) * 10)) % 4;
      surfaces.push(feature(geometry, { kind: "farm", tone }));
      farmArea += area;
      farmCount += 1;
      if (farmArea >= reserveArea * 0.5 || farmCount >= 2000) break;
    }
  }
  const farmCoverage = farmArea / reserveArea;
  if (farmCount < 1000 || farmCount > 2000 || farmCoverage < 0.45 || farmCoverage > 0.55) {
    throw new Error(`Reserve Voronoi farms count=${farmCount}, coverage=${(farmCoverage * 100).toFixed(2)}%; expected 1,000-2,000 and 45-55%.`);
  }

  const coastlineWestXAtY = (y: number): number => {
    for (let index = 1; index < coastline.length; index += 1) {
      const a = coastline[index - 1]!;
      const b = coastline[index]!;
      if (y < Math.min(a[1], b[1]) || y > Math.max(a[1], b[1]) || Math.abs(a[1] - b[1]) < 1e-10) continue;
      const t = (y - a[1]) / (b[1] - a[1]);
      return a[0] + (b[0] - a[0]) * t;
    }
    throw new Error("No Fleet Port coast crossing for y=" + y + ".");
  };
  for (let index = 0; index < 8; index += 1) {
    const y = 26.2 + index * 0.55;
    const shoreX = coastlineWestXAtY(y);
    const endX = shoreX - (0.16 + rand() * 0.18);
    const width = 0.035;
    const ring = close([[endX, y - width / 2], [shoreX + 0.06, y - width / 2], [shoreX + 0.06, y + width / 2], [endX, y + width / 2]]);
    surfaces.push(feature({ type: "Polygon", coordinates: [ring.map(coordinate)] }, { kind: "pier", sector: "fleet-port" }));
  }
  for (const [index, x] of [1.4, 2.5, 3.6, 4.7, 5.8, 6.9, 7.6].entries()) {
    const shoreY = coastlineYAtX(x);
    const endY = shoreY - 0.18 - rand() * 0.12;
    const ring = close([[x - 0.018, endY], [x + 0.018, endY], [x + 0.018, shoreY + 0.04], [x - 0.018, shoreY + 0.04]]);
    surfaces.push(feature(polygonGeometry([ring]), { kind: "pier", sector: "south-coast", palette: index % 3 }));
  }
  const starFerry = pointById.get("star-ferry")!;
  const starFerryX = starFerry.position[0];
  const starFerryShoreY = coastlineYAtX(starFerryX);
  const starFerryRing = close([
    [starFerryX - 0.018, starFerryShoreY - 0.24],
    [starFerryX + 0.018, starFerryShoreY - 0.24],
    [starFerryX + 0.018, starFerryShoreY + 0.04],
    [starFerryX - 0.018, starFerryShoreY + 0.04],
  ]);
  surfaces.push(feature(polygonGeometry([starFerryRing]), {
    kind: "pier", sector: "star-ferry", id: starFerry.id, name: starFerry.name,
  }));
  return surfaces;
}




function generateTrees(): Feature<Polygon, Properties>[] {
  const lake: Ring = close([[4.72, 6.08], [5.2, 6.08], [5.28, 6.52], [4.78, 6.58]]);
  const trees: Feature<Polygon, Properties>[] = [];
  for (const [parkId, count] of [["central-park", 800], ["battery-park", 150]] as const) {
    const park = parkById.get(parkId)!;
    let created = 0;
    for (let attempt = 0; created < count && attempt < count * 2000; attempt += 1) {
      const width = 0.012 + rand() * 0.01;
      const depth = 0.012 + rand() * 0.01;
      const position = randomInsideRing(park.ring, width, depth);
      const ring = localRect(position, width, depth);
      if (parkId === "central-park" && !disjoint(ring, lake)) continue;
      trees.push(feature(polygonGeometry([ring]), {
        h: 10 + Math.round(rand() * 14),
        w: Math.round(width * 1000),
        d: Math.round(depth * 1000),
        park: parkId,
      }));
      created += 1;
    }
    if (created !== count) throw new Error("Could not place " + count + " trees in " + parkId + ".");
  }
  return trees;
}

function generateLabels(): Feature<Point, Properties>[] {
  const areas = [
    ...districts.map((district) => ({ id: district.id, name: district.name, kind: "district", priority: 10, ring: district.ring })),
    ...land.filter((region) => region.kind !== "monaco").map((region) => ({
      id: region.id!, name: region.name!, kind: "neighbor", priority: 5, ring: region.ring,
    })),
  ];
  return areas.flatMap(({ id, name, kind, priority, ring }) => {
    const fixedPositions = districtLabelPositions[id];
    if (fixedPositions) return fixedPositions.map((position) => feature(pointGeometry(position), { id, name, kind, priority }));
    const local: Feature<Polygon> = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring.map(([x, y]) => [x, y])] } };
    const coordinates = pointOnFeature(local).geometry.coordinates;
    const position: XY = [coordinates[0]!, coordinates[1]!];
    return [feature(pointGeometry(position), { id, name, kind, priority })];
  });
}

function generateMetro(): { lines: Feature<LineString, Properties>[]; stationFeatures: Feature<Point, Properties>[] } {
  const routes = metroPaths();
  const lineFeatures = transitLines.map(({ id, color, stations: stopIds }) => {
    const route = routes.get(id)!;
    const stopPositions = stations.filter(station => stopIds.includes(station.id)).map(station => station.position);
    return feature(lineGeometry(cleanRoundedPath(route, stopPositions)), { id, name: id, color, stations: stopIds.join(",") });
  });
  const membership = new Map<string, string[]>();
  for (const line of transitLines) {
    for (const stationId of line.stations) membership.set(stationId, [...(membership.get(stationId) ?? []), line.id]);
  }
  const stationFeatures = stations.map(({ id, name, district, position }) => {
    const lines = membership.get(id) ?? [];
    return feature(pointGeometry(position), { id, name, district, lines: lines.join(","), transfer: lines.length > 1 ? 1 : 0 });
  });
  return { lines: lineFeatures, stationFeatures };
}

function generateSurfaces(woods: readonly Feature<Polygon, Properties>[], woodsRings: readonly Ring[], towns: readonly TownArea[]): Feature<Polygon, Properties>[] {
  const surfaces = generateFarmAndPortSurfaces(woodsRings, towns, woods);
  const lake: Ring = close([[4.72, 6.08], [5.2, 6.08], [5.28, 6.52], [4.78, 6.58]]);
  surfaces.push(feature({ type: "Polygon", coordinates: [lake.map(coordinate)] }, { kind: "lake" }));
  return surfaces;
}

function generateBlocksAndBuildings(
  roads: RoadIndex,
  coast: RoadIndex,
): void {
  generateManhattanBlocks(roads, coast);
}

function classifyBlocks(): void {
  const bidsByBlock = new Map<string, Map<string, number>>();
  for (const building of buildingFeatures) {
    const properties = building.properties ?? {};
    if (Number(properties.base) !== 0 || typeof properties.block_id !== "string") continue;
    const bid = String(properties.bid);
    const byBid = bidsByBlock.get(properties.block_id) ?? new Map<string, number>();
    byBid.set(bid, Number(properties.top ?? properties.height ?? 0));
    bidsByBlock.set(properties.block_id, byBid);
  }
  for (const block of blockFeatures) {
    const properties = block.properties ?? {};
    if (properties.kind === "plaza") {
      properties.type = "plaza";
      continue;
    }
    if (properties.kind === "superblock") {
      continue;
    }
    if (properties.kind === "town") {
      properties.type = "town";
      continue;
    }
    if (properties.zone === "beverly") {
      properties.type = "lowdensity";
      continue;
    }
    if (properties.zone === "uptown") {
      properties.type = "midrise";
      continue;
    }
    const blockId = String(properties.block_id);
    const heights = [...(bidsByBlock.get(blockId)?.values() ?? [])];
    const maximum = Math.max(0, ...heights);
    const mean = heights.length ? heights.reduce((sum, height) => sum + height, 0) / heights.length : 0;
    properties.type = maximum >= 150 ? "highrise"
      : mean >= 45 || maximum >= 90 ? "midrise" : "lowrise";
  }
}

export function generateSourceRoadsForValidation(contours = generateBeverlyRoadContours()): RoadDefinition[] {
  if (!roadExclusions.length) addPlazaAndLandmarks();
  const roads = generateRoadNetwork();
  roads.push(...regionalArterials());
  generateBeverlyRoads(roads, contours);
  generateRuralRoads(roads, createTownAreas());
  return roads;
}

export function generateRoadsForValidation(contours = generateBeverlyRoadContours()): RoadDefinition[] {
  const source = generateSourceRoadsForValidation(contours).map(road => road.roadClass === "hillroad"
    ? { ...road, coordinates: roundHillroadTurns(road.coordinates, beverlyElevationAt, p => pointInRing(p, beverlyDistrict.ring)
      && roadExclusions.every(ring => !pointInRing(p, ring))) } : road);
  const prepared = prepareRoadNetwork(source).map(road => road.roadClass === "hillroad" || road.roadClass === "street"
    ? road : { ...road, coordinates: roundHillroadTurns(road.coordinates, () => 0) });
  return finalizeRoadNetwork(clipRoadsAroundLandmarks(prepared, roadExclusions));
}

export function generateData(): Record<string, Collection> {
  rand = rng(0x4d4f4e41);
  landRand = rng(0x4c414e44);
  buildingFeatures.length = 0;
  blockFeatures.length = 0;
  plazaExclusions.length = 0;
  roadExclusions.length = 0;
  nextBuildingId = 0;
  nextBlockId = 0;
  const towns = createTownAreas();
  addPlazaAndLandmarks();
  const terrain = generateBeverlyTerrain();
  const clippedRoads = generateRoadsForValidation(terrain.contourPaths);
  const roadIndex = buildRoadIndex(clippedRoads);
  const coastIndex = buildRoadIndex([{ id: "coastal-setback", name: "", roadClass: "local", width: 0.06, coordinates: coastline }]);
  const woods = generateWoods(towns);
  generateBlocksAndBuildings(roadIndex, coastIndex);
  const metro = generateMetro();

  const landFeatures = land.map(({ kind, id, name, ring }) => feature(
    { type: "Polygon", coordinates: [ring.map(coordinate)] },
    { kind, ...(id ? { id, name: name! } : {}) },
  ));
  const districtFeatures = districts.map(({ id, name, kind, ring }) => feature(
    { type: "Polygon", coordinates: [ring.map(coordinate)] }, { id, name, kind },
  ));
  const parkFeatures = parks.map(({ id, name, kind, ring }) => feature(
    { type: "Polygon", coordinates: [ring.map(coordinate)] }, { id, name, kind },
  ));
  const roadFeatures = clippedRoads.filter(({ roadClass }) => roadClass !== "street").map(({ id, name, roadClass, width, coordinates }) => feature(
    lineGeometry(coordinates), { id, name, class: roadClass, width },
  ));
  const poiFeatures = points.map(({ id, name, category, district, position }) => feature(
    pointGeometry(position), { id, name, category, district },
  ));
  const boundaryFeatures = generatedBoundaries.map(({ id, kind, coordinates }) => feature(
    lineGeometry(coordinates), { id, kind },
  ));
  const treeFeatures = generateTrees();
  const surfaceFeatures = generateSurfaces(woods.features, woods.rings, towns);
  for (const item of surfaceFeatures) {
    if (item.properties?.kind !== "farm" || item.geometry.type !== "Polygon") continue;
    const vertices = item.geometry.coordinates[0]!.map(localFromCoordinate);
    item.properties.furrow = vertices.reduce((sum, [, y]) => sum + y, 0) / vertices.length > 25 ? "north" : "east";
  }
  const terrainFeatures = [...terrain.bands, ...terrain.contours];
  for (const town of towns) blockFeatures.push(feature(polygonGeometry([town.ring]), { kind: 'town', type: 'town', zone: 'reserve', town_id: town.id }));
  surfaceFeatures.push(feature(polygonGeometry([airportRing]), { kind: 'airport', id: 'airport' }));
  for (const [index, endpoints] of airportRunways.entries()) {
    const center: XY = [(endpoints[0][0] + endpoints[1][0]) / 2, (endpoints[0][1] + endpoints[1][1]) / 2];
    surfaceFeatures.push(feature(polygonGeometry([rectangleRing(center, airport.runwayLength, airport.runwayWidth, airport.angle)]), { kind: 'runway', runway: index }));
  }
  surfaceFeatures.push(feature(polygonGeometry([airportApron]), { kind: 'airport-apron' }));
  for (const ring of airportTaxiways) surfaceFeatures.push(feature(polygonGeometry([ring]), { kind: 'airport-taxiway' }));
  for (const ring of airportPiers) surfaceFeatures.push(feature(polygonGeometry([ring]), { kind: 'airport-pier' }));
  for (const ring of airportAircraft) surfaceFeatures.push(feature(polygonGeometry([ring]), { kind: 'airport-aircraft' }));
  const terminal = airportPosition(0, -0.3);
  const airportBlock = addBlock(rectangleRing(terminal, 1.1, 0.15, airport.angle), 'harlem', 'block');
  buildingSegments(terminal, 1.1, 0.15, 30, 'landmark', airportBlock, airport.angle * 180 / Math.PI, { id: 'airport', name: '机场' });
  const tower = airportPosition(-0.8, -0.4);
  const towerBlock = addBlock(rectangleRing(tower, 0.06, 0.06, airport.angle), 'harlem', 'block');
  buildingSegments(tower, 0.06, 0.06, 60, 'landmark', towerBlock, airport.angle * 180 / Math.PI, { id: 'airport', name: '机场' });
  classifyBlocks();
  return {
    land: collection(landFeatures),
    districts: collection(districtFeatures),
    parks: collection(parkFeatures),
    roads: collection(roadFeatures),
    metro_lines: collection(metro.lines),
    metro_stations: collection(metro.stationFeatures),
    buildings: collection([...buildingFeatures]),
    pois: collection(poiFeatures),
    blocks: collection([...blockFeatures]),
    trees: collection(treeFeatures),
    terrain: collection(terrainFeatures),
    labels: collection(generateLabels()),
    boundaries: collection(boundaryFeatures),
    surface: collection(surfaceFeatures),
  };
}
