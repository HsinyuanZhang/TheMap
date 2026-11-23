import type { XY, RoadDefinition, StationDefinition, TransitLineDefinition } from "./source";

interface Segment {
  start: XY;
  end: XY;
  cuts: { t: number; point: XY }[];
}

interface Edge {
  node: number;
  distance: number;
}

const cross = (a: XY, b: XY): number => a[0] * b[1] - a[1] * b[0];
const subtract = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];

function pointToSegment(point: XY, start: XY, end: XY): { distance: number; t: number } {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  const projected: XY = [start[0] + dx * t, start[1] + dy * t];
  return { distance: Math.hypot(point[0] - projected[0], point[1] - projected[1]), t };
}

function segmentCrossing(a: XY, b: XY, c: XY, d: XY): { t: number; u: number; point: XY } | undefined {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-10) return undefined;
  const delta = subtract(c, a);
  const t = cross(delta, s) / denominator;
  const u = cross(delta, r) / denominator;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return undefined;
  const boundedT = Math.max(0, Math.min(1, t));
  return { t: boundedT, u: Math.max(0, Math.min(1, u)), point: [a[0] + r[0] * boundedT, a[1] + r[1] * boundedT] };
}

function nearestNode(position: XY, nodes: XY[]): number {
  let best = -1;
  let distance = Infinity;
  for (let index = 0; index < nodes.length; index += 1) {
    const candidate = nodes[index]!;
    const current = Math.hypot(candidate[0] - position[0], candidate[1] - position[1]);
    if (current < distance) {
      distance = current;
      best = index;
    }
  }
  if (distance > 0.005) throw new Error(`Station at ${position.join(",")} is ${(distance * 1000).toFixed(1)} m from the road network.`);
  return best;
}

class MinHeap {
  private readonly values: { key: number; node: number }[] = [];
  get size(): number {
    return this.values.length;
  }

  push(value: { key: number; node: number }): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.key <= value.key) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }
  pop(): { key: number; node: number } | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right]!.key < this.values[left]!.key ? right : left;
      if (this.values[child]!.key >= last.key) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function shortestPath(adjacency: Edge[][], nodes: XY[], start: number, finish: number): XY[] {
  const distances = new Array(nodes.length).fill(Infinity) as number[];
  const previous = new Array(nodes.length).fill(-1) as number[];
  const heap = new MinHeap();
  distances[start] = 0;
  heap.push({ key: 0, node: start });
  while (heap.size > 0) {
    const current = heap.pop()!;
    if (current.key !== distances[current.node]) continue;
    if (current.node === finish) break;
    for (const edge of adjacency[current.node]!) {
      const distance = current.key + edge.distance;
      if (distance >= distances[edge.node]!) continue;
      distances[edge.node] = distance;
      previous[edge.node] = current.node;
      heap.push({ key: distance, node: edge.node });
    }
  }
  if (!Number.isFinite(distances[finish]!)) throw new Error("Transit stations are disconnected by the generated road network.");
  const route: XY[] = [];
  for (let node = finish; node !== -1; node = previous[node]!) {
    route.push(nodes[node]!);
    if (node === start) break;
  }
  if (route[route.length - 1] !== nodes[start]) throw new Error("Could not reconstruct a transit road path.");
  return route.reverse();
}

export function routeOnRoads(
  stations: readonly StationDefinition[],
  lines: readonly TransitLineDefinition[],
  roads: readonly RoadDefinition[],
): Map<string, XY[]> {
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const segments: Segment[] = [];
  for (const road of roads) {
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const start = road.coordinates[index - 1]!;
      const end = road.coordinates[index]!;
      segments.push({ start, end, cuts: [{ t: 0, point: start }, { t: 1, point: end }] });
    }
  }
  const cellSize = 0.25;
  const cellKey = (x: number, y: number) => x + ":" + y;
  const cellsFor = (segment: Segment): string[] => {
    const minX = Math.floor(Math.min(segment.start[0], segment.end[0]) / cellSize);
    const maxX = Math.floor(Math.max(segment.start[0], segment.end[0]) / cellSize);
    const minY = Math.floor(Math.min(segment.start[1], segment.end[1]) / cellSize);
    const maxY = Math.floor(Math.max(segment.start[1], segment.end[1]) / cellSize);
    const cells: string[] = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) cells.push(cellKey(x, y));
    }
    return cells;
  };
  const segmentIndex = new Map<string, number[]>();
  for (let first = 0; first < segments.length; first += 1) {
    const a = segments[first]!;
    const cells = cellsFor(a);
    const candidates = new Set<number>();
    for (const cell of cells) {
      for (const second of segmentIndex.get(cell) ?? []) candidates.add(second);
    }
    for (const second of candidates) {
      const b = segments[second]!;
      const crossing = segmentCrossing(a.start, a.end, b.start, b.end);
      if (!crossing) continue;
      a.cuts.push({ t: crossing.t, point: crossing.point });
      b.cuts.push({ t: crossing.u, point: crossing.point });
    }
    for (const cell of cells) {
      const bucket = segmentIndex.get(cell) ?? [];
      bucket.push(first);
      segmentIndex.set(cell, bucket);
    }
  }
  const attachPoint = (position: XY, description: string): void => {
    const centerX = Math.floor(position[0] / cellSize);
    const centerY = Math.floor(position[1] / cellSize);
    const candidates = new Set<number>();
    for (let x = centerX - 1; x <= centerX + 1; x += 1) {
      for (let y = centerY - 1; y <= centerY + 1; y += 1) {
        for (const segmentId of segmentIndex.get(cellKey(x, y)) ?? []) candidates.add(segmentId);
      }
    }
    let attached = false;
    for (const index of candidates) {
      const segment = segments[index]!;
      const projection = pointToSegment(position, segment.start, segment.end);
      if (projection.distance > 0.005) continue;
      segment.cuts.push({ t: projection.t, point: position });
      attached = true;
    }
    if (!attached) throw new Error(description + " at " + position.join(",") + " is not on a road centerline.");
  };
  for (const station of stations.filter((item) => item.district === "曼哈顿区")) attachPoint(station.position, "Station");
  const routeAnchors: XY[] = [[5.908, 9.2], [9.25, 3.45]];
  for (const anchor of routeAnchors) attachPoint(anchor, "Manhattan route exit");
  const nodes: XY[] = [];
  const nodeByKey = new Map<string, number>();
  const getNode = (point: XY): number => {
    const key = `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
    const found = nodeByKey.get(key);
    if (found !== undefined) return found;
    const id = nodes.length;
    nodes.push([Number(point[0].toFixed(6)), Number(point[1].toFixed(6))]);
    nodeByKey.set(key, id);
    return id;
  };
  const adjacency: Edge[][] = [];
  const connect = (first: number, second: number, distance: number): void => {
    if (!adjacency[first]) adjacency[first] = [];
    if (!adjacency[second]) adjacency[second] = [];
    adjacency[first]!.push({ node: second, distance });
    adjacency[second]!.push({ node: first, distance });
  };
  for (const segment of segments) {
    const cuts = segment.cuts
      .sort((a, b) => a.t - b.t)
      .filter((cut, index, array) => index === 0 || Math.abs(cut.t - array[index - 1]!.t) > 1e-8);
    for (let index = 1; index < cuts.length; index += 1) {
      const a = cuts[index - 1]!.point;
      const b = cuts[index]!.point;
      const first = getNode(a);
      const second = getNode(b);
      if (first !== second) connect(first, second, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
  }
  for (const station of stations.filter((item) => item.district === "曼哈顿区")) nearestNode(station.position, nodes);

  const pathBetween = (start: XY, finish: XY): XY[] =>
    shortestPath(adjacency, nodes, nearestNode(start, nodes), nearestNode(finish, nodes));
  const curvedRegionalPath = (start: XY, finish: XY): XY[] => {
    const dx = finish[0] - start[0];
    const dy = finish[1] - start[1];
    const length = Math.hypot(dx, dy) || 1;
    const offset = Math.min(0.6, length * 0.08);
    const normal: XY = [-dy / length, dx / length];
    return [
      start,
      [start[0] + dx / 3 + normal[0] * offset, start[1] + dy / 3 + normal[1] * offset],
      [start[0] + dx * 2 / 3 + normal[0] * offset, start[1] + dy * 2 / 3 + normal[1] * offset],
      finish,
    ];
  };
  const manhattanExit = (outside: XY): XY => outside[1] > 9 ? routeAnchors[0]! : routeAnchors[1]!;
  const result = new Map<string, XY[]>();
  for (const line of lines) {
    const route: XY[] = [];
    for (let index = 1; index < line.stations.length; index += 1) {
      const previous = stationById.get(line.stations[index - 1]!);
      const next = stationById.get(line.stations[index]!);
      if (!previous || !next) throw new Error(`${line.id} references an unknown station.`);
      let segment: XY[];
      if (line.id === "U1" && previous.id === "station-strait-exchange" && next.id === "station-times-square") {
        const broadway = roads.find((road) => road.id === "broadway")!;
        const endIndex = broadway.coordinates.findIndex((point) =>
          Math.hypot(point[0] - next.position[0], point[1] - next.position[1]) < 0.001,
        );
        if (endIndex < 1) throw new Error("Broadway does not reach the Times Square station.");
        segment = [...pathBetween(previous.position, broadway.coordinates[0]!), ...broadway.coordinates.slice(1, endIndex + 1)];
      } else if ((line.id === "U1" && previous.id === "station-times-square" && next.id === "station-central-park")
        || (line.id === "U2" && previous.id === "station-continental-tower" && next.id === "station-exchange-square")) {
        segment = [previous.position, next.position];
      } else if (previous.district === "曼哈顿区" && next.district === "曼哈顿区") {
        segment = pathBetween(previous.position, next.position);
      } else if (previous.district === "曼哈顿区") {
        const exit = manhattanExit(next.position);
        segment = [...pathBetween(previous.position, exit), ...curvedRegionalPath(exit, next.position).slice(1)];
      } else if (next.district === "曼哈顿区") {
        const exit = manhattanExit(previous.position);
        segment = [...curvedRegionalPath(previous.position, exit), ...pathBetween(exit, next.position).slice(1)];
      } else {
        segment = curvedRegionalPath(previous.position, next.position);
      }
      route.push(...(route.length ? segment.slice(1) : segment));
    }
    if (route.length < 2) throw new Error(`${line.id} road path is empty.`);
    result.set(line.id, route);
  }
  return result;
}
