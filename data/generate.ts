import {
  booleanDisjoint, booleanWithin, buffer, difference, featureCollection, intersect, isobands, isolines,
  lineIntersect, lineString, point, pointOnFeature, simplify, voronoi,
} from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from "geojson";
import {
  closeRing, distanceToSegment, pointInRing, polygonArea, rectangleRing, reversePath,
} from "./geometry";
import { routeOnRoads } from "./metro";
import {
  beverlyHills, coastline, coastlineYAtX, districts, generatedBoundaries, land, parks, points,
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
  return { type: "Polygon", coordinates: rings.map((ring, index) => {
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
        pieces.push([
          [start[0] + dx * from, start[1] + dy * from],
          [start[0] + dx * to, start[1] + dy * to],
        ]);
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

  for (const line of transitLines) {
    for (const [leg, coordinates] of Object.entries(line.routes ?? {})) {
      addRoad(result, `metro-corridor-${line.id}-${leg.replaceAll(">", "-")}`, "", "local", 0.022, coordinates);
    }
  }

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
  let height = 11 + 28 * u1;
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
        const lotWidth = Math.min(0.05 + rand() * 0.04, longEnd - offset);
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
          if (booleanWithin(localPolygon(footprint), localPolygonWithHoles(piece)) && footprintAllowed(footprint, roads, 0)) {
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

const regionalSuperblockTypes: Readonly<Record<string, string>> = {
  uptown: "midrise",
  "st-germain": "lowrise",
  harlem: "lowrise",
  brooklyn: "lowrise",
};
const brooklynMidriseShare = 0.2;

function generateRegionalTexture(roads: RoadDefinition[]): void {
  const coastIndex = buildRoadIndex([{ id: "coastal-setback", name: "", roadClass: "local", width: 0.06, coordinates: coastline }]);
  let superblockNumber = 0;
  const brooklynBlocks: Array<{ block: Feature<Polygon, Properties>; center: XY }> = [];
  for (const district of districts.filter((item) => item.id !== "manhattan" && item.id !== "fleet-port" && item.id !== "reserve" && item.id !== "beverly")) {
    const bounds = {
      west: Math.min(...district.ring.map(([x]) => x)),
      east: Math.max(...district.ring.map(([x]) => x)),
      south: Math.min(...district.ring.map(([, y]) => y)),
      north: Math.max(...district.ring.map(([, y]) => y)),
    };
    const step = 1.5;
    const districtStations = stations.filter((station) =>
      station.district === district.name || district.ring.slice(1).some((end, index) =>
        distanceToSegment(station.position, district.ring[index]!, end) < 0.001,
      ),
    );
    const rowValues: number[] = [];
    for (let y = Math.ceil(bounds.south + 0.7); y < bounds.north - 0.2; y += step) {
      if (!districtStations.some((station) => Math.abs(station.position[1] - y) < 0.6)) rowValues.push(y);
    }
    for (const station of districtStations) {
      if (station.position[1] >= bounds.south - 0.001 && station.position[1] <= bounds.north + 0.001) rowValues.push(station.position[1]);
    }
    for (const [row, y] of [...new Set(rowValues)].sort((a, b) => a - b).entries()) {
      const segments = clipLineToRing([[bounds.west, y], [bounds.east, y]], district.ring);
      for (const [part, segment] of segments.entries()) {
        addRoad(roads, "superblock-road-h-" + district.id + "-" + row + "-" + part, "", "arterial", 0.024, segment);
      }
    }
    let column = 0;
    for (let x = Math.ceil(bounds.west + 0.8); x < bounds.east - 0.2; x += step) {
      const segments = clipLineToRing([[x, bounds.south], [x, bounds.north]], district.ring);
      for (const [part, segment] of segments.entries()) {
        addRoad(roads, "superblock-road-v-" + district.id + "-" + column + "-" + part, "", "arterial", 0.024, segment);
      }
      column += 1;
    }
    const districtRoadIndex = buildRoadIndex(roads);
    const xs: number[] = [bounds.west];
    const ys: number[] = [bounds.south];
    for (let x = bounds.west + step; x < bounds.east; x += step) xs.push(x);
    for (let y = bounds.south + step; y < bounds.north; y += step) ys.push(y);
    xs.push(bounds.east);
    ys.push(bounds.north);
    for (let x = 1; x < xs.length; x += 1) {
      for (let y = 1; y < ys.length; y += 1) {
        const ring = close([[xs[x - 1]!, ys[y - 1]!], [xs[x]!, ys[y - 1]!], [xs[x]!, ys[y]!], [xs[x - 1]!, ys[y]!]]);
        const pieces = clipBlockPieces(ring, district.ring, districtRoadIndex, coastIndex);
        for (const piece of pieces) {
          const blockId = `SB-${district.id}-${String(superblockNumber++).padStart(5, "0")}`;
          const block = feature(polygonGeometry(piece), {
            block_id: blockId,
            kind: "superblock",
            zone: district.id,
            type: regionalSuperblockTypes[district.id] ?? "lowrise",
          });
          blockFeatures.push(block);
          if (district.id === "brooklyn") brooklynBlocks.push({ block, center: centerOf(piece[0]!) });
        }
      }
    }
  }
  const brooklynDistrict = districtById.get("brooklyn")!;
  const brooklynStations = stations.filter((station) => station.district === brooklynDistrict.name);
  const motorways = roads.filter((road) => road.roadClass === "motorway");
  const priority = ({ center }: { center: XY }): number => {
    const highwayDistance = Math.min(...motorways.flatMap((road) => road.coordinates.slice(1).map((end, index) =>
      distanceToSegment(center, road.coordinates[index]!, end))));
    const stationDistance = Math.min(...brooklynStations.map((station) => Math.hypot(
      center[0] - station.position[0], center[1] - station.position[1],
    )));
    return highwayDistance + stationDistance;
  };
  brooklynBlocks.sort((first, second) => priority(first) - priority(second));
  const brooklynMidriseCount = Math.round(brooklynBlocks.length * brooklynMidriseShare);
  for (const [index, { block }] of brooklynBlocks.entries()) {
    block.properties!.type = index < brooklynMidriseCount ? "midrise" : "lowrise";
  }
}

const beverlyDistrict = districtById.get("beverly")!;
const reserveDistrict = districtById.get("reserve")!;

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function elevationAt(x: number, y: number): number {
  if (x < 9 || x > 28 || y < 0 || y > 9) return 0;
  if (y < 2.8) {
    const coast = Math.min(35, 18 + 8 * Math.sin(x * 0.6));
    return Math.round(coast * smoothstep((2.8 - y) / 0.5));
  }
  const edgeDistance = Math.min(x - 9, 28 - x, y - 2.8, 9 - y);
  if (edgeDistance <= 0) return 0;
  const taper = smoothstep(edgeDistance / 1.15);
  const hills = Math.pow(beverlyHills.reduce((sum, hill) => {
    const dx = (x - hill.center[0]) / hill.sigmaX;
    const dy = (y - hill.center[1]) / hill.sigmaY;
    return sum + Math.pow(hill.peak * Math.exp(-0.5 * (dx * dx + dy * dy)), 4);
  }, 0), 0.25);
  return Math.round(Math.min(320, hills * taper));
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

function generateBeverlyTerrain(): { bands: Feature<Polygon, Properties>[]; contours: Feature<LineString, Properties>[] } {
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
    for (const path of (smoothed.geometry as MultiLineString).coordinates) {
      const localPath = path.map(([x, y]) => [x, y] as XY);
      for (const segment of clipLineToRing(localPath, beverlyDistrict.ring)) {
        contours.push(feature(lineGeometry(segment), {
          kind: "contour",
          level: Number(source.properties?.level ?? 0),
        }));
      }
    }
  }
  return { bands, contours };
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

function forestEllipse(center: XY, radiusX: number, radiusY: number, phase: number): Ring {
  const points: XY[] = [];
  const fieldPhase = phase + landRand() * Math.PI * 2;
  for (let index = 0; index < 96; index += 1) {
    const angle = (index / 96) * Math.PI * 2;
    const x = Math.cos(angle) * radiusX;
    const y = Math.sin(angle) * radiusY;
    const radius = 1 + 0.065 * smoothLandNoise(center[0] + x, center[1] + y, fieldPhase);
    points.push([center[0] + x * radius, center[1] + y * radius]);
  }
  return close(points);
}

function generateWoods(towns: readonly TownArea[]): { features: Feature<Polygon, Properties>[]; rings: Ring[] } {
  const woods: Feature<Polygon, Properties>[] = [];
  const rings: Ring[] = [];
  const priorBeverlyWoods: Feature<Polygon | MultiPolygon, Properties>[] = [];
  for (const [index, hill] of beverlyHills.entries()) {
    const patch = forestEllipse(hill.center, 1.72, 1.82, index * 0.83);
    for (const clipped of intersectWithRing([patch], beverlyDistrict.ring)) {
      let fragments: Feature<Polygon | MultiPolygon, Properties>[] = [feature(localPolygonWithHoles(clipped).geometry, {})];
      for (const obstacle of priorBeverlyWoods) {
        fragments = fragments.flatMap((fragment) => {
          const difference = subtractPolygon(fragment, obstacle);
          return difference ? polygonPieces(difference.geometry).map((piece) => feature(localPolygonWithHoles(piece).geometry, {})) : [];
        });
      }
      for (const fragment of fragments) {
        for (const piece of polygonPieces(fragment.geometry)) {
          const localPolygon = feature(localPolygonWithHoles(piece).geometry, { kind: "wood", sector: "beverly" });
          woods.push(feature(polygonGeometry(piece), localPolygon.properties));
          priorBeverlyWoods.push(localPolygon);
          rings.push(piece[0]!);
        }
      }
    }
  }

  const reservePatches = [
    ...[16, 21.5, 27, 33].map((x, index) => ({ center: [x, 31.5] as XY, rx: 2.5, ry: 2.1, phase: index * 0.8 })),
    ...[20, 12, 4].map((y, index) => ({ center: [33, y] as XY, rx: 2.6, ry: 2.7, phase: 1.1 + index * 0.7 })),
  ];
  const priorReserveWoods: Feature<Polygon | MultiPolygon, Properties>[] = [];
  for (const patch of reservePatches) {
    const ring = forestEllipse(patch.center, patch.rx, patch.ry, patch.phase);
    for (const piece of intersectWithRing([ring], reserveDistrict.ring)) {
      let fragments: Feature<Polygon | MultiPolygon, Properties>[] = [feature(localPolygonWithHoles(piece).geometry, {})];
      for (const town of towns) {
        fragments = fragments.flatMap((fragment) => {
          const difference = subtractPolygon(fragment, localPolygon(town.ring));
          return difference ? polygonPieces(difference.geometry).map((part) => feature(localPolygonWithHoles(part).geometry, {})) : [];
        });
      }
      for (const obstacle of priorReserveWoods) {
        fragments = fragments.flatMap((fragment) => {
          const difference = subtractPolygon(fragment, obstacle);
          return difference ? polygonPieces(difference.geometry).map((part) => feature(localPolygonWithHoles(part).geometry, {})) : [];
        });
      }
      for (const fragment of fragments) {
        for (const part of polygonPieces(fragment.geometry)) {
          if (planarArea(part) < 0.3) continue;
          const wood = feature(localPolygonWithHoles(part).geometry, { kind: "wood", sector: "reserve" });
          woods.push(feature(polygonGeometry(part), wood.properties));
          priorReserveWoods.push(wood);
          rings.push(part[0]!);
        }
      }
    }
  }
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

function generateBeverlyRoads(output: RoadDefinition[]): void {
  const gridSize = 0.1;
  const columns = 191;
  const rows = 67;
  const positionAt = (id: number): XY => [9 + (id % columns) * gridSize, 2.35 + Math.floor(id / columns) * gridSize];
  const gridId = ([x, y]: XY): number => Math.round((y - 2.35) / gridSize) * columns + Math.round((x - 9) / gridSize);
  const allowed = Array.from({ length: columns * rows }, (_, id) => pointInRing(positionAt(id), beverlyDistrict.ring));
  const heights = Float64Array.from(allowed, (_, id) => elevationAt(...positionAt(id)));
  const directions: readonly XY[] = [
    [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
    [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2],
  ];
  const gradeLimit = 0.075;
  const safeEdges = new Map<string, boolean>();
  const route = (start: XY, goal: XY): XY[] => {
    const from = gridId(start);
    const to = gridId(goal);
    if (!allowed[from] || !allowed[to]) throw new Error("Beverly hill-road endpoint falls outside the district.");
    const distances = new Float64Array(allowed.length).fill(Number.POSITIVE_INFINITY);
    const previous = new Int32Array(allowed.length).fill(-1);
    const visited = new Uint8Array(allowed.length);
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
    distances[from] = 0;
    add(from, Math.hypot(start[0] - goal[0], start[1] - goal[1]));
    while (pending.length > 0) {
      const current = remove().id;
      if (visited[current]) continue;
      if (current === to) {
        const path: XY[] = [];
        for (let cursor = to; cursor !== -1; cursor = previous[cursor]!) path.push(positionAt(cursor));
        return path.reverse();
      }
      visited[current] = 1;
      const x = current % columns;
      const y = Math.floor(current / columns);
      const first = positionAt(current);
      for (const [dx, dy] of directions) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows) continue;
        const next = nextY * columns + nextX;
        if (!allowed[next] || visited[next]) continue;
        const second = positionAt(next);
        const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
        const edgeId = `${Math.min(current, next)}:${Math.max(current, next)}`;
        let safe = safeEdges.get(edgeId);
        if (safe === undefined) {
          const samples = Math.ceil(length / 0.05);
          let priorHeight = heights[current]!;
          safe = true;
          for (let sample = 1; sample <= samples; sample += 1) {
            const ratio = sample / samples;
            const height = elevationAt(first[0] + (second[0] - first[0]) * ratio, first[1] + (second[1] - first[1]) * ratio);
            if (Math.abs(height - priorHeight) / (length * 1000 / samples) > gradeLimit) {
              safe = false;
              break;
            }
            priorHeight = height;
          }
          safeEdges.set(edgeId, safe);
        }
        if (!safe) continue;
        const grade = Math.abs(heights[next]! - heights[current]!) / (length * 1000);
        const cost = distances[current]! + length * (1 + grade * 8);
        if (cost >= distances[next]!) continue;
        distances[next] = cost;
        previous[next] = current;
        add(next, cost + Math.hypot(second[0] - goal[0], second[1] - goal[1]));
      }
    }
    throw new Error(`No grade-limited Beverly route from ${start} to ${goal}.`);
  };

  const spine: XY[] = [];
  for (let index = 0; index <= 167; index += 1) spine.push([11.3 + index * gridSize, 2.35]);
  addRoad(output, "hillroad-contour-spine", "", "hillroad", 0.012, spine);
  for (const [index, hill] of beverlyHills.entries()) {
    addRoad(output, `hillroad-${String(index + 1).padStart(2, "0")}-1`, "", "hillroad", 0.012,
      route([hill.center[0], 2.35], [hill.center[0] + 0.7, 3.45]));
  }
  addRoad(output, "hillroad-link-a2", "", "hillroad", 0.012,
    [[9, 2.35], [11.3, 2.35]]);
  addRoad(output, "hillroad-link-a3", "", "hillroad", 0.012, [[28, 2.35], [28, 9]]);
  addRoad(output, "hillroad-governors-access", "", "hillroad", 0.012,
    route([11.3, 2.35], [10.8, 4.55]));
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

function addUptownSupportBuildings(roads: RoadIndex): void {
  const clusters = ["city-hall", "hospital", "library"];
  const occupiedFootprints: Array<{ position: XY; width: number; depth: number }> = [];
  const landmarkFootprints = buildingFeatures.filter((building) =>
    Number(building.properties?.base) === 0
    && ["landmark", "monument"].includes(String(building.properties?.kind)),
  ).map((building) => building.geometry.coordinates[0]!.map(localFromCoordinate) as Ring);
  const gridOffsets: XY[] = [];
  for (let y = -0.58; y <= 0.58; y += 0.052) {
    for (let x = -0.58; x <= 0.58; x += 0.052) gridOffsets.push([x, y]);
  }
  for (const id of clusters) {
    const place = pointById.get(id)!;
    const supportRing = localRect(place.position, 1.2, 1.2);
    if (!within(supportRing, districtById.get("uptown")!.ring)) throw new Error("Uptown support superblock is outside the district.");
    let created = 0;
    for (const [dx, dy] of gridOffsets) {
      if (created >= 150) break;
      const position: XY = [place.position[0] + dx, place.position[1] + dy];
      if (Math.hypot(dx, dy) > 0.6) continue;
      const width = 0.0251 + rand() * 0.0348;
      const depth = 0.0251 + rand() * 0.0348;
      if (Math.hypot(dx, dy) + Math.hypot(width / 2, depth / 2) > 0.6) continue;
      if (occupiedFootprints.some((previous) =>
        Math.abs(position[0] - previous.position[0]) < (width + previous.width) / 2 + 0.00025
        && Math.abs(position[1] - previous.position[1]) < (depth + previous.depth) / 2 + 0.00025,
      )) continue;
      const ring = localRect(position, width, depth);
      if (!within(ring, supportRing) || !within(ring, districtById.get("uptown")!.ring) || !footprintAllowed(ring, roads)) continue;
      if (landmarkFootprints.some((footprint) => !disjoint(ring, footprint))) continue;
      const blockId = `S-${id}-${String(created).padStart(3, "0")}`;
      blockFeatures.push(feature(polygonGeometry([ring]), { block_id: blockId, kind: "block", zone: "uptown" }));
      const top = 10 + Math.floor(rand() * 36);
      buildingSegments(position, width, depth, top, "uptown-support", blockId);
      occupiedFootprints.push({ position, width, depth });
      created += 1;
    }
    if (created < 150) throw new Error("Could not generate the required Uptown support-building cluster around " + id + ".");
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
      if (farmArea + area > reserveArea * 0.53) continue;
      const tone = Math.abs(Math.floor((center[0] * 17 + center[1] * 23) * 10)) % 4;
      surfaces.push(feature(polygonGeometry(polygon), { kind: "farm", tone }));
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

function addPortWarehouses(roads: RoadIndex): void {
  for (let index = 0; index < 16; index += 1) {
    const pier = Math.floor(index / 2);
    const y = 26.2 + pier * 0.55 + (index % 2 === 0 ? -0.13 : 0.13);
    let shoreX = 0;
    for (let pointIndex = 1; pointIndex < coastline.length; pointIndex += 1) {
      const a = coastline[pointIndex - 1]!;
      const b = coastline[pointIndex]!;
      if (y < Math.min(a[1], b[1]) || y > Math.max(a[1], b[1]) || Math.abs(a[1] - b[1]) < 1e-10) continue;
      const t = (y - a[1]) / (b[1] - a[1]);
      shoreX = a[0] + (b[0] - a[0]) * t;
      break;
    }
    const position: XY = [shoreX + 0.24 + (index % 2) * 0.21, y];
    const width = 0.07 + rand() * 0.045;
    const depth = 0.055 + rand() * 0.035;
    const ring = localRect(position, width, depth, -2);
    if (!within(ring, districtById.get("fleet-port")!.ring) || !footprintAllowed(ring, roads)) continue;
    const blockId = "P-" + String(index).padStart(2, "0");
    const block = addBlock(ring, "warehouse", "block");
    buildingSegments(position, width, depth, 10 + Math.floor(rand() * 16), "warehouse", block || blockId, -2);
  }
}

function addBeverlyVillas(roads: RoadIndex, roadDefinitions: readonly RoadDefinition[], woods: readonly Ring[]): void {
  const hillRoads = roadDefinitions.filter((road) => road.roadClass === "hillroad");
  const occupied = new Map<string, XY[]>();
  let created = 0;
  const target = 1500;
  for (const road of hillRoads) {
    for (let index = 1; index < road.coordinates.length && created < target; index += 1) {
      const start = road.coordinates[index - 1]!;
      const end = road.coordinates[index]!;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      const samples = Math.max(1, Math.ceil(length / 0.045));
      for (let sample = 0; sample < samples && created < target; sample += 1) {
        const t = sample / samples;
        const onRoad: XY = [start[0] + dx * t, start[1] + dy * t];
        for (const side of [-1, 1]) {
          const position: XY = [onRoad[0] - dy / (length || 1) * 0.065 * side, onRoad[1] + dx / (length || 1) * 0.065 * side];
          const width = 0.0122 + rand() * 0.0156;
          const depth = 0.0122 + rand() * 0.0156;
          const footprint = localRect(position, width, depth);
          const terrainSamples = [position, ...footprint.slice(0, -1)];
          if (!within(footprint, beverlyDistrict.ring)
            || terrainSamples.some((sample) => elevationAt(sample[0], sample[1]) > 240 || elevationSlope(sample[0], sample[1]) > 0.3)
            || woods.some((ring) => !disjoint(footprint, ring))
            || !footprintAllowed(footprint, roads, 0)) continue;
          const cellX = Math.floor(position[0] / 0.045);
          const cellY = Math.floor(position[1] / 0.045);
          let tooClose = false;
          for (let x = cellX - 2; x <= cellX + 2 && !tooClose; x += 1) {
            for (let y = cellY - 2; y <= cellY + 2 && !tooClose; y += 1) {
              for (const previous of occupied.get(`${x}:${y}`) ?? []) {
                if (Math.hypot(previous[0] - position[0], previous[1] - position[1]) < 0.038) tooClose = true;
              }
            }
          }
          if (tooClose) continue;
          const key = `${cellX}:${cellY}`;
          occupied.set(key, [...(occupied.get(key) ?? []), position]);
          const parcel = localRect(position, 0.035, 0.035);
          if (!within(parcel, beverlyDistrict.ring)) continue;
          const block = addBlock(parcel, "beverly", "block");
          buildingSegments(position, width, depth, 6 + Math.floor(rand() * 9), "villa", block);
          created += 1;
          if (created >= target) break;
        }
      }
    }
  }
  if (created < 1500 || created > 3000) throw new Error(`Beverly generated ${created} villas; expected 1,500-3,000.`);
}

function addReserveTownBuildings(towns: readonly TownArea[], roads: RoadIndex): void {
  for (const town of towns) {
    const block = `T-${town.id}`;
    blockFeatures.push(feature(polygonGeometry([town.ring]), {
      block_id: block, town_id: town.id, kind: "town", zone: "reserve",
    }));
    let created = 0;
    for (let row = -8; row <= 8 && created < 100; row += 1) {
      for (let column = -8; column <= 8 && created < 100; column += 1) {
        const candidate: XY = [town.center[0] + column * 0.045, town.center[1] + row * 0.045];
        const centerDistance = Math.hypot(town.center[0] - candidate[0], town.center[1] - candidate[1]);
        const inset = centerDistance === 0 ? 0 : 0.0015 / centerDistance;
        const position: XY = [
          candidate[0] + (town.center[0] - candidate[0]) * inset,
          candidate[1] + (town.center[1] - candidate[1]) * inset,
        ];
        const width = 0.0102 + rand() * 0.0146;
        const depth = 0.0102 + rand() * 0.0146;
        const footprint = localRect(position, width, depth);
        if (!within(footprint, town.ring) || !footprintAllowed(footprint, roads, 0)) continue;
        buildingSegments(position, width, depth, 5 + Math.floor(rand() * 8), "town-house", block);
        created += 1;
      }
    }
    if (created < 60 || created > 200) throw new Error(`Reserve town ${town.id} generated ${created} houses; expected 60-200.`);
  }
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

function generateMetro(roads: readonly RoadDefinition[]): { lines: Feature<LineString, Properties>[]; stationFeatures: Feature<Point, Properties>[] } {
  const routes = routeOnRoads(stations, transitLines, roads);
  const lineFeatures = transitLines.map(({ id, color, stations: stopIds }) => {
    const route = routes.get(id)!;
    return feature(lineGeometry(route), { id, name: id, color, stations: stopIds.join(",") });
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
  roadDefinitions: readonly RoadDefinition[],
  woods: readonly Ring[],
  towns: readonly TownArea[],
): void {
  generateManhattanBlocks(roads, coast);
  addUptownSupportBuildings(roads);
  addPortWarehouses(roads);
  addBeverlyVillas(roads, roadDefinitions, woods);
  addReserveTownBuildings(towns, roads);
  classifyBlocks();
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

export function generateData(): Record<string, Collection> {
  rand = rng(0x4d4f4e41);
  landRand = rng(0x4c414e44);
  buildingFeatures.length = 0;
  blockFeatures.length = 0;
  plazaExclusions.length = 0;
  roadExclusions.length = 0;
  nextBuildingId = 0;
  nextBlockId = 0;
  const generatedRoads = generateRoadNetwork();
  const towns = createTownAreas();
  addPlazaAndLandmarks();
  generateRegionalTexture(generatedRoads);
  generateBeverlyRoads(generatedRoads);
  generateRuralRoads(generatedRoads, towns);
  const clippedRoads = clipRoadsAroundLandmarks(generatedRoads, roadExclusions);
  const roadIndex = buildRoadIndex(clippedRoads);
  const coastIndex = buildRoadIndex([{ id: "coastal-setback", name: "", roadClass: "local", width: 0.06, coordinates: coastline }]);
  const woods = generateWoods(towns);
  const terrain = generateBeverlyTerrain();
  generateBlocksAndBuildings(roadIndex, coastIndex, clippedRoads, woods.rings, towns);
  const metro = generateMetro(clippedRoads);

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
  const terrainFeatures = [...terrain.bands, ...terrain.contours];
  const overviewFeatures = [...terrain.bands, ...woods.features];
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
    overview: collection(overviewFeatures),
    labels: collection(generateLabels()),
    boundaries: collection(boundaryFeatures),
    surface: collection(surfaceFeatures),
  };
}
