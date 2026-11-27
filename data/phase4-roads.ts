import { distanceToSegment, smoothSpline } from './geometry';
import { airportPosition } from './phase4-config';
import { roads, stations, transitLines, type RoadDefinition, type Ring, type XY } from './source';

function metroCurve(controls: readonly XY[], routeTangents: ReadonlyMap<string, XY>): XY[] {
  const result: XY[] = [controls[0]!];
  const bezier = (a: XY, b: XY, c: XY, d: XY): void => {
    for (let sample = 1; sample <= 24; sample++) {
      const t = sample / 24, u = 1 - t;
      result.push([u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0],
        u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]]);
    }
  };
  for (let i = 1; i < controls.length - 1; i++) {
    const a = controls[i - 1]!, b = controls[i]!, c = controls[i + 1]!;
    const before = Math.hypot(b[0] - a[0], b[1] - a[1]), after = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const u: XY = [(b[0] - a[0]) / before, (b[1] - a[1]) / before];
    const v: XY = [(c[0] - b[0]) / after, (c[1] - b[1]) / after];
    const sum = Math.hypot(u[0] + v[0], u[1] + v[1]);
    const tangent: XY = routeTangents.get(b.join(',')) ?? [(u[0] + v[0]) / sum, (u[1] + v[1]) / sum];
    const radius = Math.min(0.12, before * 0.25, after * 0.25);
    const start: XY = [b[0] - u[0] * radius, b[1] - u[1] * radius];
    const end: XY = [b[0] + v[0] * radius, b[1] + v[1] * radius];
    result.push(start);
    bezier(start, [start[0] + u[0] * radius * 0.5, start[1] + u[1] * radius * 0.5],
      [b[0] - tangent[0] * radius * 0.4, b[1] - tangent[1] * radius * 0.4], b);
    bezier(b, [b[0] + tangent[0] * radius * 0.4, b[1] + tangent[1] * radius * 0.4],
      [end[0] - v[0] * radius * 0.5, end[1] - v[1] * radius * 0.5], end);
  }
  result.push(controls.at(-1)!);
  return result;
}

export function regionalArterials(): RoadDefinition[] {
  const paths: Ring[] = [
    [[4, 8], [5.5, 11], [8, 19], [11, 25]],
    [[8, 13], [12, 13.8], [17, 15.7], [22, 18]],
    [[8, 21], [11, 23], [15, 23], [22, 21], [27.8, 16]],
    [[4, 13], [3, 19], [4.5, 24], [11, 25]],
    [[4, 8], [11, 10.5], [17, 12], [22, 13]],
    [[8, 21], [12.5, 19], [18, 18], [22, 18]],
    [[11, 25], [16, 24], [21, 23], [22, 21]],
    [[8, 13], [9.5, 8], [12, 5], [18.5, 2.2]],
    [[22, 21], [21, 17], [22, 13]],
    [[22, 13], [21, 10.5], [21, 6], [26.5, 2.2]],
  ];
  const definitions = paths.map((coordinates, index): RoadDefinition => ({ id: `radial-${index + 1}`, name: '', roadClass: 'arterial', width: 0.024, coordinates: smoothSpline(coordinates) }));
  definitions.push({ id: 'airport-access', name: '', roadClass: 'local', width: 0.022,
    coordinates: smoothSpline([[22, 13], [23, 12.8], airportPosition(-1.3, -0.3), airportPosition(-0.75, -0.3)]) });
  return definitions;
}

export function metroPaths(): Map<string, XY[]> {
  const stationById = new Map(stations.map((station) => [station.id, station.position]));
  return new Map(transitLines.map((line) => {
    const pieces: XY[] = [];
    const routeTangents = new Map<string, XY>();
    for (const route of Object.values(line.routes ?? {})) {
      const a = route[0]!, b = route.at(-1)!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length || route.some(p => distanceToSegment(p, a, b) > 1e-8)) continue;
      const tangent: XY = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      for (const p of [a, b]) routeTangents.set(p.join(','), tangent);
    }
    for (let index = 1; index < line.stations.length; index += 1) {
      const from = line.stations[index - 1]!, to = line.stations[index]!;
      const controls = line.routes?.[`${from}>${to}`] ?? [stationById.get(from)!, stationById.get(to)!];
      pieces.push(...controls.slice(index === 1 ? 0 : 1));
    }
    return [line.id, metroCurve(pieces, routeTangents)];
  }));
}

export function smoothMainRoads(): RoadDefinition[] {
  return roads.map((road) => ({ ...road, coordinates: smoothSpline(road.coordinates) }));
}
