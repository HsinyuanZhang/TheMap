import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { emptyMapDatasets } from '../src/dataset-loader';
import { MAP_LEGEND_ITEMS, MAP_PALETTE, blockTypeColorExpression, buildingColorExpression, createMapStyle, createPointAnnotations } from '../src/map-style';
import { regionalBlockPatternIds } from '../src/block-patterns';

function layerFilter(layer: ReturnType<typeof createMapStyle>['layers'][number] | undefined): unknown {
  return layer && 'filter' in layer ? layer.filter : undefined;
}

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
  for (const name of ['land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois', 'blocks', 'boundaries', 'labels', 'trees', 'surface', 'terrain', 'overview']) {
    assert.equal(style.sources[name]?.type, 'geojson', name);
  }
  const layers = style.layers.map((layer) => layer.id);
  assert.ok(layers.indexOf('coastline-shallows') < layers.indexOf('land-fill'));
  assert.ok(layers.indexOf('parks-fill') < layers.indexOf('lake-fill'));
  assert.ok(layers.includes('north-border'));
  assert.equal(layers.includes('streets'), false);
  assert.ok(layers.includes('terrain-bands'));
  assert.ok(layers.includes('overview-woods'));
  assert.ok(layers.includes('terrain-contours'));
  assert.ok(layers.indexOf('road-labels') < layers.indexOf('park-labels'));
  assert.ok(layers.indexOf('park-labels') < layers.indexOf('other-place-labels'));
  assert.ok(layers.indexOf('other-place-labels') < layers.indexOf('station-labels'));
  assert.ok(layers.indexOf('station-labels') < layers.indexOf('landmark-labels'));
  const districtLabels = style.layers.find((layer) => layer.id === 'district-labels');
  const northBorder = style.layers.find((layer) => layer.id === 'north-border');
  const terrainBands = style.layers.find((layer) => layer.id === 'terrain-bands');
  const terrainContours = style.layers.find((layer) => layer.id === 'terrain-contours');
  const terrainContourLabels = style.layers.find((layer) => layer.id === 'terrain-contour-labels');
  const farms = style.layers.find((layer) => layer.id === 'farms');
  const woods = style.layers.find((layer) => layer.id === 'overview-woods');
  assert.equal(districtLabels && districtLabels.type !== 'background' ? districtLabels.source : undefined, 'labels');
  assert.equal(northBorder && northBorder.type !== 'background' ? northBorder.source : undefined, 'boundaries');
  assert.deepEqual(layerFilter(terrainBands), ['==', ['get', 'kind'], 'band']);
  assert.deepEqual(layerFilter(terrainContours), ['==', ['get', 'kind'], 'contour']);
  assert.deepEqual(layerFilter(terrainContourLabels), ['==', ['get', 'kind'], 'contour']);
  assert.deepEqual(terrainContourLabels?.type === 'symbol' ? terrainContourLabels.layout?.['text-field'] : undefined,
    ['concat', ['to-string', ['get', 'level']], ' m']);
  assert.deepEqual(layerFilter(farms), ['==', ['get', 'kind'], 'farm']);
  assert.deepEqual(farms?.type === 'fill' ? farms.paint?.['fill-color'] : undefined,
    ['match', ['get', 'tone'], 0, ...MAP_PALETTE.farmTones.slice(0, 1), 1, ...MAP_PALETTE.farmTones.slice(1, 2),
      2, ...MAP_PALETTE.farmTones.slice(2, 3), 3, ...MAP_PALETTE.farmTones.slice(3, 4), MAP_PALETTE.farmTones[0]]);
  assert.deepEqual(layerFilter(woods), ['==', ['get', 'kind'], 'wood']);
});

test('rendering layers use the requested LOD and building-height expressions', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  assert.equal(byId.get('highways')?.minzoom, 7.2);
  assert.equal(byId.get('overview-woods')?.minzoom, 8.5);
  assert.equal(byId.get('farms')?.minzoom, 11);
  const bands = byId.get('terrain-bands');
  assert.ok(bands?.type === 'fill');
  assert.equal(bands.source, 'overview');
  assert.equal(byId.get('terrain-bands')?.minzoom, 10);
  assert.equal(byId.get('terrain-contours')?.minzoom, 12.5);
  assert.equal(byId.get('parks-fill')?.minzoom, 9.5);
  assert.equal(byId.get('blocks-fill')?.minzoom, 10);
  assert.equal(byId.get('superblocks')?.minzoom, 10);
  assert.equal(byId.get('town-blocks-fill')?.minzoom, 10);
  assert.equal(byId.get('rural-roads')?.minzoom, 11);
  assert.equal(byId.get('buildings-3d')?.minzoom, 12);
  assert.equal(byId.get('buildings-flat')?.minzoom, 13.2);
  assert.equal(byId.get('buildings-flat')?.maxzoom, undefined);
  assert.equal(byId.get('trees-3d')?.minzoom, 13.5);
  assert.equal(byId.get('district-labels')?.maxzoom, 13);
  assert.equal(byId.get('park-labels')?.minzoom, 9.5);
  assert.equal(byId.get('landmark-labels')?.minzoom, 9.5);
  assert.equal(byId.get('station-labels')?.minzoom, 11.5);
  assert.equal(byId.get('other-place-labels')?.minzoom, 12.5);
  const candidate = byId.get('buildings-3d');
  assert.equal(candidate?.type, 'fill-extrusion');
  const buildings = candidate?.type === 'fill-extrusion' ? candidate : undefined;
  assert.deepEqual(buildings?.filter, ['==', ['get', 'key'], 1]);
  assert.equal(buildings?.layout?.visibility, 'none');
  assert.deepEqual(buildings?.paint?.['fill-extrusion-height'], ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'height']]);
  assert.deepEqual(buildings?.paint?.['fill-extrusion-base'], ['interpolate', ['linear'], ['zoom'], 12, 0, 13, ['get', 'base']]);
  assert.equal(buildings?.paint?.['fill-extrusion-opacity'], 1);
  assert.equal(buildings?.paint?.['fill-extrusion-vertical-gradient'], true);
  const flat = byId.get('buildings-flat');
  assert.equal(flat?.type, 'fill');
  assert.deepEqual(flat?.filter, ['==', ['get', 'base'], 0]);
  assert.deepEqual(flat?.paint?.['fill-opacity'], ['interpolate', ['linear'], ['zoom'], 13.2, 0, 13.7, 1]);
  assert.equal(flat?.paint?.['fill-outline-color'], '#a99f8b');
  assert.deepEqual(flat?.paint?.['fill-color'], buildingColorExpression(undefined));
  const shadow = byId.get('building-shadows-high');
  assert.ok(shadow?.type === 'fill');
  assert.equal(shadow.minzoom, 13.2);
  assert.deepEqual(shadow.paint?.['fill-opacity'], ['interpolate', ['linear'], ['zoom'], 13.2, 0, 13.7, 0.3]);
  assert.deepEqual(shadow.paint?.['fill-translate'], ['interpolate', ['linear'], ['zoom'],
    13.2, ['literal', [0, 0]], 16, ['literal', [7, 7]], 20, ['literal', [9, 9]]]);
  assert.equal(shadow.paint?.['fill-translate-anchor'], 'map');
  const lowShadow = byId.get('building-shadows-low');
  assert.ok(lowShadow?.type === 'fill');
  assert.equal(lowShadow.minzoom, 13.2);
  assert.deepEqual(lowShadow.paint?.['fill-opacity'], ['interpolate', ['linear'], ['zoom'], 13.2, 0, 13.7, 0.22]);
  assert.deepEqual(lowShadow.paint?.['fill-translate'], ['interpolate', ['linear'], ['zoom'],
    13.2, ['literal', [0, 0]], 16, ['literal', [3, 3]], 20, ['literal', [5, 5]]]);
  const blockFill = byId.get('blocks-fill');
  assert.ok(blockFill?.type === 'fill');
  assert.deepEqual(blockFill.paint?.['fill-color'], blockTypeColorExpression());
  assert.equal(blockFill.paint?.['fill-outline-color'], '#bfb49d');
  const superblocks = byId.get('superblocks');
  assert.ok(superblocks?.type === 'fill');
  assert.deepEqual(superblocks.paint?.['fill-color'], blockTypeColorExpression());
  const townBlocks = byId.get('town-blocks-fill');
  assert.ok(townBlocks?.type === 'fill');
  assert.deepEqual(townBlocks.paint?.['fill-color'], blockTypeColorExpression());
  assert.equal(byId.get('trees-3d')?.layout?.visibility, 'none');
});

test('block and building palettes match the legend and distinguish named landmarks from monuments', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  const swatches = new Map<string, string>();
  for (const item of MAP_LEGEND_ITEMS) swatches.set(item.label, item.swatch);
  for (const type of ['highrise', 'midrise', 'lowrise', 'lowdensity', 'town', 'plaza'] as const) {
    const label = { highrise: '高层区', midrise: '中层区', lowrise: '低层密集', lowdensity: '低密度住宅', town: '小城镇', plaza: '广场' }[type];
    assert.equal(swatches.get(label), MAP_PALETTE.blockTypes[type]);
  }
  const buildingColor = buildingColorExpression(undefined) as unknown[];
  assert.deepEqual(buildingColor.slice(0, 7), [
    'case', ['==', ['get', 'id'], 'continental-tower'], '#b56b48',
    ['==', ['get', 'kind'], 'monument'], '#a8734f',
    ['==', ['get', 'kind'], 'landmark'], '#6f8791',
  ]);
  assert.deepEqual(buildingColor.at(7), ['step', ['get', 'top'], '#eee6d6', 45, '#dccfb6', 90, '#c3c9c9', 150, '#9fb1bc']);
  assert.ok(swatches.has('地形色带') && swatches.has('树林') && swatches.has('农田') && swatches.has('军事区'));
  assert.ok(swatches.has('其他地标') && swatches.has('历史古迹') && swatches.has('大陆集团大厦'));
  assert.equal(swatches.get('楼房（高度分色）'),
    'linear-gradient(90deg, #eee6d6, #dccfb6, #c3c9c9, #9fb1bc)');
  assert.equal(swatches.has('重点建筑（高度分色）'), false);
  for (const line of ['U1', 'U2', 'U3'] as const) {
    assert.equal(swatches.get(`地铁 ${line}`), MAP_PALETTE.metroLines[line]);
  }
  assert.equal(swatches.get('城区边界'), MAP_PALETTE.districtBoundary);
  assert.equal(swatches.get('保留地虚线边界'), MAP_PALETTE.boundary);
  const districtLegend = MAP_LEGEND_ITEMS.find((item) => item.label === '城区边界');
  assert.ok(districtLegend && 'symbol' in districtLegend);
  assert.equal(districtLegend.symbol, 'solid-line');
  const reserveLegend = MAP_LEGEND_ITEMS.find((item) => item.label === '保留地虚线边界');
  assert.ok(reserveLegend && 'symbol' in reserveLegend);
  assert.equal(reserveLegend.symbol, 'dashed-line');
  const metroLayer = byId.get('metro-lines');
  assert.ok(metroLayer?.type === 'line');
  assert.deepEqual(metroLayer.paint?.['line-color'], ['match', ['get', 'id'],
    'U1', '#D32F2F', 'U2', '#1976D2', 'U3', '#388E3C', ['get', 'color']]);
  const districtBoundary = byId.get('district-boundaries');
  assert.ok(districtBoundary?.type === 'line');
  assert.equal(districtBoundary.paint?.['line-color'], MAP_PALETTE.districtBoundary);
  const reserveBoundary = byId.get('north-border');
  assert.ok(reserveBoundary?.type === 'line');
  assert.equal(reserveBoundary.paint?.['line-color'], MAP_PALETTE.boundary);
  assert.deepEqual(reserveBoundary.paint?.['line-dasharray'], [2, 1.3]);
  const historicMarkers = byId.get('historic-markers');
  assert.ok(historicMarkers?.type === 'circle');
  assert.deepEqual(historicMarkers.filter, ['==', ['get', 'category'], '古迹']);
  assert.equal(historicMarkers.paint?.['circle-color'], MAP_PALETTE.monument);
  const landmarkMarkers = byId.get('landmark-markers');
  assert.ok(landmarkMarkers?.type === 'circle');
  assert.deepEqual(landmarkMarkers.paint?.['circle-color'],
    ['case', ['==', ['get', 'id'], 'continental-tower'], MAP_PALETTE.continental, MAP_PALETTE.landmark]);
  const selected = buildingColorExpression('church') as unknown[];
  assert.deepEqual(selected.slice(0, 3), ['case', ['==', ['get', 'id'], 'church'], '#f2c66d']);
  assert.deepEqual(selected[3], buildingColorExpression(undefined));
});

test('regional superblock texture uses generated canvas pattern images at the specified LOD', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const texture = style.layers.find((layer) => layer.id === 'superblock-texture');
  assert.ok(texture?.type === 'fill');
  assert.equal(texture.minzoom, 11.5);
  assert.deepEqual(texture.filter, ['all', ['==', ['get', 'kind'], 'superblock'],
    ['in', ['get', 'type'], ['literal', ['lowrise', 'midrise']]]]);
  assert.deepEqual(texture.paint?.['fill-pattern'], ['match', ['get', 'type'],
    'midrise', 'regional-midrise-pattern', 'regional-lowrise-pattern']);
  assert.deepEqual([...regionalBlockPatternIds].sort(), ['regional-lowrise-pattern', 'regional-midrise-pattern']);
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
    ['farms', 'fill-opacity', 11, 0.9],
    ['town-blocks-fill', 'fill-opacity', 10, 1],
    ['rural-roads', 'line-opacity', 11, 0.82],
    ['superblocks', 'fill-opacity', 10, 1],
    ['superblock-texture', 'fill-opacity', 11.5, 0.32],
    ['parks-fill', 'fill-opacity', 9.5, 0.96],
    ['lake-fill', 'fill-opacity', 9.5, 0.95],
    ['parks-outline', 'line-opacity', 9.5, 1],
    ['blocks-fill', 'fill-opacity', 10, 1],
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

test('landmark-matching station labels move to the zoom-14 layer without hiding station dots', () => {
  const datasets = emptyMapDatasets();
  datasets.pois.features.push({
    type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { id: 'landmark', name: '地标', category: '地标' },
  });
  datasets.metro_stations.features.push({
    type: 'Feature', geometry: { type: 'Point', coordinates: [0.1, 0] },
    properties: { id: 'matching-station', name: '地标', transfer: 0 },
  });
  const style = createMapStyle('/', datasets);
  const annotationSource = style.sources.annotations;
  if (annotationSource?.type !== 'geojson') throw new Error('annotations source must be GeoJSON');
  const annotations = annotationSource.data as unknown as { features: Array<{ properties?: Record<string, unknown> }> };
  const station = annotations.features.find((item) => item.properties?.id === 'matching-station');
  assert.equal(station?.properties?.duplicateLandmarkLabel, 1);
  const ordinary = style.layers.find((layer) => layer.id === 'station-labels');
  const duplicate = style.layers.find((layer) => layer.id === 'duplicate-station-labels');
  assert.ok(ordinary?.type === 'symbol' && duplicate?.type === 'symbol');
  assert.equal(ordinary.minzoom, 11.5);
  assert.equal(duplicate.minzoom, 14);
  assert.ok(style.layers.some((layer) => layer.id === 'normal-stations'));
});
