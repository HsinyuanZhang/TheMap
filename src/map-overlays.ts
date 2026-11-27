import type { Feature, LineString, Position } from 'geojson';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { Dataset, MapDatasets } from './dataset-loader';
import { inRing, toKm, toLngLat } from './world-model';

const expr = (value: unknown[]): ExpressionSpecification => value as ExpressionSpecification;
const collection = (features: Dataset['features']): Dataset => ({ type: 'FeatureCollection', features });
export const OVERVIEW_PLACES = ['strait-exchange', 'continental-tower', 'city-hall', 'airport', 'old-governors-house', 'north-checkpoint'] as const;
export const LOCAL_IDEOGRAPH_FONT = '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, "Noto Sans CJK SC", serif';
export const METRO_COLORS = { U1: '#D32F2F', U2: '#1976D2', U3: '#388E3C' } as const;
export const PLACE_COLORS = { landmark: '#6b96b6', historic: '#a8734f', transport: '#7f99a6', border: '#9d81bd', continental: '#b56b48', park: '#94b171' } as const;
export const metroOpacity = expr(['step', ['zoom'], 1, 13.5, 0.75]);
const metroWidth = expr(['interpolate', ['linear'], ['zoom'], 7.2, 4, 12, 5.5]);
const metroOffset = (half: number): unknown[] => ['*', ['get', 'offset'], half];
const lineColor = expr(['match', ['get', 'id'], 'U1', METRO_COLORS.U1, 'U2', METRO_COLORS.U2, 'U3', METRO_COLORS.U3, ['get', 'color']]);
const placeFilter = (extra: unknown[]): ExpressionSpecification => expr(['all', ['==', ['get', 'annotationType'], 'place'], extra]);
const important = ['in', ['get', 'id'], ['literal', OVERVIEW_PLACES]];
const neighborAnchors: Record<string, readonly [number, number]> = { ottoman: [18, 36], 'east-region': [43, 17.5] };

export function tagManhattanGeometry(data: Dataset, districts: Dataset): Dataset {
  const geometry = districts.features.find(f => f.properties.id === 'manhattan')?.geometry;
  const boundary = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const polygons = boundary.map(polygon => polygon.map(ring => ring.map(toKm)));
  return collection(data.features.map(f => {
    const shape = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    const inside = shape.length > 0 && shape.every(polygon => polygon.every(ring => ring.every(position => {
      const [x, y] = toKm(position);
      return polygons.some(rings => inRing(x, y, rings[0]) && !rings.slice(1).some(hole => inRing(x, y, hole)));
    })));
    return { ...f, properties: { ...f.properties, flatManhattan: inside ? 1 : 0 } };
  }));
}

export function placeKind(properties: Record<string, unknown>): keyof typeof PLACE_COLORS {
  if (properties.id === 'continental-tower') return 'continental';
  return properties.category === '古迹' ? 'historic' : properties.category === '口岸' ? 'border'
    : properties.category === '交通' ? 'transport' : properties.category === '公园' ? 'park' : 'landmark';
}

export function createHighwayShields(roads: Dataset): Dataset {
  const points: Dataset['features'] = [];
  for (const f of roads.features) {
    if (f.geometry.type !== 'LineString' || f.properties.class !== 'motorway' || !/^A[123]$/.test(String(f.properties.id))) continue;
    let distance = 0, next = 4;
    for (let i = 1; i < f.geometry.coordinates.length; i++) {
      const a = toKm(f.geometry.coordinates[i - 1]), b = toKm(f.geometry.coordinates[i]), length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (length && next <= distance + length) {
        const t = (next - distance) / length;
        points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }, properties: { id: f.properties.id, distance: next } });
        next += 8;
      }
      distance += length;
    }
  }
  return collection(points);
}

export function createMetroDisplay(lines: Dataset): Dataset {
  const paths = lines.features.filter((f): f is Feature<LineString, Dataset['features'][number]['properties']> => f.geometry.type === 'LineString');
  const pathSegments = (id: string) => paths.filter(f => f.properties.id === id).flatMap(f => f.geometry.coordinates.slice(1).map((p, i) => [toKm(f.geometry.coordinates[i]), toKm(p)] as const));
  const segments = { U1: pathSegments('U1'), U2: pathSegments('U2') };
  const output: Dataset['features'] = [];
  for (const f of paths) {
    const other = f.properties.id === 'U1' ? segments.U2 : f.properties.id === 'U2' ? segments.U1 : [];
    let run: Position[] = [], previous = false;
    const push = (): void => { if (run.length > 1) output.push({ ...f, geometry: { type: 'LineString', coordinates: run }, properties: { ...f.properties, offset: previous ? f.properties.id === 'U1' ? -1 : 1 : 0 } }); };
    for (let i = 1; i < f.geometry.coordinates.length; i++) {
      const a = f.geometry.coordinates[i - 1], b = f.geometry.coordinates[i], origin = toKm(a), end = toKm(b);
      const dx = end[0] - origin[0], dy = end[1] - origin[1], squared = dx * dx + dy * dy;
      if (!squared) continue;
      const length = Math.sqrt(squared), intervals: Array<[number, number]> = [];
      for (const [c, d] of other) {
        if (Math.abs(dx * (c[1] - origin[1]) - dy * (c[0] - origin[0])) / length > 0.0002
          || Math.abs(dx * (d[1] - origin[1]) - dy * (d[0] - origin[0])) / length > 0.0002) continue;
        const first = ((c[0] - origin[0]) * dx + (c[1] - origin[1]) * dy) / squared;
        const last = ((d[0] - origin[0]) * dx + (d[1] - origin[1]) * dy) / squared;
        const from = Math.max(0, Math.min(first, last)), to = Math.min(1, Math.max(first, last));
        if ((to - from) * length > 0.0002) intervals.push([from, to]);
      }
      const stops = [...new Set([0, 1, ...intervals.flat()])].sort((x, y) => x - y);
      const at = (t: number): Position => t === 0 ? a : t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (let j = 1; j < stops.length; j++) {
        const from = stops[j - 1], to = stops[j];
        if ((to - from) * length < 1e-8) continue;
        const middle = (from + to) / 2, common = intervals.some(([x, y]) => middle >= x && middle <= y);
        if (common !== previous || !run.length) { push(); run = [at(from)]; previous = common; }
        run.push(at(to));
      }
    }
    push();
  }
  return collection(output);
}

export function createMetroEnds(lines: Dataset): Dataset {
  return collection(lines.features.flatMap(f => f.geometry.type === 'LineString' && f.geometry.coordinates.length > 1
    ? [f.geometry.coordinates[0], f.geometry.coordinates.at(-1)!].map((coordinates, end) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates }, properties: { ...f.properties, end } })) : []));
}

export function overlaySources(data: MapDatasets): StyleSpecification['sources'] {
  return {
    'road-shields': { type: 'geojson', data: createHighwayShields(data.roads) },
    'metro-display': { type: 'geojson', data: createMetroDisplay(data.metro_lines) },
    'metro-ends': { type: 'geojson', data: createMetroEnds(data.metro_lines) },
    'sea-labels': { type: 'geojson', data: collection([['太平洋', -7, 15], ['海峡', 19, -3]].map(([name, x, y]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: toLngLat([Number(x), Number(y)]) }, properties: { name } }))) },
  };
}

function roadWidth(base: number, casing: boolean): ExpressionSpecification {
  const meters = ['case', ['==', ['get', 'class'], 'motorway'], 40, ['*', ['get', 'width'], 1000]];
  const physical = ['*', meters, 17.5];
  const near = ['*', meters, 0.2734375];
  return expr(['interpolate', ['exponential', 2], ['zoom'], 7.2, base, 10.7, base, 13, base * 3,
    14, casing ? ['max', ['*', near, 1.35], ['+', near, 2]] : near,
    20, casing ? ['max', ['*', physical, 1.35], ['+', physical, 2]] : physical]);
}

export function roadLayers(): LayerSpecification[] {
  const classes = [
    { id: 'local-roads', kind: ['local', 'hillroad'], zoom: 11, casing: 2.4, width: 1.2, color: '#f0e6c8' },
    { id: 'rural-roads', kind: ['rural'], zoom: 11, casing: 2.2, width: 1.1, color: '#e9dcb8' },
    { id: 'arterials', kind: ['arterial'], zoom: 9.5, casing: 3.4, width: 1.9, color: '#fbf4e0' },
    { id: 'highways', kind: ['motorway'], zoom: 7.2, casing: 6, width: 3.6, color: '#f3b54a' },
  ];
  const layers: LayerSpecification[] = [];
  for (const casing of [true, false]) for (const road of classes) {
    const id = casing ? road.id === 'highways' ? 'highway-casing' : road.id === 'arterials' ? 'arterial-casing' : road.id + '-casing' : road.id;
    layers.push({ id, type: 'line', source: 'roads', minzoom: road.zoom,
      filter: ['in', ['get', 'class'], ['literal', road.kind]], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': casing ? '#6a4320' : road.color, 'line-width': roadWidth(casing ? road.casing : road.width, casing),
        'line-opacity': casing && road.id !== 'highways' ? 0.5 : 1 } });
  }
  layers.push({ id: 'highway-centerline', type: 'line', source: 'roads', minzoom: 7.2, filter: ['==', ['get', 'class'], 'motorway'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fde9b0', 'line-width': ['interpolate', ['linear'], ['zoom'], 7.2, 0.6, 13, 1.2, 20, 2] } });
  return layers;
}

export function metroLayers(): LayerSpecification[] {
  const offset = expr(['interpolate', ['linear'], ['zoom'], 7.2, metroOffset(2), 12, metroOffset(2.75)]);
  const stationColor = expr(['match', ['get', 'lines'], 'U1', METRO_COLORS.U1, 'U2', METRO_COLORS.U2, METRO_COLORS.U3]);
  return [
    { id: 'metro-casing', type: 'line', source: 'metro-display', minzoom: 7.2, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fffdf5', 'line-width': ['interpolate', ['linear'], ['zoom'], 7.2, 7.2, 12, 8.7], 'line-offset': offset, 'line-opacity': metroOpacity } },
    { id: 'metro-lines', type: 'line', source: 'metro-display', minzoom: 7.2, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': lineColor, 'line-width': metroWidth, 'line-offset': offset, 'line-opacity': metroOpacity } },
    ...[false, true].map(transfer => ({ id: transfer ? 'transfer-stations' : 'normal-stations', type: 'circle' as const, source: 'metro_stations', minzoom: 7.2,
      filter: expr(['==', ['get', 'transfer'], transfer ? 1 : 0]), paint: { 'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 7.2, transfer ? 4.2 : 2.7, 14, transfer ? 6.5 : 4]), 'circle-color': '#fffdf5', 'circle-stroke-color': transfer ? '#26333b' : stationColor, 'circle-stroke-width': transfer ? 1.8 : 1.4, 'circle-opacity': metroOpacity, 'circle-stroke-opacity': metroOpacity } })),
  ];
}

function badge(id: string, source: string, image: string | ExpressionSpecification, text: string | ExpressionSpecification): LayerSpecification {
  return { id, type: 'symbol', source, minzoom: 7.2, layout: { 'icon-image': image, 'icon-text-fit': 'both', 'icon-text-fit-padding': [2, 5, 2, 5], 'text-field': text, 'text-font': ['DejaVu Sans'], 'text-size': 10.5, 'symbol-spacing': 160, 'text-allow-overlap': false, 'icon-allow-overlap': false, 'text-padding': 5, 'icon-padding': 5 }, paint: { 'text-color': '#ffffff' } };
}

function plate(id: string, filter: ExpressionSpecification, minzoom: number, overview = false): LayerSpecification {
  const prefix = overview ? 'overview-plate-' : 'place-plate-';
  return { id, type: 'symbol', source: 'annotations', minzoom, filter,
    layout: { 'icon-image': ['concat', prefix, ['get', 'plateKind']], 'icon-text-fit': 'both', 'icon-text-fit-padding': [4, 12, 5, 12], 'icon-anchor': 'bottom',
      'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': overview ? 11.5 : 11, 'text-anchor': 'bottom', 'text-offset': [0, -1.15],
      'symbol-sort-key': ['get', 'priority'], 'text-allow-overlap': false, 'icon-allow-overlap': false, 'text-padding': 4, 'icon-padding': 4 },
    paint: { 'text-color': '#f4ead1' } };
}

export function labelLayers(): LayerSpecification[] {
  const district = (id: string, filter: ExpressionSpecification, vertical = false, neighbor = false): LayerSpecification => ({
    id, type: 'symbol', source: 'labels', minzoom: 7.2, maxzoom: 13, filter,
    layout: { 'text-field': ['get', 'name'], 'text-writing-mode': vertical ? ['vertical'] : ['horizontal'], 'text-font': ['Noto Serif CJK SC Bold', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', 'serif'], 'text-letter-spacing': vertical ? 0 : 0.42, 'text-line-height': 1.35,
      'text-size': ['interpolate', ['linear'], ['zoom'], 10.7, neighbor ? 16 : 21, 12.9, neighbor ? 32 : 50], 'text-allow-overlap': false, 'text-padding': 8, 'symbol-sort-key': ['get', 'priority'] },
    paint: { 'text-color': '#f2e6c9', 'text-halo-color': '#2a2924', 'text-halo-width': 1.5, 'text-halo-blur': 0.5, 'text-opacity': neighbor ? 0.52 : 0.84 },
  });
  const east = ['all', ['==', ['get', 'id'], 'reserve'], ['>', ['get', 'labelX'], 28]];
  const station = (transfer: boolean): LayerSpecification => ({ id: transfer ? 'transfer-station-labels' : 'station-labels', type: 'symbol', source: 'annotations', minzoom: transfer ? 10 : 11.5,
    filter: ['all', ['==', ['get', 'annotationType'], 'station'], ['==', ['get', 'transfer'], transfer ? 1 : 0]],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.1, 'text-allow-overlap': false, 'symbol-sort-key': ['get', 'priority'] },
    paint: { 'text-color': '#273943', 'text-halo-color': '#fffdf4', 'text-halo-width': 1.4, 'text-opacity': metroOpacity } });
  const metroBadges = badge('metro-badges', 'metro-ends', expr(['concat', 'metro-badge-', ['get', 'id']]), expr(['get', 'id']));
  if (metroBadges.type === 'symbol') { metroBadges.layout = { ...metroBadges.layout, 'text-offset': ['match', ['get', 'id'], 'U1', ['literal', [-1.7, 1.8]], 'U2', ['literal', [1.7, 1.8]], ['literal', [0, 1.8]]] }; metroBadges.paint = { ...metroBadges.paint, 'text-opacity': metroOpacity, 'icon-opacity': metroOpacity }; }
  return [
    district('district-labels', expr(['all', ['==', ['get', 'kind'], 'district'], ['!', east]])),
    district('reserve-east-label', expr(east), true), district('neighbor-labels', expr(['==', ['get', 'kind'], 'neighbor']), false, true),
    { id: 'sea-labels', type: 'symbol', source: 'sea-labels', minzoom: 7.2, maxzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-font': ['DejaVu Serif Italic', 'DejaVu Serif', 'serif'], 'text-size': 19, 'text-letter-spacing': 0.3, 'text-rotate': -10 }, paint: { 'text-color': '#a6cbe1', 'text-opacity': 0.8, 'text-halo-color': '#10345e', 'text-halo-width': 1 } },
    { id: 'road-labels', type: 'symbol', source: 'roads', minzoom: 13, filter: ['all', ['==', ['get', 'class'], 'arterial'], ['!=', ['get', 'name'], '']], layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 10 }, paint: { 'text-color': '#654d38', 'text-halo-color': '#fbf4e0', 'text-halo-width': 1.2 } },
    badge('highway-shields', 'road-shields', 'highway-shield', expr(['get', 'id'])),
    plate('park-labels', placeFilter(['all', ['==', ['get', 'category'], '公园'], ['!', important]]), 11),
    plate('other-place-labels', placeFilter(['all', ['!=', ['get', 'category'], '地标'], ['!=', ['get', 'category'], '公园'], ['!=', ['get', 'category'], '街道'], ['!', important]]), 12.5),
    station(false), station(true), metroBadges,
    plate('landmark-labels', placeFilter(['all', ['==', ['get', 'category'], '地标'], ['!', important]]), 11),
    plate('overview-place-labels', placeFilter(important), 7.2, true),
  ];
}

export function displayLabels(labels: Dataset): Dataset {
  return collection(labels.features.map(f => {
    const anchor = f.properties.kind === 'neighbor' ? neighborAnchors[String(f.properties.id)] : undefined;
    const geometry = anchor ? { type: 'Point' as const, coordinates: toLngLat(anchor) } : f.geometry;
    return { ...f, geometry, properties: { ...f.properties, labelX: geometry.type === 'Point' ? toKm(geometry.coordinates)[0] : 0 } };
  }));
}
