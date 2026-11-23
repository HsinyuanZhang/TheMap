import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { emptyMapDatasets } from '../src/dataset-loader';
import { createMapStyle, createPointAnnotations } from '../src/map-style';

function opacityAtZoom(value: unknown, zoom: number): number {
  assert.ok(Array.isArray(value));
  assert.equal(value[0], 'interpolate');
  assert.ok(Array.isArray(value[1]) && value[1][0] === 'linear');
  assert.ok(Array.isArray(value[2]) && value[2][0] === 'zoom');
  const stops = value.slice(3) as unknown[];
  for (let index = 0; index < stops.length - 2; index += 2) {
    const fromZoom = Number(stops[index]);
    const fromOpacity = Number(stops[index + 1]);
    const toZoom = Number(stops[index + 2]);
    const toOpacity = Number(stops[index + 3]);
    if (zoom <= fromZoom) return fromOpacity;
    if (zoom <= toZoom) return fromOpacity + ((zoom - fromZoom) / (toZoom - fromZoom)) * (toOpacity - fromOpacity);
  }
  return Number(stops.at(-1));
}

test('Phase 2 style validates against the installed MapLibre style specification', () => {
  const style = createMapStyle('/map/', emptyMapDatasets());
  const errors = validateStyleMin(style);
  assert.deepEqual(errors, [], errors.map((error) => error.message).join('\n'));
});

test('style includes local sky, light, generated borders, and all dataset sources', () => {
  const style = createMapStyle('/map/', emptyMapDatasets());
  assert.equal(style.glyphs, '/map/fonts/{fontstack}/{range}.pbf');
  assert.deepEqual(style.light, { anchor: 'map', position: [1.4, 215, 42], intensity: 0.42, color: '#fff4e2' });
  assert.deepEqual(style.sky, {
    'sky-color': '#bcd6e8',
    'horizon-color': '#f4ece0',
    'fog-color': '#eef0ec',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.55,
    'atmosphere-blend': 0,
  });
  for (const name of ['land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois', 'blocks', 'boundaries', 'labels', 'trees', 'surface']) {
    assert.equal(style.sources[name]?.type, 'geojson', name);
  }
  const layers = style.layers.map((layer) => layer.id);
  assert.ok(layers.indexOf('coastline-shallows') < layers.indexOf('land-fill'));
  assert.ok(layers.indexOf('parks-fill') < layers.indexOf('lake-fill'));
  assert.ok(layers.includes('north-border'));
  assert.equal(layers.includes('streets'), false);
  assert.ok(layers.indexOf('road-labels') < layers.indexOf('park-labels'));
  assert.ok(layers.indexOf('park-labels') < layers.indexOf('other-place-labels'));
  assert.ok(layers.indexOf('other-place-labels') < layers.indexOf('station-labels'));
  assert.ok(layers.indexOf('station-labels') < layers.indexOf('landmark-labels'));
  const districtLabels = style.layers.find((layer) => layer.id === 'district-labels');
  const northBorder = style.layers.find((layer) => layer.id === 'north-border');
  assert.equal(districtLabels && districtLabels.type !== 'background' ? districtLabels.source : undefined, 'labels');
  assert.equal(northBorder && northBorder.type !== 'background' ? northBorder.source : undefined, 'boundaries');
});

test('rendering layers use the requested LOD and building-height expressions', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  assert.equal(byId.get('highways')?.minzoom, 7.2);
  assert.equal(byId.get('parks-fill')?.minzoom, 9.5);
  assert.equal(byId.get('blocks-fill')?.minzoom, 11.5);
  assert.equal(byId.get('buildings-3d')?.minzoom, 12);
  assert.equal(byId.get('trees-3d')?.minzoom, 13.5);
  assert.equal(byId.get('district-labels')?.maxzoom, 13);
  assert.equal(byId.get('park-labels')?.minzoom, 9.5);
  assert.equal(byId.get('landmark-labels')?.minzoom, 9.5);
  assert.equal(byId.get('station-labels')?.minzoom, 11.5);
  assert.equal(byId.get('other-place-labels')?.minzoom, 12.5);
  const candidate = byId.get('buildings-3d');
  assert.equal(candidate?.type, 'fill-extrusion');
  const buildings = candidate?.type === 'fill-extrusion' ? candidate : undefined;
  assert.deepEqual(buildings?.paint?.['fill-extrusion-height'], ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'height']]);
  assert.deepEqual(buildings?.paint?.['fill-extrusion-base'], ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'base']]);
  assert.equal(buildings?.paint?.['fill-extrusion-opacity'], 1);
  assert.equal(buildings?.paint?.['fill-extrusion-vertical-gradient'], true);
  const blockFill = byId.get('blocks-fill');
  assert.ok(blockFill?.type === 'fill');
  assert.ok(JSON.stringify(blockFill.paint?.['fill-color']).includes('zone'));
});

test('park labels use one existing point annotation per park, not polygon placement', () => {
  const datasets = emptyMapDatasets();
  datasets.pois.features.push(
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { id: 'central-park', name: '中央公园', category: '公园' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: { id: 'battery-park', name: '炮台公园', category: '公园' },
    },
  );
  const style = createMapStyle('/', datasets);
  const parkLabels = style.layers.find((layer) => layer.id === 'park-labels');
  assert.ok(parkLabels?.type === 'symbol');
  assert.equal(parkLabels.source, 'annotations');
  assert.equal(parkLabels.minzoom, 9.5);
  assert.deepEqual(parkLabels.filter, [
    'all',
    ['==', ['get', 'annotationType'], 'place'],
    ['==', ['get', 'category'], '公园'],
  ]);
  assert.equal(style.layers.some((layer) => layer.type === 'symbol' && layer.source === 'parks'), false);

  const annotations = style.sources.annotations;
  assert.ok(annotations?.type === 'geojson');
  const data = annotations.data as unknown as { features: Array<{
    geometry: { type: string };
    properties?: Record<string, unknown>;
  }> };
  const parkPoints = data.features.filter((feature) =>
    feature.properties?.annotationType === 'place' && feature.properties?.category === '公园');
  assert.deepEqual(parkPoints.map((feature) => feature.properties?.id).sort(), ['battery-park', 'central-park']);
  assert.ok(parkPoints.every((feature) => feature.geometry.type === 'Point'));
});

test('new LOD appearances fade from zero over half a zoom level', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  const fades: Array<[string, string, number, number]> = [
    ['farms', 'fill-opacity', 9.5, 0.9],
    ['superblocks', 'fill-opacity', 9.5, 0.75],
    ['parks-fill', 'fill-opacity', 9.5, 0.96],
    ['lake-fill', 'fill-opacity', 9.5, 0.95],
    ['parks-outline', 'line-opacity', 9.5, 1],
    ['blocks-fill', 'fill-opacity', 11.5, 0.92],
    ['piers', 'fill-opacity', 11.5, 0.95],
    ['arterial-casing', 'line-opacity', 9.5, 0.97],
    ['arterials', 'line-opacity', 9.5, 0.94],
    ['trees-3d', 'fill-extrusion-opacity', 13.5, 1],
    ['normal-stations', 'circle-opacity', 9.5, 1],
    ['normal-stations', 'circle-stroke-opacity', 9.5, 1],
    ['landmark-markers', 'circle-opacity', 9.5, 1],
    ['landmark-markers', 'circle-stroke-opacity', 9.5, 1],
    ['other-place-markers', 'circle-opacity', 12.5, 1],
    ['other-place-markers', 'circle-stroke-opacity', 12.5, 1],
    ['road-labels', 'text-opacity', 12.5, 1],
    ['landmark-labels', 'text-opacity', 9.5, 1],
    ['station-labels', 'text-opacity', 11.5, 1],
    ['other-place-labels', 'text-opacity', 12.5, 1],
    ['park-labels', 'text-opacity', 9.5, 1],
  ];
  for (const [layerId, property, minZoom, target] of fades) {
    const layer = byId.get(layerId);
    assert.ok(layer && 'paint' in layer && layer.paint, layerId);
    const expression = (layer.paint as unknown as Record<string, unknown>)[property];
    assert.equal(opacityAtZoom(expression, minZoom), 0, `${layerId}.${property} at its LOD threshold`);
    assert.equal(opacityAtZoom(expression, minZoom + 0.5), target, `${layerId}.${property} after its fade`);
  }
});

test('point label annotations carry cross-layer collision priorities', () => {
  const datasets = emptyMapDatasets();
  datasets.pois.features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { id: 'landmark', name: '地标', category: '地标' },
  });
  datasets.pois.features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [1, 1] },
    properties: { id: 'place', name: '地点', category: '地点' },
  });
  datasets.metro_stations.features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [2, 2] },
    properties: { id: 'transfer', name: '换乘站', transfer: 1 },
  });
  datasets.metro_stations.features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [3, 3] },
    properties: { id: 'station', name: '普通站', transfer: 0 },
  });
  const annotations = createPointAnnotations(datasets);
  assert.deepEqual(
    annotations.features.map((feature) => [feature.properties?.id, feature.properties?.priority]),
    [['landmark', 1], ['place', 4], ['transfer', 2], ['station', 3]],
  );
});
