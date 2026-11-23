import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { MapDatasets } from './dataset-loader';

type Properties = Record<string, string | number | boolean>;
type Annotation = Feature<Geometry, Properties>;
type StyleExpression = ExpressionSpecification;
const expression = (value: unknown[]): StyleExpression => value as unknown as StyleExpression;
const fadeIn = (minZoom: number, opacity = 1): StyleExpression => expression([
  'interpolate', ['linear'], ['zoom'], minZoom, 0, minZoom + 0.5, opacity,
]);
const collection = (features: Annotation[]): FeatureCollection<Geometry, Properties> => ({
  type: 'FeatureCollection',
  features,
});

export function createPointAnnotations(datasets: MapDatasets): FeatureCollection<Geometry, Properties> {
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
  const regular = [
    'interpolate', ['linear'], ['get', 'top'],
    15, '#e9e3d6',
    60, '#d7d2c6',
    140, '#b7c2c6',
    260, '#93a8b3',
    430, '#7e97a6',
  ];
  const base = [
    'case',
    ['==', ['get', 'id'], 'continental-tower'], '#b56b48',
    ['==', ['get', 'kind'], 'landmark'], '#687f83',
    regular,
  ];
  return expression(selectedId
    ? ['case', ['==', ['get', 'id'], selectedId], '#f2c66d', base]
    : base);
}

function sourceData(datasets: MapDatasets): StyleSpecification['sources'] {
  return {
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
    annotations: { type: 'geojson', data: createPointAnnotations(datasets) },
  } as StyleSpecification['sources'];
}

export function createMapStyle(baseUrl: string, datasets: MapDatasets, selectedId?: string): StyleSpecification {
  const highwayWidth = highwayWidthAtZoom();
  const highwayCasing = highwayCasingAtZoom();
  const arterialMeters = widthMeters();
  const arterialFactors = [0, 0.04, 0.1366666667, 17.5] as const;
  const arterialWidth = widthAtZoom(arterialMeters, arterialFactors);
  const arterialCasing = casingAtZoom(arterialMeters, arterialFactors);
  const layers: LayerSpecification[] = [
    { id: 'ocean', type: 'background', paint: { 'background-color': '#dce8eb' } },
    {
      id: 'coastline-shallows', type: 'line', source: 'boundaries',
      filter: ['==', ['get', 'kind'], 'coastline'],
      paint: {
        'line-color': '#c5dcdc',
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 7, 0.64, 10, 5, 13, 40, 18, 1280],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'land-fill', type: 'fill', source: 'land',
      paint: {
        'fill-color': ['match', ['get', 'kind'], 'monaco', '#e6e5d9', 'ottoman', '#e3dfd2', 'east-region', '#e5e3d8', '#e9e8df'],
        'fill-opacity': 1,
      },
    },
    {
      id: 'land-outline', type: 'line', source: 'land',
      paint: { 'line-color': '#879b9b', 'line-width': 1.2, 'line-opacity': 0.75 },
    },
    {
      id: 'district-fill', type: 'fill', source: 'districts', minzoom: 7.2,
      paint: {
        'fill-color': ['match', ['get', 'kind'], 'urban', '#eadfce', 'military', '#d7dfdb', 'reserve', '#dfe8d7', '#e8e1d6'],
        'fill-opacity': 0.9,
      },
    },
    {
      id: 'district-boundaries', type: 'line', source: 'districts', minzoom: 7.2,
      paint: { 'line-color': '#a4aaa0', 'line-width': 1.15, 'line-opacity': 0.9 },
    },
    {
      id: 'north-border', type: 'line', source: 'boundaries', minzoom: 7.2,
      filter: ['==', ['get', 'kind'], 'north-border'],
      paint: { 'line-color': '#526e73', 'line-width': 3, 'line-dasharray': [2, 1.3] },
    },
    {
      id: 'farms', type: 'fill', source: 'surface', minzoom: 9.5,
      filter: ['==', ['get', 'kind'], 'farm'],
      paint: {
        'fill-color': ['match', ['get', 'palette'], 0, '#c8d3a3', 1, '#d7d19a', 2, '#b7ca9e', '#d0d2aa'],
        'fill-opacity': fadeIn(9.5, 0.9),
        'fill-outline-color': '#aebd8e',
      },
    },
    {
      id: 'superblocks', type: 'fill', source: 'blocks', minzoom: 9.5,
      filter: ['==', ['get', 'kind'], 'superblock'],
      paint: {
        'fill-color': ['match', ['get', 'zone'],
          'beverly', '#d8d2c3',
          'st-germain', '#d5d0c4',
          'harlem', '#d6cfbf',
          'uptown', '#d3cdbf',
          'brooklyn', '#d7d0c0',
          '#d8d2c3',
        ],
        'fill-opacity': fadeIn(9.5, 0.75),
      },
    },
    {
      id: 'parks-fill', type: 'fill', source: 'parks', minzoom: 9.5,
      paint: { 'fill-color': '#b8d7bd', 'fill-opacity': fadeIn(9.5, 0.96) },
    },
    {
      id: 'lake-fill', type: 'fill', source: 'surface', minzoom: 9.5,
      filter: ['==', ['get', 'kind'], 'lake'],
      paint: { 'fill-color': '#93c8d6', 'fill-opacity': fadeIn(9.5, 0.95) },
    },
    {
      id: 'parks-outline', type: 'line', source: 'parks', minzoom: 9.5,
      paint: { 'line-color': '#7ba889', 'line-width': 1.2, 'line-opacity': fadeIn(9.5) },
    },
    {
      id: 'blocks-fill', type: 'fill', source: 'blocks', minzoom: 11.5,
      filter: ['any', ['==', ['get', 'kind'], 'block'], ['==', ['get', 'kind'], 'plaza']],
      paint: {
        'fill-color': ['case', ['==', ['get', 'kind'], 'plaza'], '#e9e2d3',
          ['match', ['get', 'zone'],
            'financial', '#d2c5ae',
            'reclamation', '#d2c9ba',
            'grid', '#d8d0c1',
            'warehouse', '#d4c8b4',
            'landmark', '#d7cebd',
            '#d7cfbe',
          ],
        ],
        'fill-opacity': fadeIn(11.5, 0.92),
        'fill-outline-color': '#c6bda9',
      },
    },
    {
      id: 'piers', type: 'fill', source: 'surface', minzoom: 11.5,
      filter: ['==', ['get', 'kind'], 'pier'],
      paint: { 'fill-color': '#b29a7a', 'fill-opacity': fadeIn(11.5, 0.95), 'fill-outline-color': '#8d765d' },
    },
    {
      id: 'highway-casing', type: 'line', source: 'roads', minzoom: 7.2,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fffdf8', 'line-width': highwayCasing, 'line-opacity': 0.97 },
    },
    {
      id: 'highways', type: 'line', source: 'roads', minzoom: 7.2,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#bd8260', 'line-width': highwayWidth, 'line-opacity': 0.94 },
    },
    {
      id: 'arterial-casing', type: 'line', source: 'roads', minzoom: 9.5,
      filter: ['==', ['get', 'class'], 'arterial'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fffdf8', 'line-width': arterialCasing, 'line-opacity': fadeIn(9.5, 0.97) },
    },
    {
      id: 'arterials', type: 'line', source: 'roads', minzoom: 9.5,
      filter: ['==', ['get', 'class'], 'arterial'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'name'], ''], '#c9b99d', '#d0ad82'],
        'line-width': arterialWidth,
        'line-opacity': fadeIn(9.5, 0.94),
      },
    },
    {
      id: 'metro-lines', type: 'line', source: 'metro_lines', minzoom: 7.2,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2, 11, 3.2, 14, 4, 18, 6],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.93, 13.5, 0.93, 14, 0.6],
      },
    },
    {
      id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings', minzoom: 12,
      paint: {
        'fill-extrusion-color': buildingColorExpression(selectedId),
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'height']],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'base']],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'trees-3d', type: 'fill-extrusion', source: 'trees', minzoom: 13.5,
      paint: {
        'fill-extrusion-color': '#7fae7a',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14, ['get', 'h']],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': fadeIn(13.5),
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'transfer-stations', type: 'circle', source: 'metro_stations', minzoom: 7.2,
      filter: ['==', ['get', 'transfer'], 1],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 11],
        'circle-color': '#fffefa',
        'circle-stroke-color': '#183d4b',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 3],
      },
    },
    {
      id: 'normal-stations', type: 'circle', source: 'metro_stations', minzoom: 9.5,
      filter: ['==', ['get', 'transfer'], 0],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 8],
        'circle-color': '#fffefa',
        'circle-stroke-color': '#536d72',
        'circle-stroke-width': 2,
        'circle-opacity': fadeIn(9.5),
        'circle-stroke-opacity': fadeIn(9.5),
      },
    },
    {
      id: 'landmark-markers', type: 'circle', source: 'pois', minzoom: 9.5,
      filter: ['==', ['get', 'category'], '地标'],
      paint: {
        'circle-radius': 6.3,
        'circle-color': ['case', ['==', ['get', 'id'], 'continental-tower'], '#b56b48', '#687f83'],
        'circle-stroke-color': '#fffefa',
        'circle-stroke-width': 1.8,
        'circle-opacity': fadeIn(9.5),
        'circle-stroke-opacity': fadeIn(9.5),
      },
    },
    {
      id: 'other-place-markers', type: 'circle', source: 'pois', minzoom: 12.5,
      filter: ['!=', ['get', 'category'], '地标'],
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#536d72',
        'circle-stroke-width': 1.6,
        'circle-opacity': fadeIn(12.5),
        'circle-stroke-opacity': fadeIn(12.5),
      },
    },
    {
      id: 'district-labels', type: 'symbol', source: 'labels', minzoom: 7.2, maxzoom: 13,
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
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 1, 13, 0],
      },
    },
    {
      id: 'road-labels', type: 'symbol', source: 'roads', minzoom: 12.5,
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
        'text-opacity': fadeIn(12.5),
      },
    },
    {
      id: 'landmark-labels', type: 'symbol', source: 'annotations', minzoom: 9.5,
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
        'text-opacity': fadeIn(9.5),
      },
    },
    {
      id: 'station-labels', type: 'symbol', source: 'annotations', minzoom: 11.5,
      filter: ['==', ['get', 'annotationType'], 'station'],
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
        'text-offset': [0, 1.2], 'text-anchor': 'top', 'symbol-sort-key': ['get', 'priority'],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#2d4b55',
        'text-halo-color': '#fff',
        'text-halo-width': 1.3,
        'text-opacity': fadeIn(11.5),
      },
    },
    {
      id: 'other-place-labels', type: 'symbol', source: 'annotations', minzoom: 12.5,
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
        'text-opacity': fadeIn(12.5),
      },
    },
  ];
  const parkLabels: LayerSpecification = {
    id: 'park-labels', type: 'symbol', source: 'parks', minzoom: 9.5,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11,
      'symbol-sort-key': 40, 'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#42694b',
      'text-halo-color': '#edf5eb',
      'text-halo-width': 1.2,
      'text-opacity': fadeIn(9.5),
    },
  };
  const priorityOrder = ['road-labels', 'park-labels', 'other-place-labels', 'station-labels', 'landmark-labels'];
  layers.push(parkLabels);
  const priorityLayers = priorityOrder.map((id) => layers.find((layer) => layer.id === id)!)
    .filter(Boolean);
  layers.splice(0, layers.length, ...layers.filter((layer) => !priorityOrder.includes(layer.id)), ...priorityLayers);

  return {
    version: 8,
    glyphs: baseUrl + 'fonts/{fontstack}/{range}.pbf',
    light: { anchor: 'map', position: [1.4, 215, 42], intensity: 0.42, color: '#fff4e2' },
    sky: {
      'sky-color': '#bcd6e8',
      'horizon-color': '#f4ece0',
      'fog-color': '#eef0ec',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.55,
      'atmosphere-blend': 0,
    },
    sources: sourceData(datasets),
    layers,
  };
}
