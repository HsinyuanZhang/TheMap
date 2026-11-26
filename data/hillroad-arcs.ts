import { cleanRoundedPath } from './phase4-network';
import type { XY } from './source';

const distance = (a: XY, b: XY): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const turn = (a: XY, b: XY, c: XY): number => {
  const scale = distance(a, b) * distance(b, c);
  return scale ? Math.acos(Math.max(-1, Math.min(1,
    ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / scale))) * 180 / Math.PI : 0;
};

export function maximumRoadGrade(path: readonly XY[], elevation: (p: XY) => number): number {
  let maximum = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, length = distance(a, b);
    if (!length) continue;
    const count = Math.max(1, Math.ceil(length / 0.05));
    let previous = elevation(a);
    for (let j = 1; j <= count; j++) {
      const t = j / count, height = elevation([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      if (!Number.isFinite(height) || !Number.isFinite(previous)) throw new Error('Road elevation must be finite.');
      maximum = Math.max(maximum, Math.abs(height - previous) / (length * 1000 / count));
      previous = height;
    }
  }
  return maximum;
}

export function roundHillroadTurns(
  source: readonly XY[], elevation: (p: XY) => number, allowed: (p: XY) => boolean = () => true,
): XY[] {
  let path = cleanRoundedPath(source);
  const cut = (index: number, direction: -1 | 1, length: number): { point: XY; segment: number; tangent: XY } | undefined => {
    let current = path[index]!;
    for (let next = index + direction; next >= 0 && next < path.length; next += direction) {
      const end = path[next]!, edge = distance(current, end);
      if (edge >= length) {
        const t = length / edge;
        const tangent: XY = [(end[0] - current[0]) / edge * direction, (end[1] - current[1]) / edge * direction];
        return { point: [current[0] + (end[0] - current[0]) * t, current[1] + (end[1] - current[1]) * t],
          segment: direction === -1 ? next : next - 1, tangent };
      }
      length -= edge;
      current = end;
    }
    return undefined;
  };
  for (let i = 1; i < path.length - 1; i++) {
    if (turn(path[i - 1]!, path[i]!, path[i + 1]!) <= 12) continue;
    let replacement: XY[] | undefined, resume = i;
    for (const radius of [0.04, 0.06, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5, 0.75, 1, 1.5, 2]) {
      if (replacement) break;
      const before = cut(i, -1, radius), after = cut(i, 1, radius);
      if (!before || !after) continue;
      for (const handleScale of [0.4, 0.65, 1, 1.5, 2]) {
        const a = before.point, d = after.point, handle = radius * handleScale;
        const b: XY = [a[0] + before.tangent[0] * handle, a[1] + before.tangent[1] * handle];
        const c: XY = [d[0] - after.tangent[0] * handle, d[1] - after.tangent[1] * handle];
        const count = Math.max(32, Math.ceil((distance(a, b) + distance(b, c) + distance(c, d)) / 0.002));
        const curve = cleanRoundedPath(Array.from({ length: count + 1 }, (_, j): XY => {
          const t = j / count, u = 1 - t;
          return [u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0],
            u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]];
        }));
        if (!curve.every(allowed) || maximumRoadGrade(curve, elevation) > 0.08) continue;
        const prefix = path.slice(0, before.segment + 1), suffix = path.slice(after.segment + 1);
        const local = cleanRoundedPath([...prefix.slice(-2), ...curve, ...suffix.slice(0, 2)]);
        if (local.some((p, j) => j > 0 && j < local.length - 1 && turn(local[j - 1]!, p, local[j + 1]!) > 12)) continue;
        if (maximumRoadGrade(local, elevation) > 0.08) continue;
        replacement = cleanRoundedPath([...prefix, ...curve, ...suffix]);
        resume = Math.max(0, prefix.length - 1);
        break;
      }
    }
    if (replacement) { path = replacement; i = resume; }
  }
  return path;
}
