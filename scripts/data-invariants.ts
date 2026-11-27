import { area, booleanWithin, intersect } from '@turf/turf';
import type { Feature, Polygon } from 'geojson';

export type XY = readonly [number, number];
export type Ring = readonly XY[];
export type Road = { coordinates: readonly XY[]; width: number };
export type Tier = { base: number; height: number };
type Properties = Record<string, string | number | boolean>;

function pointToSegment(point: XY, start: XY, end: XY): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared,
  ));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  const cross = (p: XY, q: XY, r: XY): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ab1 = cross(a, b, c);
  const ab2 = cross(a, b, d);
  const cd1 = cross(c, d, a);
  const cd2 = cross(c, d, b);
  const boxesOverlap = Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]))
    <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]))
    && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1]))
    <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
  if (boxesOverlap && ab1 * ab2 <= 0 && cd1 * cd2 <= 0) return 0;
  return Math.min(
    pointToSegment(a, c, d),
    pointToSegment(b, c, d),
    pointToSegment(c, a, b),
    pointToSegment(d, a, b),
  );
}

function pointInRing(point: XY, ring: Ring): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function assertAreaCoverage(actual: number, expected: number, tolerance = 0.001): void {
  if (!(expected > 0) || Math.abs(actual - expected) > expected * tolerance) {
    throw new Error("District union has a boundary gap or excess area.");
  }
}

export function assertRoadClearance(ring: Ring, roads: readonly Road[]): void {
  for (const road of roads) {
    const clearance = road.width / 2;
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const start = road.coordinates[index - 1]!;
      const end = road.coordinates[index]!;
      if (pointInRing(start, ring) || pointInRing(end, ring)) throw new Error("Building intersects a road corridor.");
      for (let edge = 1; edge < ring.length; edge += 1) {
        const a = ring[edge - 1]!;
        const b = ring[edge]!;
        if (segmentDistance(start, end, a, b) < clearance - 1e-7) {
          throw new Error("Building intersects a road corridor.");
        }
      }
    }
  }
}

export function assertTierContinuity(segments: readonly Tier[], expectedBase = 0): void {
  const ordered = [...segments].sort((a, b) => a.base - b.base);
  if (ordered.length === 0 || ordered[0]!.base !== expectedBase) throw new Error("Building tiers must start at the expected base.");
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (!Number.isFinite(current.base) || !Number.isFinite(current.height)) throw new Error("Building tiers must have finite bases and heights.");
    if (!(current.height > current.base)) throw new Error("Building tier has no positive height.");
    if (index > 0 && ordered[index - 1]!.height !== current.base) throw new Error("Building tiers must be contiguous.");
  }
}

export function assertFinalTierTop(segments: readonly Tier[], expectedTop: number): void {
  const ordered = [...segments].sort((a, b) => a.base - b.base);
  if (ordered.length === 0 || ordered[ordered.length - 1]!.height !== expectedTop) {
    throw new Error("Final building tier must reach the bid top.");
  }
}

export function polygonIntersectionArea(
  first: Feature<Polygon, Properties>,
  second: Feature<Polygon, Properties>,
): number {
  const overlap = intersect({ type: 'FeatureCollection', features: [first, second] });
  return overlap ? area(overlap) : 0;
}

export function assertNoPositiveAreaOverlap(
  first: Feature<Polygon, Properties>,
  second: Feature<Polygon, Properties>,
  context = 'Polygons must not overlap.',
  toleranceSquareMeters = 0.01,
): void {
  if (polygonIntersectionArea(first, second) > toleranceSquareMeters) throw new Error(context);
}

export function groupBuildingBidsWithinDistrict(
  buildings: readonly Feature<Polygon, Properties>[],
  district: Feature<Polygon, Properties>,
): Map<string, Feature<Polygon, Properties>[]> {
  const groups = new Map<string, Feature<Polygon, Properties>[]>();
  for (const building of buildings) {
    const bid = building.properties?.bid;
    if (typeof bid !== 'string') throw new Error('Building bid is required for district statistics.');
    groups.set(bid, [...(groups.get(bid) ?? []), building]);
  }

  const contained = new Map<string, Feature<Polygon, Properties>[]>();
  for (const [bid, segments] of groups) {
    const base = [...segments].sort((a, b) => Number(a.properties?.base) - Number(b.properties?.base))[0]!;
    if (booleanWithin(base, district)) contained.set(bid, segments);
  }
  return contained;
}

export function assertLabelCoverage(expectedIds: readonly string[], labelIds: readonly string[]): void {
  const expected = [...expectedIds].sort();
  const actual = [...labelIds].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error("Every mapped area must have exactly one label.");
  }
}
