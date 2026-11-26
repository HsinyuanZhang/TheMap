import type { Ring, XY } from "./source";
export type { Ring, XY };

export function closeRing(points: readonly XY[]): Ring {
  if (points.length < 3) throw new Error("A polygon ring needs at least three points.");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return samePoint(first, last) ? [...points] : [...points, first];
}

export function samePoint(a: XY, b: XY, epsilon = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

export function reversePath(path: readonly XY[]): XY[] {
  return [...path].reverse();
}

export function stitchPaths(...paths: readonly (readonly XY[])[]): XY[] {
  const result: XY[] = [];
  for (const path of paths) {
    if (path.length < 2) throw new Error("A shared boundary path needs at least two points.");
    if (result.length > 0 && !samePoint(result[result.length - 1]!, path[0]!)) {
      throw new Error(`Shared boundary endpoints do not match: ${JSON.stringify(result[result.length - 1])} != ${JSON.stringify(path[0])}`);
    }
    result.push(...(result.length ? path.slice(1) : path));
  }
  return result;
}

export function curvedBoundary(start: XY, end: XY, amplitude: number, phase: number, count?: number): XY[] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  count ??= Math.max(6, Math.ceil(length / 0.15));
  if (length === 0 || !Number.isInteger(count) || count < 2) throw new Error('A boundary needs distinct endpoints and at least two vertices.');
  const nx = -dy / length;
  const ny = dx / length;
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const offset = amplitude * Math.sin(Math.PI * t) * Math.sin(2 * Math.PI * t + phase);
    return [start[0] + dx * t + nx * offset, start[1] + dy * t + ny * offset] as const;
  });
}

export function chaikinOpen(path: readonly XY[], iterations: number): XY[] {
  if (path.length < 2) throw new Error("An open coastline needs at least two points.");
  let result = [...path];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next: XY[] = [result[0]!];
    for (let index = 1; index < result.length; index += 1) {
      const a = result[index - 1]!;
      const b = result[index]!;
      next.push(
        [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
        [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
      );
    }
    next.push(result[result.length - 1]!);
    result = next;
  }
  return result;
}

export function smoothSpline(path: readonly XY[], step = 0.025): XY[] {
  if (path.length < 2) throw new Error('A spline needs at least two points.');
  if (!Number.isFinite(step) || step <= 0) throw new Error('Spline sampling step must be positive and finite.');
  const result: XY[] = [path[0]!];
  for (let index = 0; index < path.length - 1; index += 1) {
    const b = path[index]!, c = path[index + 1]!;
    const a = path[index - 1] ?? [2 * b[0] - c[0], 2 * b[1] - c[1]];
    const d = path[index + 2] ?? [2 * c[0] - b[0], 2 * c[1] - b[1]];
    const count = Math.max(16, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1]) / step));
    for (let sample = 1; sample <= count; sample += 1) {
      const t = sample / count, t2 = t * t, t3 = t2 * t;
      const interpolate = (axis: 0 | 1): number => 0.5 * (2 * b[axis] + (-a[axis] + c[axis]) * t
        + (2 * a[axis] - 5 * b[axis] + 4 * c[axis] - d[axis]) * t2
        + (-a[axis] + 3 * b[axis] - 3 * c[axis] + d[axis]) * t3);
      result.push([interpolate(0), interpolate(1)]);
    }
  }
  return result;
}

function splitPath(path: readonly XY[], axis: 0 | 1, value: number): [XY[], XY[]] {
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]!;
    const b = path[index]!;
    const av = a[axis];
    const bv = b[axis];
    if ((value - av) * (value - bv) > 0 || Math.abs(av - bv) < 1e-12) continue;
    const t = (value - av) / (bv - av);
    if (t < 0 || t > 1) continue;
    const cut: XY = axis === 0
      ? [value, a[1] + (b[1] - a[1]) * t]
      : [a[0] + (b[0] - a[0]) * t, value];
    return [[...path.slice(0, index), cut], [cut, ...path.slice(index)]];
  }
  throw new Error(`Path does not cross ${axis === 0 ? "x" : "y"}=${value}.`);
}

export const splitPathAtX = (path: readonly XY[], x: number): [XY[], XY[]] => splitPath(path, 0, x);
export const splitPathAtY = (path: readonly XY[], y: number): [XY[], XY[]] => splitPath(path, 1, y);

export function pointInRing(point: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, y] = point;
    const [xi, yi] = ring[index]!;
    const [xj, yj] = ring[previous]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(point: XY, start: XY, end: XY): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

export function rotate(point: XY, origin: XY, radians: number): XY {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point[0] - origin[0];
  const y = point[1] - origin[1];
  return [origin[0] + x * cosine - y * sine, origin[1] + x * sine + y * cosine];
}

export function rectangleRing(center: XY, width: number, depth: number, angle = 0, origin: XY = center): Ring {
  const [cx, cy] = center;
  const corners: XY[] = [
    [cx - width / 2, cy - depth / 2],
    [cx + width / 2, cy - depth / 2],
    [cx + width / 2, cy + depth / 2],
    [cx - width / 2, cy + depth / 2],
  ];
  const points = corners.map((point) => angle === 0 ? point : rotate(point, origin, angle));
  return closeRing(points);
}

export function ringsIntersect(a: readonly XY[], b: readonly XY[]): boolean {
  const segmentsIntersect = (p1: XY, p2: XY, q1: XY, q2: XY): boolean => {
    const orient = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);
    return o1 * o2 <= 1e-12 && o3 * o4 <= 1e-12;
  };
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      if (segmentsIntersect(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) return true;
    }
  }
  return pointInRing(a[0]!, b) || pointInRing(b[0]!, a);
}

export function polygonArea(ring: readonly XY[]): number {
  let twiceArea = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const [x1, y1] = ring[index - 1]!;
    const [x2, y2] = ring[index]!;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea / 2);
}
