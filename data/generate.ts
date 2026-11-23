import { booleanDisjoint, booleanWithin, lineIntersect, lineString, pointOnFeature } from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon, Position } from "geojson";
import {
  closeRing, distanceToSegment, pointInRing, rectangleRing, reversePath,
} from "./geometry";
import { routeOnRoads } from "./metro";
import {
  coastline, coastlineYAtX, districts, generatedBoundaries, land, parks, points,
  roads as sourceRoads, stations, transitLines, urbanGrid,
  type RoadDefinition, type Ring, type XY,
} from "./source";

type Properties = Record<string, string | number | boolean>;
type GeoFeature = Feature<Geometry, Properties>;
type Collection = FeatureCollection<Geometry, Properties>;

const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;
const coordinate = ([x, y]: XY): Position => [
  Number((-150 + x / longitudeScale).toFixed(6)),
  Number((40 + y / latitudeScale).toFixed(6)),
];

function polygonGeometry(rings: readonly Ring[]): Polygon {
  return { type: "Polygon", coordinates: rings.map((ring, index) => {
    const signedArea = ring.slice(1).reduce((sum, point, offset) => {
      const previous = ring[offset]!;
      return sum + previous[0] * point[1] - point[0] * previous[1];
    }, 0);
    const wantsPositive = index === 0;
    const oriented = (signedArea > 0) === wantsPositive ? ring : reversePath(ring);
    return oriented.map(coordinate);
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
const localPolygon = (ring: Ring): Feature<Polygon> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [ring.map(([x, y]) => [x, y])] },
});
const within = (ring: Ring, container: Ring): boolean => booleanWithin(localPolygon(ring), localPolygon(container));
const disjoint = (a: Ring, b: Ring): boolean => booleanDisjoint(localPolygon(a), localPolygon(b));
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
  output.push({ id, name, roadClass, width, coordinates });
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
  { center: [0.1, 0.3] as XY, peak: 300, sigma: 0.8, a: 0.45, k: 1 },
  { center: [4.6, 1.5] as XY, peak: 290, sigma: 1.5, a: 0.1, k: 3 },
  { center: [7.1, 5.4] as XY, peak: 250, sigma: 1, a: 0, k: 6 },
];

function distanceToPath(position: XY, coordinates: readonly XY[]): number {
  return Math.min(...coordinates.slice(1).map((next, index) => distanceToSegment(position, coordinates[index]!, next)));
}

const fifthRoad = sourceRoads.find((road) => road.id === "fifth-avenue")!;

function buildingHeight(position: XY): number {
  const u1 = rand();
  const u2 = rand();
  let height = 14 + 28 * u1;
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
  const segments = fixedTiers ?? (() => {
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

  let base = 0;
  for (const segment of segments) {
    const segmentBase = segment.base ?? base;
    const ring = localRect(position, segment.width, segment.depth, angle);
    const props: Properties = {
      bid, base: segmentBase, height: segment.top, top, kind, block_id: blockId,
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
  if (nearbyRoadSegments(ring, roads, extra).some((road) => polygonRoadIntrusion(ring, road, extra))) return false;
  return true;
}

function addBlock(ring: Ring, zone: string, kind = "block"): string {
  const blockId = "M" + String(nextBlockId++).padStart(5, "0");
  blockFeatures.push(feature(polygonGeometry([ring]), { block_id: blockId, kind, zone }));
  return blockId;
}

function generateBlockBuildings(
  ring: Ring,
  zone: string,
  width: number,
  depth: number,
  roads: RoadIndex,
  angle = 0,
  rows = 1,
): void {
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (zone === "grid" && (minX < 0.2 - 1e-7 || maxX > 9.2 + 1e-7 || minY < 3.55 - 1e-7 || maxY > 9.2 + 1e-7)) return;
  if (zone === "financial" && (maxX >= 2.55 || maxY >= 3.4)) return;
  if (zone === "reclamation" && (minX < 2.75 || maxY >= 3.4)) return;
  if (!within(ring, districtById.get("manhattan")!.ring)) return;
  if (parks.some((park) => !disjoint(ring, park.ring))) return;
  if (plazaExclusions.some((plaza) => !disjoint(ring, plaza))) return;
  if (!footprintAllowed(ring, roads)) return;
  const center = centerOf(ring);
  const blockId = addBlock(ring, zone);
  const alongWidth = width >= depth;
  const longEdge = alongWidth ? width : depth;
  const rowsCount = rows;
  const longSetback = 0.004;
  const edgeSetback = 0.004;
  const gap = 0.006;
  const rowDepth = ((alongWidth ? depth : width) - 2 * edgeSetback - (rowsCount - 1) * gap) / rowsCount;
  for (let row = 0; row < rowsCount; row += 1) {
    let offset = -longEdge / 2 + longSetback;
    const rowCenter = -((rowsCount - 1) * (rowDepth + gap)) / 2 + row * (rowDepth + gap);
    while (offset + 0.05 <= longEdge / 2 - longSetback + 1e-7) {
      const lotWidth = Math.min(0.05 + rand() * 0.04, longEdge / 2 - longSetback - offset);
      if (lotWidth < 0.05) break;
      const localX = offset + lotWidth / 2;
      const localY = rowCenter;
      const unrotatedCenter: XY = alongWidth ? [center[0] + localX, center[1] + localY] : [center[0] + localY, center[1] + localX];
      const radians = angle * Math.PI / 180;
      const dx = unrotatedCenter[0] - center[0];
      const dy = unrotatedCenter[1] - center[1];
      const position: XY = angle === 0 ? unrotatedCenter : [
        center[0] + dx * Math.cos(radians) - dy * Math.sin(radians),
        center[1] + dx * Math.sin(radians) + dy * Math.cos(radians),
      ];
      if (rand() >= 0.04) {
        const buildingWidth = alongWidth ? lotWidth : rowDepth;
        const buildingDepth = alongWidth ? rowDepth : lotWidth;
        const footprint = localRect(position, buildingWidth, buildingDepth, angle);
        if (footprintAllowed(footprint, roads, 0)) {
          const top = buildingHeight(position);
          buildingSegments(position, buildingWidth, buildingDepth, top, zone, blockId, angle);
        }
      }
      offset += lotWidth + gap;
    }
  }
}

function addPlazaAndLandmarks(): void {
  plazaExclusions.length = 0;
  roadExclusions.length = 0;
  const strait = pointById.get("strait-exchange")!;
  const continental = pointById.get("continental-tower")!;
  const straitOuter = localRect(strait.position, 0.2, 0.2);
  const straitHole = localRect(strait.position, 0.16, 0.11);
  plazaExclusions.push(straitOuter);
  roadExclusions.push(straitOuter);
  blockFeatures.push(feature(polygonGeometry([straitOuter, reversePath(straitHole)]), { kind: "plaza", zone: "manhattan" }));
  const towerOuter = localRect(continental.position, 0.2, 0.2);
  const towerHole = localRect(continental.position, 0.11, 0.11);
  plazaExclusions.push(towerOuter);
  roadExclusions.push(towerOuter);
  blockFeatures.push(feature(polygonGeometry([towerOuter, reversePath(towerHole)]), { kind: "plaza", zone: "manhattan" }));
  const timesSquare = pointById.get("times-square")!;
  const timesSquareRing = localRect(timesSquare.position, 0.15, 0.25);
  plazaExclusions.push(timesSquareRing);
  blockFeatures.push(feature(polygonGeometry([timesSquareRing]), { kind: "plaza", zone: "manhattan" }));

  const straitBlock = addBlock(straitHole, "landmark", "block");
  const towerBlock = addBlock(towerHole, "landmark", "block");
  const straitName = strait.name;
  buildingSegments(strait.position, 0.16, 0.11, 70, "landmark", straitBlock, 0, { id: strait.id, name: straitName }, [
    { top: 45, width: 0.16, depth: 0.11 },
    { base: 45, top: 70, width: 0.06, depth: 0.05 },
  ]);
  const continentalName = continental.name;
  buildingSegments(continental.position, 0.11, 0.11, 480, "landmark", towerBlock, 0, { id: continental.id, name: continentalName, color: "#b56b48" }, [
    { top: 55, width: 0.11, depth: 0.11 },
    { top: 290, width: 0.085, depth: 0.085 },
    { top: 400, width: 0.062, depth: 0.062 },
    { top: 450, width: 0.036, depth: 0.036 },
    { top: 480, width: 0.012, depth: 0.012 },
  ]);

  const exchange = pointById.get("exchange-square")!;
  const podiumCenter = exchange.position;
  const exchangeOuter = localRect(podiumCenter, 0.22, 0.22);
  const exchangeHole = localRect(podiumCenter, 0.19, 0.16);
  plazaExclusions.push(exchangeOuter);
  roadExclusions.push(exchangeOuter);
  blockFeatures.push(feature(polygonGeometry([exchangeOuter, reversePath(exchangeHole)]), { kind: "plaza", zone: "manhattan" }));
  const podiumRing = localRect(podiumCenter, 0.18, 0.12);
  const podiumBlock = addBlock(podiumRing, "landmark", "block");
  const podiumBid = buildingSegments(podiumCenter, 0.18, 0.12, 25, "landmark", podiumBlock, 0, { id: exchange.id, name: exchange.name }, [
    { top: 25, width: 0.18, depth: 0.12 },
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
}

function generateManhattanBlocks(roads: RoadIndex): void {
  const { grid, financial, reclamation } = urbanGrid;
  for (let x = grid.west; x + grid.blockWidth <= grid.east; x += grid.stepX) {
    for (let y = grid.south; y + grid.blockDepth <= 9.2; y += grid.stepY) {
      const ring = localRect([x + grid.blockWidth / 2, y + grid.blockDepth / 2], grid.blockWidth, grid.blockDepth);
      generateBlockBuildings(ring, "grid", grid.blockWidth, grid.blockDepth, roads, 0, 2);
    }
  }
  const financialAngle = financial.angleDegrees * Math.PI / 180;
  const origin: XY = [0.15, 0.75];
  for (let u = financial.bounds[0]; u + financial.blockWidth < financial.bounds[2]; u += financial.stepX) {
    for (let v = financial.bounds[1]; v + financial.blockDepth < financial.bounds[3]; v += financial.stepY) {
      const center: XY = [origin[0] + (u + financial.blockWidth / 2) * Math.cos(financialAngle) - (v + financial.blockDepth / 2) * Math.sin(financialAngle),
        origin[1] + (u + financial.blockWidth / 2) * Math.sin(financialAngle) + (v + financial.blockDepth / 2) * Math.cos(financialAngle)];
      const ring = localRect(center, financial.blockWidth, financial.blockDepth, financial.angleDegrees);
      generateBlockBuildings(ring, "financial", financial.blockWidth, financial.blockDepth, roads, financial.angleDegrees);
    }
  }
  for (let x = reclamation.bounds[0]; x + reclamation.blockWidth < reclamation.bounds[2]; x += reclamation.stepX) {
    for (let y = reclamation.bounds[1]; y + reclamation.blockDepth < reclamation.bounds[3]; y += reclamation.stepY) {
      const center: XY = [x + reclamation.blockWidth / 2, y + reclamation.blockDepth / 2];
      const ring = localRect(center, reclamation.blockWidth, reclamation.blockDepth, reclamation.angleDegrees, [reclamation.bounds[0], reclamation.bounds[1]]);
      generateBlockBuildings(ring, "reclamation", reclamation.blockWidth, reclamation.blockDepth, roads, reclamation.angleDegrees, 2);
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

function generateRegionalTexture(roads: RoadDefinition[]): void {
  for (const district of districts.filter((item) => item.id !== "manhattan" && item.id !== "fleet-port" && item.id !== "reserve")) {
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
    const xs: number[] = [bounds.west];
    const ys: number[] = [bounds.south];
    for (let x = bounds.west + step; x < bounds.east; x += step) xs.push(x);
    for (let y = bounds.south + step; y < bounds.north; y += step) ys.push(y);
    xs.push(bounds.east);
    ys.push(bounds.north);
    for (let x = 1; x < xs.length; x += 1) {
      for (let y = 1; y < ys.length; y += 1) {
        const ring = close([[xs[x - 1]!, ys[y - 1]!], [xs[x]!, ys[y - 1]!], [xs[x]!, ys[y]!], [xs[x - 1]!, ys[y]!]]);
        if (!within(ring, district.ring)) continue;
        blockFeatures.push(feature({ type: "Polygon", coordinates: [ring.map(coordinate)] }, { kind: "superblock", zone: district.id }));
      }
    }
  }
}

function addUptownSupportBuildings(roads: RoadIndex): void {
  const clusters = ["city-hall", "hospital", "library"];
  const gridOffsets: XY[] = [];
  for (let y = -0.58; y <= 0.58; y += 0.052) {
    for (let x = -0.58; x <= 0.58; x += 0.052) gridOffsets.push([x, y]);
  }
  for (const id of clusters) {
    const place = pointById.get(id)!;
    const blockId = "S-" + id;
    const supportRing = localRect(place.position, 1.2, 1.2);
    if (!within(supportRing, districtById.get("uptown")!.ring)) throw new Error("Uptown support superblock is outside the district.");
    blockFeatures.push(feature(polygonGeometry([supportRing]), { block_id: blockId, kind: "superblock", zone: "uptown" }));
    let created = 0;
    for (const [dx, dy] of gridOffsets) {
      if (created >= 150) break;
      const position: XY = [place.position[0] + dx, place.position[1] + dy];
      if (Math.hypot(dx, dy) > 0.6) continue;
      const width = 0.012 + rand() * 0.018;
      const depth = 0.012 + rand() * 0.018;
      const ring = localRect(position, width, depth);
      if (!within(ring, districtById.get("uptown")!.ring) || !footprintAllowed(ring, roads)) continue;
      const top = 10 + Math.floor(rand() * 36);
      buildingSegments(position, width, depth, top, "uptown-support", blockId);
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

function generateFarmAndPortSurfaces(): Feature<Polygon, Properties>[] {
  const surfaces: Feature<Polygon, Properties>[] = [];
  const reserve = districtById.get("reserve")!;
  const reserveBounds = {
    west: Math.min(...reserve.ring.map(([x]) => x)),
    east: Math.max(...reserve.ring.map(([x]) => x)),
    south: Math.min(...reserve.ring.map(([, y]) => y)),
    north: Math.max(...reserve.ring.map(([, y]) => y)),
  };
  const candidates: XY[] = [];
  for (let y = reserveBounds.south + 0.24; y < reserveBounds.north; y += 0.48) {
    for (let x = reserveBounds.west + 0.24; x < reserveBounds.east; x += 0.48) candidates.push([x, y]);
  }
  let farmCount = 0;
  for (const center of candidates) {
    if (farmCount >= 800) break;
    const width = 0.33 + rand() * 0.12;
    const depth = 0.33 + rand() * 0.12;
    const corners: Ring = close([
      [center[0] - width / 2, center[1] - depth / 2],
      [center[0] + width / 2, center[1] - depth / 2],
      [center[0] + width / 2, center[1] + depth / 2],
      [center[0] - width / 2, center[1] + depth / 2],
    ]);
    const jittered = corners.slice(0, -1).map(([x, y]) => [
      x + (rand() - 0.5) * 0.025,
      y + (rand() - 0.5) * 0.025,
    ] as const);
    const irregular = close(jittered);
    if (!within(irregular, reserve.ring)) continue;
    surfaces.push(feature(polygonGeometry([irregular]), { kind: "farm", palette: farmCount % 4 }));
    farmCount += 1;
  }
  if (farmCount < 600) throw new Error("Reserve farm candidate area only yielded " + farmCount + " farms.");

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
    const y = 26.3 + Math.floor(index / 4) * 0.55;
    let shoreX = 0;
    for (let pointIndex = 1; pointIndex < coastline.length; pointIndex += 1) {
      const a = coastline[pointIndex - 1]!;
      const b = coastline[pointIndex]!;
      if (y < Math.min(a[1], b[1]) || y > Math.max(a[1], b[1]) || Math.abs(a[1] - b[1]) < 1e-10) continue;
      const t = (y - a[1]) / (b[1] - a[1]);
      shoreX = a[0] + (b[0] - a[0]) * t;
      break;
    }
    const position: XY = [shoreX + 0.24 + (index % 4) * 0.34, y];
    const width = 0.07 + rand() * 0.045;
    const depth = 0.055 + rand() * 0.035;
    const ring = localRect(position, width, depth, -2);
    if (!within(ring, districtById.get("fleet-port")!.ring) || !footprintAllowed(ring, roads)) continue;
    const blockId = "P-" + String(index).padStart(2, "0");
    const block = addBlock(ring, "warehouse", "block");
    buildingSegments(position, width, depth, 10 + Math.floor(rand() * 16), "warehouse", block || blockId, -2);
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
  return areas.map(({ id, name, kind, priority, ring }) => {
    const local: Feature<Polygon> = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring.map(([x, y]) => [x, y])] } };
    const coordinates = pointOnFeature(local).geometry.coordinates;
    const position: XY = [coordinates[0]!, coordinates[1]!];
    return feature(pointGeometry(position), { id, name, kind, priority });
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

function generateSurfaces(): Feature<Polygon, Properties>[] {
  const surfaces = generateFarmAndPortSurfaces();
  const lake: Ring = close([[4.72, 6.08], [5.2, 6.08], [5.28, 6.52], [4.78, 6.58]]);
  surfaces.push(feature({ type: "Polygon", coordinates: [lake.map(coordinate)] }, { kind: "lake" }));
  return surfaces;
}

function generateBlocksAndBuildings(roads: RoadIndex): void {
  generateManhattanBlocks(roads);
  addUptownSupportBuildings(roads);
  addPortWarehouses(roads);
}

export function generateData(): Record<string, Collection> {
  rand = rng(0x4d4f4e41);
  buildingFeatures.length = 0;
  blockFeatures.length = 0;
  plazaExclusions.length = 0;
  roadExclusions.length = 0;
  nextBuildingId = 0;
  nextBlockId = 0;
  const generatedRoads = generateRoadNetwork();
  addPlazaAndLandmarks();
  generateRegionalTexture(generatedRoads);
  const clippedRoads = clipRoadsAroundLandmarks(generatedRoads, roadExclusions);
  generateBlocksAndBuildings(buildRoadIndex(clippedRoads));
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
  const roadFeatures = clippedRoads.map(({ id, name, roadClass, width, coordinates }) => feature(
    lineGeometry(coordinates), { id, name, class: roadClass, width },
  ));
  const poiFeatures = points.map(({ id, name, category, district, position }) => feature(
    pointGeometry(position), { id, name, category, district },
  ));
  const boundaryFeatures = generatedBoundaries.map(({ id, kind, coordinates }) => feature(
    lineGeometry(coordinates), { id, kind },
  ));
  const treeFeatures = generateTrees();
  const surfaceFeatures = generateSurfaces();
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
    labels: collection(generateLabels()),
    boundaries: collection(boundaryFeatures),
    surface: collection(surfaceFeatures),
  };
}
