import type { MapDatasets } from './dataset-loader';
import type { PaintView } from './terrain-painter';
import { toLngLat } from './world-model';

export const FIRST_VIEW: PaintView = { west: -35, south: -25, east: 90, north: 95, width: 384, height: 369, zoom: 9, pitch: 31 };
export const FIRST_COORDINATES: [[number, number], [number, number], [number, number], [number, number]] = [
  toLngLat([FIRST_VIEW.west, FIRST_VIEW.north]), toLngLat([FIRST_VIEW.east, FIRST_VIEW.north]),
  toLngLat([FIRST_VIEW.east, FIRST_VIEW.south]), toLngLat([FIRST_VIEW.west, FIRST_VIEW.south]),
];
export type PaintRequest =
  | { kind: 'cancel'; id: number }
  | { kind: 'world'; revision: number; data: MapDatasets }
  | { kind: 'tile'; id: number; revision: number; z: number; x: number; y: number; detail: number; pitch: number; buildings: boolean };
export type PaintResponse =
  | { kind: 'first'; revision: number; data: ArrayBuffer }
  | { kind: 'tile'; id: number; data: ArrayBuffer }
  | { kind: 'error'; id?: number; error: string };
