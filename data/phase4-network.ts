import { distanceToSegment } from './geometry';
import type { RoadDefinition, XY } from './source';

const sx = 111.32 * Math.cos(40 * Math.PI / 180);
const sy = 110.574;
const rounded = ([x, y]: XY): XY => [
  (Number((-150 + x / sx).toFixed(6)) + 150) * sx,
  (Number((40 + y / sy).toFixed(6)) - 40) * sy,
];
const distance = (a: XY, b: XY): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const key = (p: XY): string => p.map(v => v.toFixed(7)).join(',');

export function cleanRoundedPath(path: readonly XY[], shared: readonly XY[] = []): XY[] {
  if (path.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new Error('Line coordinates must be finite.');
  const protectedKeys = new Set(shared.map(p => key(rounded(p))));
  const stack: XY[] = [];
  for (const p of path.map(rounded)) {
    if (stack.length && key(stack.at(-1)!) === key(p)) continue;
    if (stack.length > 1 && key(stack.at(-2)!) === key(p)) { stack.pop(); continue; }
    stack.push(p);
  }
  if (stack.length < 2) return stack;
  protectedKeys.add(key(stack[0]!));
  protectedKeys.add(key(stack.at(-1)!));
  const result: XY[] = [];
  for (const p of stack) {
    let skip = false;
    while (result.length && distance(result.at(-1)!, p) < 0.003) {
      if (!protectedKeys.has(key(p))) { skip = true; break; }
      if (protectedKeys.has(key(result.at(-1)!))) break;
      result.pop();
    }
    if (!skip) result.push(p);
  }
  return result;
}

export function cleanRoundedNetwork(roads: readonly RoadDefinition[]): RoadDefinition[] {
  const paths = roads.map(road => road.coordinates.map(rounded));
  const aliases = new Map<string, XY>();
  for (const path of paths) for (let i = 1; i < path.length - 1; i++) {
    if (key(path[i - 1]!) === key(path[i + 1]!) && distance(path[i - 1]!, path[i]!) < 0.003) {
      aliases.set(key(path[i]!), path[i - 1]!);
    }
  }
  const resolve = (p: XY): XY => {
    const seen = new Set<string>();
    while (aliases.has(key(p)) && !seen.has(key(p))) { seen.add(key(p)); p = aliases.get(key(p))!; }
    return p;
  };
  const neighbours = new Map<string, Set<string>>();
  const shared = new Map<string, XY>();
  for (let ri = 0; ri < paths.length; ri++) {
    paths[ri] = paths[ri]!.map(resolve).filter((p, i, all) => !i || key(p) !== key(all[i - 1]!));
    const path = paths[ri]!;
    if (!path.length) continue;
    shared.set(key(path[0]!), path[0]!);
    shared.set(key(path.at(-1)!), path.at(-1)!);
    for (let i = 0; i < path.length; i++) {
      const p = path[i]!, adjacent = neighbours.get(key(p)) ?? new Set<string>();
      for (const q of [path[i - 1], path[i + 1]]) if (q) adjacent.add(key(q));
      neighbours.set(key(p), adjacent);
    }
  }
  for (const path of paths) for (const p of path) if (neighbours.get(key(p))!.size > 2) shared.set(key(p), p);
  return roads.map((road, i) => ({ ...road, coordinates: cleanRoundedPath(paths[i]!, [...shared.values()]) }));
}

export function finalizeRoadNetwork(source: readonly RoadDefinition[]): RoadDefinition[] {
  let roads = cleanRoundedNetwork(source);
  const signature = (network: readonly RoadDefinition[]): string => JSON.stringify(network.map(r => [r.id, r.coordinates.map(key)]));
  const seen = new Set<string>();
  for (let pass = 0; pass < 16; pass++) {
    const before = signature(roads), noded = nodeRoads(roads), cleaned = cleanRoundedNetwork(noded);
    const after = signature(cleaned);
    if (before === signature(noded) && before === after) return cleaned;
    if (seen.has(after)) throw new Error('Rounded road intersections did not converge.');
    seen.add(after);
    roads = cleaned;
  }
  throw new Error('Rounded road intersections exceeded the convergence limit.');
}

function thinPath(path: readonly XY[], tolerance: number): XY[] {
  if (path.length < 3) return [...path];
  let farthest = 0, index = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const d = distanceToSegment(path[i]!, path[0]!, path.at(-1)!);
    if (d > farthest) { farthest = d; index = i; }
  }
  if (farthest <= tolerance) return [path[0]!, path.at(-1)!];
  return [...thinPath(path.slice(0, index + 1), tolerance).slice(0, -1), ...thinPath(path.slice(index), tolerance)];
}

export function roundedCorners(path: readonly XY[], radius = 0.08): XY[] {
  const points = path.filter((p, i) => !i || distance(p, path[i - 1]!) > 0.0002);
  if (points.length < 3) return points;
  const result: XY[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const before = distance(a, b), after = distance(b, c);
    const d = Math.min(radius, before * 0.45, after * 0.45);
    const start: XY = [b[0] + (a[0] - b[0]) * d / before, b[1] + (a[1] - b[1]) * d / before];
    const end: XY = [b[0] + (c[0] - b[0]) * d / after, b[1] + (c[1] - b[1]) * d / after];
    const cosine = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / before / after;
    if (cosine > Math.cos(5 * Math.PI / 180)) { result.push(b); continue; }
    const samples = Math.max(16, Math.ceil(Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI / 2));
    for (let sample = 0; sample <= samples; sample++) {
      const t = sample / samples, u = 1 - t;
      result.push([u * u * start[0] + 2 * u * t * b[0] + t * t * end[0],
        u * u * start[1] + 2 * u * t * b[1] + t * t * end[1]]);
    }
  }
  result.push(points.at(-1)!);
  return result;
}

export function prepareRoadNetwork(source: readonly RoadDefinition[]): RoadDefinition[] {
  const roads = source.map(road => ({ ...road, coordinates: road.roadClass === 'street' || road.roadClass === 'hillroad' || road.id.startsWith('metro-corridor-')
    ? [...road.coordinates] : roundedCorners(thinPath(road.coordinates, 0.005), 0.15) }));
  const mains = roads.filter(r => ['motorway', 'arterial'].includes(r.roadClass));
  for (const road of roads.filter(r => r.roadClass !== 'street' && r.roadClass !== 'motorway')) {
    for (const atStart of [true, false]) {
      if (road.id === 'airport-access' && !atStart) continue;
      const end = atStart ? road.coordinates[0]! : road.coordinates.at(-1)!;
      let best = Infinity, target: XY | undefined, owner: typeof road | undefined, segment = 0;
      const candidates = road.roadClass === 'arterial' ? roads.filter(r => r.roadClass !== 'street') : mains;
      for (const other of candidates) {
        if (other === road) continue;
        for (let i = 1; i < other.coordinates.length; i++) {
          const a = other.coordinates[i - 1]!, b = other.coordinates[i]!;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((end[0] - a[0]) * dx + (end[1] - a[1]) * dy) / (dx * dx + dy * dy)));
          const p: XY = [a[0] + dx * t, a[1] + dy * t];
          const d = distance(end, p);
          if (d < best) { best = d; target = p; owner = other; segment = i; }
        }
      }
      if (!target || !owner) continue;
      if (road.roadClass !== 'arterial' && best > 0.01) continue;
      if (road.roadClass === 'hillroad' && best > 0.001) continue;
      const p = rounded(target);
      owner.coordinates.splice(segment, 0, p);
      if (best < 0.0002) road.coordinates[atStart ? 0 : road.coordinates.length - 1] = p;
      else {
        const path = atStart ? [...road.coordinates].reverse() : [...road.coordinates];
        let remaining = Math.max(0.15, best * 1.25);
        while (path.length > 1 && remaining > 0) {
          const end = path.pop()!, before = path.at(-1)!, length = distance(before, end);
          if (length > remaining) {
            path.push([end[0] + (before[0] - end[0]) * remaining / length, end[1] + (before[1] - end[1]) * remaining / length]);
            break;
          }
          remaining -= length;
        }
        path.push(p);
        road.coordinates = atStart ? roundedCorners(path, 0.15).reverse() : roundedCorners(path, 0.15);
      }
    }
  }
  return roads;
}

export function nodeRoads(roads: readonly RoadDefinition[]): RoadDefinition[] {
  const streets = roads.filter(r => r.roadClass === 'street');
  roads = roads.filter(r => r.roadClass !== 'street');
  const paths = roads.map(r => r.coordinates.map(rounded).filter((p, i, all) => !i || key(p) !== key(all[i - 1]!)));
  const cuts = paths.map(path => path.slice(1).map(() => [] as XY[]));
  const buckets = new Map<string, Array<{ road: number; segment: number; a: XY; b: XY }>>();
  const visited = new Set<string>();
  for (const [road, path] of paths.entries()) for (let segment = 1; segment < path.length; segment++) {
    const a = path[segment - 1]!, b = path[segment]!;
    const entry = { road, segment, a, b };
    const candidates = new Set<{ road: number; segment: number; a: XY; b: XY }>();
    const cells: string[] = [];
    for (let x = Math.floor(Math.min(a[0], b[0]) * 10); x <= Math.floor(Math.max(a[0], b[0]) * 10); x++) {
      for (let y = Math.floor(Math.min(a[1], b[1]) * 10); y <= Math.floor(Math.max(a[1], b[1]) * 10); y++) {
        const cell = `${x},${y}`; cells.push(cell);
        for (const item of buckets.get(cell) ?? []) candidates.add(item);
      }
    }
    for (const other of candidates) {
      if (other.road === road) continue;
      const pair = `${other.road}:${other.segment}/${road}:${segment}`;
      if (visited.has(pair)) continue;
      visited.add(pair);
      const c = other.a, d = other.b;
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - c[0], vy = d[1] - c[1];
      const denominator = ux * vy - uy * vx;
      if (Math.abs(denominator) < 1e-12) {
        for (const p of [a, b]) if (distanceToSegment(p, c, d) < 1e-7) cuts[other.road]![other.segment - 1]!.push(p);
        for (const p of [c, d]) if (distanceToSegment(p, a, b) < 1e-7) cuts[road]![segment - 1]!.push(p);
        continue;
      }
      const t = ((c[0] - a[0]) * vy - (c[1] - a[1]) * vx) / denominator;
      const u = ((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) / denominator;
      if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
      const p = rounded([a[0] + ux * t, a[1] + uy * t]);
      cuts[road]![segment - 1]!.push(p);
      cuts[other.road]![other.segment - 1]!.push(p);
    }
    for (const cell of cells) buckets.set(cell, [...(buckets.get(cell) ?? []), entry]);
  }
  const canonical = new Map<string, XY[]>();
  const snap = (p: XY, insert = false): XY => {
    const x = Math.floor(p[0] * 1000), y = Math.floor(p[1] * 1000);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of canonical.get(`${x + dx},${y + dy}`) ?? []) if (distance(p, q) < 0.0005) return q;
    }
    if (insert) canonical.set(`${x},${y}`, [...(canonical.get(`${x},${y}`) ?? []), p]);
    return p;
  };
  for (const road of cuts) for (const segment of road) for (let i = 0; i < segment.length; i++) segment[i] = snap(segment[i]!, true);
  for (const path of paths) for (let i = 0; i < path.length; i++) path[i] = snap(path[i]!);
  const junctions = new Set(cuts.flat(2).map(key));
  return [...streets, ...roads.map((road, ri) => {
    const path = paths[ri]!, out: XY[] = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      const sorted = [a, ...cuts[ri]![i - 1]!, b].sort((p, q) =>
        ((p[0] - q[0]) * (b[0] - a[0]) + (p[1] - q[1]) * (b[1] - a[1])));
      for (const p of sorted) {
        const previous = out.at(-1);
        if (previous && key(previous) === key(p)) continue;
        if (previous && distance(previous, p) < 0.0015) {
          if (!junctions.has(key(p))) continue;
          if (!junctions.has(key(previous))) out.pop();
        }
        out.push(p);
      }
    }
    return { ...road, coordinates: out };
  })];
}
