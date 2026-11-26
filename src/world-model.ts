import type { Geometry, Position } from 'geojson';
import type { Dataset, MapDatasets } from './dataset-loader';
import { beverlyHeight, smooth } from './terrain-elevation';
import { centralTerrain } from '../data/phase4-config';

export type XY = readonly [number, number];
export type Surface = 'sea' | 'wood' | 'farm' | 'lowdensity' | 'lowrise' | 'midrise' | 'highrise' | 'town' | 'park' | 'military' | 'airport' | 'foreign' | 'lake' | 'pier';
export const KM_X = 111.32 * Math.cos(40 * Math.PI / 180), KM_Y = 110.574;
export const toKm = (p: Position): XY => [(p[0] + 150) * KM_X, (p[1] - 40) * KM_Y];
export const toLngLat = (p: XY): [number, number] => [-150 + p[0] / KM_X, 40 + p[1] / KM_Y];
export function worldHash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 0x45d9f3b) ^ Math.imul(y | 0, 0x27d4eb2d) ^ Math.imul(salt, 0x165667b1);
  h = Math.imul(h ^ h >>> 16, 0x7feb352d);
  h = Math.imul(h ^ h >>> 15, 0x846ca68b);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
export function noise(x: number, y: number): number {
  const i = Math.floor(x), j = Math.floor(y), u = smooth(x - i), v = smooth(y - j);
  const a = worldHash(i, j) * (1 - u) + worldHash(i + 1, j) * u;
  const b = worldHash(i, j + 1) * (1 - u) + worldHash(i + 1, j + 1) * u;
  return a * (1 - v) + b * v;
}
interface Shape { rings: XY[][]; properties: Record<string, string | number | boolean>; id: number; }
interface Segment { a: XY; b: XY; width: number; }
export class SpatialIndex<T> {
  private readonly cells = new Map<string, T[]>();
  constructor(private readonly size: number) {}
  insert(item: T, west: number, south: number, east: number, north: number): void {
    for (let x = Math.floor(west / this.size); x <= Math.floor(east / this.size); x++) {
      for (let y = Math.floor(south / this.size); y <= Math.floor(north / this.size); y++) {
        const key = x + ',' + y, cell = this.cells.get(key);
        if (cell) cell.push(item); else this.cells.set(key, [item]);
      }
    }
  }
  at(x: number, y: number): readonly T[] { return this.cells.get(Math.floor(x / this.size) + ',' + Math.floor(y / this.size)) ?? []; }
}
export function inRing(x: number, y: number, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const contains = (s: Shape, x: number, y: number): boolean => inRing(x, y, s.rings[0]) && !s.rings.slice(1).some(r => inRing(x, y, r));
function shapes(data: Dataset): Shape[] {
  return data.features.flatMap((f, id) => {
    const g = f.geometry;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return [];
    return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(rings => ({ rings: rings.map(r => r.map(toKm)), properties: f.properties, id }));
  });
}
function indexShapes(data: Dataset, size: number): SpatialIndex<Shape> {
  const index = new SpatialIndex<Shape>(size);
  for (const shape of shapes(data)) {
    const points = shape.rings[0];
    index.insert(shape, Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1])));
  }
  return index;
}
export function segmentDistance(x: number, y: number, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}
function paths(g: Geometry): XY[][] {
  return g.type === 'LineString' ? [g.coordinates.map(toKm)] : g.type === 'MultiLineString' ? g.coordinates.map(r => r.map(toKm)) : [];
}
export interface WorldSample { district: string; surface: Surface; elevation: number; angle: number; quarter: number; tone: number; field: number; fieldEdge: number; part: string; }
export class WorldModel {
  readonly bounds: readonly [number, number, number, number];
  readonly airportBuildings: readonly Shape[];
  private readonly land;
  private readonly districts;
  private readonly surfaces;
  private readonly parks;
  private readonly blocks;
  private readonly terrain;
  private readonly coast = new SpatialIndex<Segment>(1);
  private readonly roads = new SpatialIndex<Segment>(0.5);
  constructor(data: MapDatasets) {
    const vertices = shapes(data.districts).flatMap(s => s.rings[0]);
    this.bounds = vertices.length ? [Math.min(...vertices.map(p => p[0])), Math.min(...vertices.map(p => p[1])), Math.max(...vertices.map(p => p[0])), Math.max(...vertices.map(p => p[1]))] : [0, 0, 0, 0];
    this.land = indexShapes(data.land, 4); this.districts = indexShapes(data.districts, 2);
    this.surfaces = indexShapes(data.surface, 0.5); this.parks = indexShapes(data.parks, 1);
    this.blocks = indexShapes(data.blocks, 0.5); this.terrain = indexShapes(data.terrain, 1);
    this.airportBuildings = shapes(data.blocks).filter(s => s.properties.zone === 'harlem' && s.rings[0].every(p => this.surfaces.at(p[0], p[1]).some(a => a.properties.kind === 'airport' && contains(a, p[0], p[1]))));
    for (const f of data.boundaries.features.filter(f => f.properties.kind === 'coastline')) for (const path of paths(f.geometry)) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        this.coast.insert({ a, b, width: 0 }, Math.min(a[0], b[0]) - 5, Math.min(a[1], b[1]) - 5, Math.max(a[0], b[0]) + 5, Math.max(a[1], b[1]) + 5);
      }
    }
    for (const land of shapes(data.land)) for (const ring of land.rings) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2, dx = (b[1] - a[1]) / length * 0.01, dy = (a[0] - b[0]) / length * 0.01;
      if (this.districtAt(x + dx, y + dy) !== 'sea' && this.districtAt(x - dx, y - dy) !== 'sea') continue;
      this.coast.insert({ a, b, width: 0 }, Math.min(a[0], b[0]) - 5, Math.min(a[1], b[1]) - 5, Math.max(a[0], b[0]) + 5, Math.max(a[1], b[1]) + 5);
    }
    for (const f of data.roads.features.filter(f => f.properties.class !== 'street')) for (const path of paths(f.geometry)) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], width = Number(f.properties.width) / 2 + 0.065;
        this.roads.insert({ a, b, width }, Math.min(a[0], b[0]) - width, Math.min(a[1], b[1]) - width, Math.max(a[0], b[0]) + width, Math.max(a[1], b[1]) + width);
      }
    }
  }
  districtAt(x: number, y: number): string {
    const d = this.districts.at(x, y).find(s => contains(s, x, y));
    if (d) return String(d.properties.id);
    return String(this.land.at(x, y).find(s => contains(s, x, y))?.properties.kind ?? 'sea');
  }
  coastDistance(x: number, y: number): number {
    let d = 5;
    for (const s of this.coast.at(x, y)) d = Math.min(d, segmentDistance(x, y, s.a, s.b));
    return d;
  }
  roadClear(x: number, y: number, extra = 0): boolean {
    return this.roads.at(x, y).every(s => segmentDistance(x, y, s.a, s.b) > s.width + extra);
  }
  quarterAt(x: number, y: number, district = this.districtAt(x, y)): { angle: number; id: number } {
    let distance = Infinity, qi = 0, qj = 0;
    const cx = Math.floor(x / 2), cy = Math.floor(y / 2);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) {
      const dx = x - (i + 0.2 + 0.6 * worldHash(i, j, 1)) * 2, dy = y - (j + 0.2 + 0.6 * worldHash(i, j, 2)) * 2;
      if (dx * dx + dy * dy < distance) { distance = dx * dx + dy * dy; qi = i; qj = j; }
    }
    const id = worldHash(qi, qj, 3);
    const degrees = district === 'central' ? centralTerrain.angleDegrees : district === 'manhattan' ? (y >= 3.55 ? 0 : x < 2.75 ? 24 : 2) : (id - 0.5) * 75;
    return { angle: degrees * Math.PI / 180, id };
  }
  elevationAt(x: number, y: number, district = this.districtAt(x, y)): number {
    if (district === 'beverly') return beverlyHeight(x, y);
    if (district === 'reserve') return 8 + 70 * noise(x * 0.18, y * 0.18);
    const relief = (): number => noise(x * 0.18 + 6, y * 0.18) * 0.4 + noise(x * 0.45, y * 0.45) * 0.3 + noise(x * 1.1, y * 1.1) * 0.2 + noise(x * 2.2, y * 2.2) * 0.1;
    if (district === 'ottoman') return 40 + 560 * Math.pow(relief(), 1.1);
    if (district === 'east-region') return 40 + 330 * relief();
    if (district === 'sea') return 0;
    return Math.max(4, ...this.terrain.at(x, y).filter(s => contains(s, x, y)).map(s => Number(s.properties.level)));
  }
  sample(x: number, y: number): WorldSample {
    const district = this.districtAt(x, y), q = this.quarterAt(x, y, district);
    const matches = this.surfaces.at(x, y).filter(s => contains(s, x, y));
    const kinds = matches.map(s => String(s.properties.kind));
    const field = matches.find(s => s.properties.kind === 'farm');
    const block = this.blocks.at(x, y).find(s => contains(s, x, y));
    let surface: Surface = 'lowrise';
    if (district === 'sea') surface = kinds.includes('pier') ? 'pier' : 'sea';
    else if (['ottoman', 'east-region'].includes(district)) surface = 'foreign';
    else if (kinds.includes('airport')) surface = 'airport';
    else if (kinds.includes('lake')) surface = 'lake';
    else if (this.parks.at(x, y).some(s => contains(s, x, y))) surface = 'park';
    else if (kinds.includes('wood')) surface = 'wood';
    else if (block?.properties.kind === 'town') surface = 'town';
    else if (kinds.includes('farm') || district === 'reserve') surface = 'farm';
    else if (district === 'beverly') surface = 'lowdensity';
    else if (district === 'fleet-port') surface = 'military';
    else if (district === 'central') surface = Math.hypot(x - centralTerrain.core[0], y - centralTerrain.core[1]) < centralTerrain.coreRadiusKm ? 'highrise' : 'midrise';
    else if (block && ['highrise', 'midrise', 'lowrise'].includes(String(block.properties.type))) surface = block.properties.type as Surface;
    else if (['uptown', 'brooklyn'].includes(district)) surface = q.id < 0.2 && district === 'brooklyn' ? 'midrise' : district === 'uptown' ? 'midrise' : 'lowrise';
    if (['midrise', 'lowrise'].includes(surface) && district !== 'manhattan') {
      const u = (x * Math.cos(q.angle) + y * Math.sin(q.angle)) / 0.23;
      const v = (-x * Math.sin(q.angle) + y * Math.cos(q.angle)) / 0.18;
      if (worldHash(Math.floor(u), Math.floor(v), Math.floor(q.id * 1000)) < 0.1 && u - Math.floor(u) > 0.12 && v - Math.floor(v) > 0.12) surface = 'park';
    }
    return { district, surface, elevation: this.elevationAt(x, y, district), angle: q.angle, quarter: q.id,
      tone: Number(field?.properties.tone ?? 0), field: field?.id ?? Math.floor(q.id * 100000),
      fieldEdge: field ? Math.min(...field.rings[0].slice(1).map((p, i) => segmentDistance(x, y, field.rings[0][i], p))) : 1,
      part: ['airport-aircraft', 'airport-pier', 'runway', 'airport-taxiway', 'airport-apron'].find(k => kinds.includes(k)) ?? '' };
  }
}
