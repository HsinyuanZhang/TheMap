import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { MapDatasets } from './dataset-loader';
import { MAP_ZOOM } from './map-lod';
import { MAP_LIGHT, shadowOffset } from './map-light';
import { FIRST_COORDINATES } from './paint-messages';
import { SURFACE_COLORS, PAINT } from './terrain-painter';

type Properties = Record<string, string | number | boolean>;
type Annotation = Feature<Geometry, Properties>;
type StyleExpression = ExpressionSpecification;
const expression = (value: unknown[]): StyleExpression => value as unknown as StyleExpression;
const surfaceColor = (name: keyof typeof SURFACE_COLORS): string => '#' + SURFACE_COLORS[name].map(v => v.toString(16).padStart(2, '0')).join('');
export const MAP_PALETTE = {
  water: '#10345e', terrain: '#c1b48e',
  terrainBands: {
    0: '#e9e2c8', 40: '#e1d5b3', 80: '#d8c99e', 120: '#cfbd8d',
    160: '#c4ad7d', 200: '#b9a16d', 240: '#ad955f', 280: '#a28b57',
  },
  woods: '#557b42', parks: '#94b171',
  farmTones: ['#c3bb73', '#adb772', '#cbc184', '#90a566', '#beab6f', '#b5bf89', '#a3a86f'],
  roads: '#c9b99d', highways: '#bd8260', boundary: '#526e73', districtBoundary: '#a4aaa0', military: surfaceColor('military'),
  metroLines: { U1: '#D32F2F', U2: '#1976D2', U3: '#388E3C' },
  blockTypes: {
    highrise: surfaceColor('highrise'), midrise: surfaceColor('midrise'), lowrise: surfaceColor('lowrise'), lowdensity: surfaceColor('lowdensity'),
    town: surfaceColor('town'), plaza: '#efe9dc', outline: '#bfb49d', fallback: '#e2dac9',
  },
  buildingHeights: {
    low: '#eee6d6', medium: '#dccfb6', high: '#c3c9c9', veryHigh: '#9fb1bc', outline: '#a99f8b',
  },
  landmark: '#6f8791', monument: '#a8734f', continental: '#b56b48', selected: '#f2c66d',
} as const;
const farmSwatch = `linear-gradient(90deg, ${MAP_PALETTE.farmTones.join(', ')})`;
const terrainSwatch = `linear-gradient(90deg, ${Object.values(MAP_PALETTE.terrainBands).join(', ')})`;
const buildingSwatch = `linear-gradient(90deg, ${Object.values(MAP_PALETTE.buildingHeights).slice(0, 4).join(', ')})`;
export const MAP_LEGEND_ITEMS = [
  { label: '高层区', swatch: MAP_PALETTE.blockTypes.highrise },
  { label: '中层区', swatch: MAP_PALETTE.blockTypes.midrise },
  { label: '低层密集', swatch: MAP_PALETTE.blockTypes.lowrise },
  { label: '低密度住宅', swatch: MAP_PALETTE.blockTypes.lowdensity },
  { label: '小城镇', swatch: MAP_PALETTE.blockTypes.town },
  { label: '广场', swatch: MAP_PALETTE.blockTypes.plaza },
  { label: '丘陵地形', swatch: terrainSwatch },
  { label: '树林', swatch: MAP_PALETTE.woods },
  { label: '农田', swatch: farmSwatch },
  { label: '军事区', swatch: MAP_PALETTE.military },
  { label: '公园', swatch: MAP_PALETTE.parks },
  { label: '楼房（高度分色）', swatch: buildingSwatch },
  { label: '大陆集团大厦', swatch: MAP_PALETTE.continental },
  { label: '其他地标', swatch: MAP_PALETTE.landmark },
  { label: '历史古迹', swatch: MAP_PALETTE.monument },
  { label: '水域', swatch: MAP_PALETTE.water },
  { label: '机场', swatch: '#99b070' },
  { label: '公路', swatch: MAP_PALETTE.roads },
  { label: '高速公路', swatch: MAP_PALETTE.highways },
  { label: '地铁 U1', swatch: MAP_PALETTE.metroLines.U1 },
  { label: '地铁 U2', swatch: MAP_PALETTE.metroLines.U2 },
  { label: '地铁 U3', swatch: MAP_PALETTE.metroLines.U3 },
  { label: '城区边界', swatch: MAP_PALETTE.districtBoundary, symbol: 'solid-line' },
  { label: '保留地虚线边界', swatch: MAP_PALETTE.boundary, symbol: 'dashed-line' },
] as const;
const fadeIn = (minZoom: number, opacity = 1): StyleExpression => expression([
  'interpolate', ['linear'], ['zoom'], minZoom, 0, minZoom + MAP_ZOOM.fadeSpan, opacity,
]);
const collection = (features: Annotation[]): FeatureCollection<Geometry, Properties> => ({
  type: 'FeatureCollection',
  features,
});

export function createPointAnnotations(datasets: MapDatasets): FeatureCollection<Geometry, Properties> {
  const landmarkNames = new Set(datasets.pois.features
    .filter((feature) => feature.properties?.category === '地标')
    .map((feature) => String(feature.properties?.name ?? '')));
  const placeFeatures = datasets.pois.features.map((feature) => ({
    ...feature,
    properties: { ...feature.properties, annotationType: 'place', priority: feature.properties?.category === '地标' ? 1 : 4 },
  })) as Annotation[];
  const stationFeatures = datasets.metro_stations.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      annotationType: 'station',
      priority: feature.properties?.transfer === 1 ? 2 : 3,
      duplicateLandmarkLabel: landmarkNames.has(String(feature.properties?.name ?? '')) ? 1 : 0,
    },
  })) as Annotation[];
  return collection([...placeFeatures, ...stationFeatures]);
}

function widthMeters(): StyleExpression {
  return expression([
    'case',
    ['==', ['get', 'class'], 'motorway'], 40,
    ['match', ['get', 'id'],
      'broadway', 34,
      'queens-road', 34,
      'fifth-avenue', 24,
      'wall-street', 20,
      'promenade', 8,
      ['*', ['get', 'width'], 1000],
    ],
  ]);
}

function widthAtZoom(meters: StyleExpression, factors: readonly number[]): StyleExpression {
  return expression([
    'interpolate', ['exponential', 2], ['zoom'],
    7, ['*', meters, factors[0]],
    10, ['*', meters, factors[1]],
    13, ['*', meters, factors[2]],
    20, ['*', meters, factors[3]],
  ]);
}

function casingAtZoom(widthMetersExpression: StyleExpression, factors: readonly number[]): StyleExpression {
  const widthAt = (index: number) => ['*', widthMetersExpression, factors[index]];
  return expression([
    'interpolate', ['exponential', 2], ['zoom'],
    7, ['max', ['*', widthAt(0), 1.35], ['+', widthAt(0), 2]],
    10, ['max', ['*', widthAt(1), 1.35], ['+', widthAt(1), 2]],
    13, ['max', ['*', widthAt(2), 1.35], ['+', widthAt(2), 2]],
    20, ['max', ['*', widthAt(3), 1.35], ['+', widthAt(3), 2]],
  ]);
}

function highwayWidthAtZoom(): StyleExpression {
  return expression(['interpolate', ['exponential', 2], ['zoom'], 7, 1.6, 10, 3, 13, 5.5, 20, 700]);
}

function highwayCasingAtZoom(): StyleExpression {
  return expression([
    'interpolate', ['exponential', 2], ['zoom'],
    7, ['max', 2.16, 3.6],
    10, ['max', 4.05, 5],
    13, ['max', 7.425, 7.5],
    20, ['max', 945, 702],
  ]);
}

export function buildingColorExpression(selectedId: string | undefined): StyleExpression {
  const base = [
    'case',
    ['==', ['get', 'id'], 'continental-tower'], MAP_PALETTE.continental,
    ['==', ['get', 'kind'], 'monument'], MAP_PALETTE.monument,
    ['==', ['get', 'kind'], 'landmark'], MAP_PALETTE.landmark,
    ['step', ['get', 'top'],
      MAP_PALETTE.buildingHeights.low,
      45, MAP_PALETTE.buildingHeights.medium,
      90, MAP_PALETTE.buildingHeights.high,
      150, MAP_PALETTE.buildingHeights.veryHigh,
    ],
  ];
  return expression(selectedId
    ? ['case', ['==', ['get', 'id'], selectedId], MAP_PALETTE.selected, base]
    : base);
}

export function blockTypeColorExpression(): StyleExpression {
  return expression(['match', ['get', 'type'],
    'highrise', MAP_PALETTE.blockTypes.highrise,
    'midrise', MAP_PALETTE.blockTypes.midrise,
    'lowrise', MAP_PALETTE.blockTypes.lowrise,
    'lowdensity', MAP_PALETTE.blockTypes.lowdensity,
    'town', MAP_PALETTE.blockTypes.town,
    'plaza', MAP_PALETTE.blockTypes.plaza,
    MAP_PALETTE.blockTypes.fallback,
  ]);
}

function sourceData(datasets: MapDatasets, paintTiles: string[]): StyleSpecification['sources'] {
  return {
    'paint-first': { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQMIn7DwACnAGir+SnEAAAAABJRU5ErkJggg==', coordinates: FIRST_COORDINATES },
    'painted-terrain': { type: 'raster', tiles: paintTiles, tileSize: PAINT.tileSize, minzoom: PAINT.minzoom, maxzoom: PAINT.maxzoom },
    land: { type: 'geojson', data: datasets.land },
    districts: { type: 'geojson', data: datasets.districts },
    parks: { type: 'geojson', data: datasets.parks },
    roads: { type: 'geojson', data: datasets.roads },
    metro_lines: { type: 'geojson', data: datasets.metro_lines },
    metro_stations: { type: 'geojson', data: datasets.metro_stations },
    buildings: { type: 'geojson', data: datasets.buildings },
    pois: { type: 'geojson', data: datasets.pois },
    blocks: { type: 'geojson', data: datasets.blocks },
    boundaries: { type: 'geojson', data: datasets.boundaries },
    labels: { type: 'geojson', data: datasets.labels },
    trees: { type: 'geojson', data: datasets.trees },
    surface: { type: 'geojson', data: datasets.surface },
    terrain: { type: 'geojson', data: datasets.terrain },
    annotations: { type: 'geojson', data: createPointAnnotations(datasets) },
  } as StyleSpecification['sources'];
}

export function createMapStyle(baseUrl: string, datasets: MapDatasets, selectedId?: string, paintTiles = ['paint://0/{z}/{x}/{y}?revision=1&detail=9&pitch=0&buildings=1']): StyleSpecification {
  const highwayWidth = highwayWidthAtZoom();
  const highwayCasing = highwayCasingAtZoom();
  const arterialMeters = widthMeters();
  const blockTypeColor = blockTypeColorExpression();
  const arterialFactors = [0, 0.04, 0.1366666667, 17.5] as const;
  const arterialWidth = widthAtZoom(arterialMeters, arterialFactors);
  const arterialCasing = casingAtZoom(arterialMeters, arterialFactors);
  const layers: LayerSpecification[] = [
    { id: 'ocean', type: 'background', paint: { 'background-color': MAP_PALETTE.water } },
    { id: 'paint-first', type: 'raster', source: 'paint-first', paint: { 'raster-fade-duration': 0 } },
    { id: 'painted-terrain', type: 'raster', source: 'painted-terrain', paint: { 'raster-fade-duration': 250, 'raster-resampling': 'linear' } },
    {
      id: 'land-fill', type: 'fill', source: 'land',
      paint: {
        'fill-opacity': 0,
      },
    },
    {
      id: 'district-fill', type: 'fill', source: 'districts', minzoom: MAP_ZOOM.region,
      paint: {
        'fill-opacity': 0,
      },
    },
    {
      id: 'district-boundaries', type: 'line', source: 'districts', minzoom: MAP_ZOOM.region,
      paint: { 'line-color': MAP_PALETTE.districtBoundary, 'line-width': 1.15, 'line-opacity': 0.9 },
    },
    {
      id: 'reserve-city-boundaries', type: 'line', source: 'boundaries', minzoom: MAP_ZOOM.region,
      filter: ['==', ['get', 'kind'], 'reserve-city'],
      paint: { 'line-color': MAP_PALETTE.boundary, 'line-width': 2.2, 'line-opacity': 0.9 },
    },

    {
      id: 'terrain-contours', type: 'line', source: 'terrain', minzoom: 13,
      filter: ['==', ['get', 'kind'], 'contour'],
      paint: { 'line-color': '#8f7554', 'line-width': 1, 'line-opacity': fadeIn(MAP_ZOOM.contours, 0.72) },
    },
    {
      id: 'terrain-contour-labels', type: 'symbol', source: 'terrain', minzoom: MAP_ZOOM.detailLabels,
      filter: ['==', ['get', 'kind'], 'contour'],
      layout: {
        'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'level']], ' m'],
        'text-font': ['DejaVu Sans'], 'text-size': 9, 'text-allow-overlap': false,
      },
      paint: { 'text-color': '#745e42', 'text-halo-color': '#f3ead7', 'text-halo-width': 1, 'text-opacity': fadeIn(MAP_ZOOM.detailLabels, 0.85) },
    },
    {
      id: 'north-border', type: 'line', source: 'boundaries', minzoom: MAP_ZOOM.region,
      filter: ['==', ['get', 'kind'], 'north-border'],
      paint: { 'line-color': '#526e73', 'line-width': 3, 'line-dasharray': [2, 1.3] },
    },
    {
      id: 'parks-hit', type: 'fill', source: 'parks',
      paint: { 'fill-opacity': 0 },
    },
    {
      id: 'blocks-fill', type: 'fill', source: 'blocks', minzoom: PAINT.close,
      filter: ['all', ['in', ['get', 'kind'], ['literal', ['block', 'plaza']]], ['in', ['get', 'zone'], ['literal', ['grid', 'financial', 'reclamation', 'residual', 'manhattan', 'landmark']]]],
      paint: {
        'fill-color': blockTypeColor,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], PAINT.close, 0, PAINT.close + PAINT.fade, 1],
        'fill-outline-color': MAP_PALETTE.blockTypes.outline,
      },
    },
    {
      id: 'highway-casing', type: 'line', source: 'roads', minzoom: MAP_ZOOM.region,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fffdf8', 'line-width': highwayCasing, 'line-opacity': 0.97 },
    },
    {
      id: 'highways', type: 'line', source: 'roads', minzoom: MAP_ZOOM.region,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#bd8260', 'line-width': highwayWidth, 'line-opacity': 0.94 },
    },
    {
      id: 'arterial-casing', type: 'line', source: 'roads', minzoom: MAP_ZOOM.parks,
      filter: ['==', ['get', 'class'], 'arterial'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fffdf8', 'line-width': arterialCasing, 'line-opacity': fadeIn(MAP_ZOOM.parks, 0.97) },
    },
    {
      id: 'arterials', type: 'line', source: 'roads', minzoom: MAP_ZOOM.parks,
      filter: ['==', ['get', 'class'], 'arterial'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'name'], ''], '#c9b99d', '#d0ad82'],
        'line-width': arterialWidth,
        'line-opacity': fadeIn(MAP_ZOOM.parks, 0.94),
      },
    },
    {
      id: 'local-roads', type: 'line', source: 'roads', minzoom: MAP_ZOOM.blocks,
      filter: ['in', ['get', 'class'], ['literal', ['local', 'hillroad']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'class'], 'hillroad', '#937d5e', 'rural', '#aa9b7d', '#c9b99d'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 13, 1.4, 17, 5],
        'line-opacity': fadeIn(MAP_ZOOM.blocks, 0.82),
      },
    },
    {
      id: 'rural-roads', type: 'line', source: 'roads', minzoom: MAP_ZOOM.farms,
      filter: ['==', ['get', 'class'], 'rural'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#aa9b7d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 13, 1.4, 17, 5],
        'line-opacity': fadeIn(MAP_ZOOM.farms, 0.82),
      },
    },
    {
      id: 'metro-lines', type: 'line', source: 'metro_lines', minzoom: MAP_ZOOM.region,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'id'],
          'U1', MAP_PALETTE.metroLines.U1, 'U2', MAP_PALETTE.metroLines.U2,
          'U3', MAP_PALETTE.metroLines.U3, ['get', 'color']],
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2, 11, 3.2, 14, 4, 18, 6],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], MAP_ZOOM.metro, 0.93, MAP_ZOOM.detailLabels, 0.93, MAP_ZOOM.duplicateLabels, 0.6],
      },
    },
    {
      id: 'building-shadows-low', type: 'fill', source: 'buildings', minzoom: MAP_ZOOM.flat,
      filter: ['all', ['==', ['get', 'base'], 0], ['>=', ['get', 'top'], 60], ['<', ['get', 'top'], 150]],
      paint: {
        'fill-color': '#3b3a36', 'fill-opacity': fadeIn(MAP_ZOOM.flat, 0.22),
        'fill-translate': ['interpolate', ['linear'], ['zoom'], MAP_ZOOM.flat, ['literal', [0, 0]], 16, ['literal', shadowOffset(3)], 20, ['literal', shadowOffset(5)]],
        'fill-translate-anchor': 'map',
      },
    },
    {
      id: 'building-shadows-high', type: 'fill', source: 'buildings', minzoom: MAP_ZOOM.flat,
      filter: ['all', ['==', ['get', 'base'], 0], ['>=', ['get', 'top'], 150]],
      paint: {
        'fill-color': '#2f3336', 'fill-opacity': fadeIn(MAP_ZOOM.flat, 0.3),
        'fill-translate': ['interpolate', ['linear'], ['zoom'], MAP_ZOOM.flat, ['literal', [0, 0]], 16, ['literal', shadowOffset(7)], 20, ['literal', shadowOffset(9)]],
        'fill-translate-anchor': 'map',
      },
    },
    {
      id: 'buildings-flat', type: 'fill', source: 'buildings', minzoom: MAP_ZOOM.flat,
      filter: ['==', ['get', 'base'], 0],
      paint: {
        'fill-color': buildingColorExpression(selectedId),
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], MAP_ZOOM.flat, 0, MAP_ZOOM.flatFull, 1],
        'fill-outline-color': MAP_PALETTE.buildingHeights.outline,
      },
    },
    {
      id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings', minzoom: MAP_ZOOM.extrusion,
      layout: { visibility: 'none' },
      filter: ['==', ['get', 'key'], 1],
      paint: {
        'fill-extrusion-color': buildingColorExpression(selectedId),
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'height']],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'base']],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'trees-3d', type: 'fill-extrusion', source: 'trees', minzoom: MAP_ZOOM.detailLabels,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': '#7fae7a',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14, ['get', 'h']],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': fadeIn(MAP_ZOOM.detailLabels),
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'transfer-stations', type: 'circle', source: 'metro_stations', minzoom: MAP_ZOOM.region,
      filter: ['==', ['get', 'transfer'], 1],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 11],
        'circle-color': '#fffefa',
        'circle-stroke-color': '#183d4b',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 3],
      },
    },
    {
      id: 'normal-stations', type: 'circle', source: 'metro_stations', minzoom: MAP_ZOOM.parks,
      filter: ['==', ['get', 'transfer'], 0],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 8],
        'circle-color': '#fffefa',
        'circle-stroke-color': '#536d72',
        'circle-stroke-width': 2,
        'circle-opacity': fadeIn(MAP_ZOOM.parks),
        'circle-stroke-opacity': fadeIn(MAP_ZOOM.parks),
      },
    },
    {
      id: 'landmark-markers', type: 'circle', source: 'pois', minzoom: MAP_ZOOM.parks,
      filter: ['==', ['get', 'category'], '地标'],
      paint: {
        'circle-radius': 6.3,
        'circle-color': ['case', ['==', ['get', 'id'], 'continental-tower'], MAP_PALETTE.continental, MAP_PALETTE.landmark],
        'circle-stroke-color': '#fffefa',
        'circle-stroke-width': 1.8,
        'circle-opacity': fadeIn(MAP_ZOOM.parks),
        'circle-stroke-opacity': fadeIn(MAP_ZOOM.parks),
      },
    },
    {
      id: 'historic-markers', type: 'circle', source: 'pois', minzoom: MAP_ZOOM.parks,
      filter: ['==', ['get', 'category'], '古迹'],
      paint: {
        'circle-radius': 6.3,
        'circle-color': MAP_PALETTE.monument,
        'circle-stroke-color': '#fffefa',
        'circle-stroke-width': 1.8,
        'circle-opacity': fadeIn(MAP_ZOOM.parks),
        'circle-stroke-opacity': fadeIn(MAP_ZOOM.parks),
      },
    },
    {
      id: 'other-place-markers', type: 'circle', source: 'pois', minzoom: MAP_ZOOM.contours,
      filter: ['all', ['!=', ['get', 'category'], '地标'], ['!=', ['get', 'category'], '古迹']],
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#536d72',
        'circle-stroke-width': 1.6,
        'circle-opacity': fadeIn(MAP_ZOOM.contours),
        'circle-stroke-opacity': fadeIn(MAP_ZOOM.contours),
      },
    },
    {
      id: 'district-labels', type: 'symbol', source: 'labels', minzoom: MAP_ZOOM.region, maxzoom: MAP_ZOOM.districtLabelEnd,
      filter: ['any', ['==', ['get', 'kind'], 'district'], ['==', ['get', 'kind'], 'neighbor']],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['DejaVu Sans'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 12, 15],
        'symbol-sort-key': ['get', 'priority'],
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: {
        'text-color': '#53645d',
        'text-halo-color': '#f7f7ef',
        'text-halo-width': 1.4,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], MAP_ZOOM.contours, 1, MAP_ZOOM.districtLabelEnd, 0],
      },
    },
    {
      id: 'road-labels', type: 'symbol', source: 'roads', minzoom: MAP_ZOOM.contours,
      filter: ['all', ['==', ['get', 'class'], 'arterial'], ['!=', ['get', 'name'], '']],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': ['DejaVu Sans'],
        'text-size': 10,
        'symbol-sort-key': 90,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#8c684c',
        'text-halo-color': '#fffdf8',
        'text-halo-width': 1.2,
        'text-opacity': fadeIn(MAP_ZOOM.contours),
      },
    },
    {
      id: 'landmark-labels', type: 'symbol', source: 'annotations', minzoom: MAP_ZOOM.parks,
      filter: ['all', ['==', ['get', 'annotationType'], 'place'], ['==', ['get', 'category'], '地标']],
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
        'text-offset': [0, 1.15], 'text-anchor': 'top', 'symbol-sort-key': ['get', 'priority'],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#344b51',
        'text-halo-color': '#fff',
        'text-halo-width': 1.2,
        'text-opacity': fadeIn(MAP_ZOOM.parks),
      },
    },
    {
      id: 'station-labels', type: 'symbol', source: 'annotations', minzoom: MAP_ZOOM.texture,
      filter: ['all', ['==', ['get', 'annotationType'], 'station'], ['!=', ['get', 'duplicateLandmarkLabel'], 1]],
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
        'text-offset': [0, 1.2], 'text-anchor': 'top', 'symbol-sort-key': ['get', 'priority'],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#2d4b55',
        'text-halo-color': '#fff',
        'text-halo-width': 1.3,
        'text-opacity': fadeIn(MAP_ZOOM.texture),
      },
    },
    {
      id: 'duplicate-station-labels', type: 'symbol', source: 'annotations', minzoom: MAP_ZOOM.duplicateLabels,
      filter: ['all', ['==', ['get', 'annotationType'], 'station'], ['==', ['get', 'duplicateLandmarkLabel'], 1]],
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
        'text-offset': [0, 1.2], 'text-anchor': 'top', 'symbol-sort-key': ['get', 'priority'],
        'text-allow-overlap': false,
      },
      paint: { 'text-color': '#2d4b55', 'text-halo-color': '#fff', 'text-halo-width': 1.3, 'text-opacity': fadeIn(MAP_ZOOM.duplicateLabels), },
    },
    {
      id: 'other-place-labels', type: 'symbol', source: 'annotations', minzoom: MAP_ZOOM.contours,
      filter: ['all', ['==', ['get', 'annotationType'], 'place'], ['!=', ['get', 'category'], '地标'], ['!=', ['get', 'category'], '公园'], ['!=', ['get', 'category'], '街道']],
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
        'text-offset': [0, 1.15], 'text-anchor': 'top', 'symbol-sort-key': ['get', 'priority'],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#344b51',
        'text-halo-color': '#fff',
        'text-halo-width': 1.2,
        'text-opacity': fadeIn(MAP_ZOOM.contours),
      },
    },
  ];
  const parkLabels: LayerSpecification = {
    id: 'park-labels', type: 'symbol', source: 'annotations', minzoom: MAP_ZOOM.parks,
    filter: ['all', ['==', ['get', 'annotationType'], 'place'], ['==', ['get', 'category'], '公园']],
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
      'symbol-sort-key': 40, 'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#42694b',
      'text-halo-color': '#edf5eb',
      'text-halo-width': 1.2,
      'text-opacity': fadeIn(MAP_ZOOM.parks),
    },
  };
  const priorityOrder = ['road-labels', 'park-labels', 'other-place-labels', 'station-labels', 'duplicate-station-labels', 'landmark-labels'];
  layers.push(parkLabels);
  const priorityLayers = priorityOrder.map((id) => layers.find((layer) => layer.id === id)!)
    .filter(Boolean);
  layers.splice(0, layers.length, ...layers.filter((layer) => !priorityOrder.includes(layer.id)), ...priorityLayers);

  return {
    version: 8,
    glyphs: baseUrl + 'fonts/{fontstack}/{range}.pbf',
    light: { anchor: 'map', position: [1.4, MAP_LIGHT.azimuth, MAP_LIGHT.altitude], intensity: 0.42, color: '#fff4e2' },
    sky: {
      'sky-color': '#bcd6e8',
      'horizon-color': '#f4ece0',
      'fog-color': '#eef0ec',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.55,
      'atmosphere-blend': 0,
    },
    sources: sourceData(datasets, paintTiles),
    layers,
  };
}
