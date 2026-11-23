import type { Position } from 'geojson';

export interface CenterBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const mapCameraLimits = { minZoom: 7.2, maxZoom: 18, maxPitch: 80, defaultPitch: 60 } as const;
export const initialMapCamera = { pitch: 0, bearing: 0 } as const;

export function pointFocusZoom(currentZoom: number, minimumZoom: number): number {
  return Math.max(currentZoom, minimumZoom);
}

export function geometryFocusZoom(currentZoom: number, fitZoom: number, maxZoom = 15): number {
  return Math.max(currentZoom, Math.min(maxZoom, fitZoom));
}

export interface ThreeDimensionalView {
  preset: boolean;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export function threeDimensionalView(
  zoom: number,
  center: [number, number],
  bearing: number,
  continentalCenter?: [number, number],
): ThreeDimensionalView {
  if (zoom < 13 && continentalCenter) {
    return { preset: true, center: continentalCenter, zoom: 15, pitch: 72, bearing: -18 };
  }
  return { preset: false, center, zoom, pitch: mapCameraLimits.defaultPitch, bearing };
}

export function mobileScaleOffset(
  mapRect: MapRect,
  panelRect: MapRect,
  panelOpen: boolean,
  mobile: boolean,
): number {
  if (!mobile || !panelOpen) return 0;
  const overlap = Math.max(0, mapRect.bottom - Math.max(mapRect.top, panelRect.top));
  return Math.ceil(overlap + 22);
}

export function removeTranslationFromRect(rect: MapRect, x: number, y: number): MapRect {
  return {
    top: rect.top - y,
    right: rect.right - x,
    bottom: rect.bottom - y,
    left: rect.left - x,
  };
}

export function clampCenterToBounds(
  center: { lng: number; lat: number },
  bounds: CenterBounds,
): [number, number] {
  return [
    Math.min(bounds.east, Math.max(bounds.west, center.lng)),
    Math.min(bounds.north, Math.max(bounds.south, center.lat)),
  ];
}

export function boundsFromPositions(positions: readonly Position[]): [[number, number], [number, number]] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const position of positions) {
    const longitude = position[0]!;
    const latitude = position[1]!;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error('Cannot fit map: district and neighboring-land geometry is empty.');
  }
  return [[west, south], [east, north]];
}

export function getMapPadding(
  mapRect: MapRect,
  panelRect: MapRect,
  panelOpen: boolean,
  mobile: boolean,
): MapPadding {
  const padding: MapPadding = {
    top: mobile ? 126 : 136,
    right: 32,
    bottom: 32,
    left: 32,
  };
  if (!panelOpen) return padding;

  const width = mapRect.right - mapRect.left;
  const height = mapRect.bottom - mapRect.top;
  if (width <= 0 || height <= 0) return padding;

  const overlapLeft = Math.max(mapRect.left, panelRect.left);
  const overlapRight = Math.min(mapRect.right, panelRect.right);
  const overlapTop = Math.max(mapRect.top, panelRect.top);
  const overlapBottom = Math.min(mapRect.bottom, panelRect.bottom);
  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapHeight = Math.max(0, overlapBottom - overlapTop);
  const coversRight = panelRect.left > mapRect.left + width / 2
    && panelRect.right > mapRect.right - width * 0.05
    && overlapHeight >= height * 0.6;
  const coversBottom = overlapWidth >= width * 0.9
    && panelRect.top > mapRect.top + height / 2
    && panelRect.bottom > mapRect.bottom - height * 0.05;

  if (coversRight) padding.right = Math.max(padding.right, mapRect.right - overlapLeft + 24);
  if (coversBottom) padding.bottom = Math.max(padding.bottom, mapRect.bottom - overlapTop + 24);
  return padding;
}
