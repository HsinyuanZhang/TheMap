import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { datasetNames, emptyMapDatasets, type MapDatasets } from '../src/dataset-loader';
import { createMapStyle, createPointAnnotations } from '../src/map-style';
import { createHighwayShields, createMetroDisplay, createMetroEnds, displayLabels, tagManhattanGeometry, OVERVIEW_PLACES, METRO_COLORS, LOCAL_IDEOGRAPH_FONT } from '../src/map-overlays';
import { createLabelImage, labelImageIds, labelImageOptions } from '../src/map-label-images';
import { layerIds } from '../src/map-layer-groups';
import { toKm, segmentDistance } from '../src/world-model';
import { curvedBoundary, windingBoundary, polygonArea, closeRing } from '../data/geometry';
import { internalBoundaries } from '../data/source';

const data = Object.fromEntries(await Promise.all(datasetNames.map(async name => [name, JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'))]))) as MapDatasets;

test('Phase 4 style validates with real data; all road casings precede fills, highways above arterials, metro above roads', () => {
  const style = createMapStyle('/', data), layers = style.layers, ids = layers.map(l => l.id);
  assert.deepEqual(validateStyleMin(style), []);
  for (const casing of ['highway-casing', 'arterial-casing', 'rural-roads-casing', 'local-roads-casing']) for (const fill of ['highways', 'arterials', 'rural-roads', 'local-roads']) assert.ok(ids.indexOf(casing) < ids.indexOf(fill));
  assert.ok(ids.indexOf('highways') > ids.indexOf('arterials'));
  assert.ok(ids.indexOf('metro-casing') > ids.indexOf('highway-centerline'));
  assert.ok(ids.indexOf('metro-lines') > ids.indexOf('metro-casing'));
  assert.ok(ids.indexOf('district-labels') > ids.indexOf('metro-lines'));
  for (const [id, width, color, zoom] of [['highways', 3.6, '#f3b54a', 7.2], ['arterials', 1.9, '#fbf4e0', 9.5], ['local-roads', 1.2, '#f0e6c8', 11], ['rural-roads', 1.1, '#e9dcb8', 11]] as const) {
    const layer = layers.find(l => l.id === id); assert.ok(layer?.type === 'line');
    assert.equal(layer.minzoom, zoom); assert.equal(layer.paint?.['line-color'], color);
    const stops = layer.paint?.['line-width'] as unknown[];
    assert.equal(stops[4], width); assert.equal(stops[8], width * 3);
  }
});

test('highway shields are deterministic, lie on each route and are spaced at 8 km', () => {
  const shields = createHighwayShields(data.roads);
  assert.deepEqual(shields, createHighwayShields(data.roads));
  for (const id of ['A1', 'A2', 'A3']) {
    const road = data.roads.features.find(f => f.properties.id === id)!;
    assert.ok(road.geometry.type === 'LineString');
    const positions = road.geometry.coordinates.map(toKm), stops = shields.features.filter(f => f.properties.id === id);
    assert.ok(stops.length >= 3);
    stops.forEach((f, i) => {
      assert.equal(f.properties.distance, 4 + 8 * i); assert.ok(f.geometry.type === 'Point');
      const p = toKm(f.geometry.coordinates);
      assert.ok(Math.min(...positions.slice(1).map((b, j) => segmentDistance(...p, positions[j], b))) < 1e-8);
    });
  }
  assert.deepEqual(createHighwayShields(emptyMapDatasets().roads).features, []);
});

test('only common U1/U2 segments have opposite offsets; all metro parts toggle together', () => {
  const display = createMetroDisplay(data.metro_lines), ends = createMetroEnds(data.metro_lines);
  assert.deepEqual(display, createMetroDisplay(data.metro_lines)); assert.equal(ends.features.length, 6);
  for (const [id, offset] of [['U1', -1], ['U2', 1]] as const) assert.ok(display.features.some(f => f.properties.id === id && f.properties.offset === offset));
  assert.ok(display.features.filter(f => f.properties.id === 'U3').every(f => f.properties.offset === 0));
  const layers = createMapStyle('/', data).layers;
  for (const layer of layers) if ('source' in layer && ['metro-display', 'metro-ends', 'metro_stations'].includes(String(layer.source))) assert.ok((layerIds.metro as readonly string[]).includes(layer.id), layer.id);
  for (const id of ['station-labels', 'transfer-station-labels', 'metro-badges']) assert.ok((layerIds.metro as readonly string[]).includes(id));
  const line = layers.find(l => l.id === 'metro-lines'), casing = layers.find(l => l.id === 'metro-casing');
  assert.ok(line?.type === 'line' && casing?.type === 'line');
  assert.deepEqual(line.paint?.['line-width'], ['interpolate', ['linear'], ['zoom'], 7.2, 4, 12, 5.5]);
  assert.deepEqual(casing.paint?.['line-width'], ['interpolate', ['linear'], ['zoom'], 7.2, 7.2, 12, 8.7]);
  assert.deepEqual(line.paint?.['line-opacity'], ['step', ['zoom'], 1, 13.5, 0.75]);
  const normal = layers.find(l => l.id === 'normal-stations'); assert.ok(normal?.type === 'circle');
  assert.ok(JSON.stringify(normal.paint?.['circle-stroke-color']).includes(METRO_COLORS.U1));
  assert.deepEqual(createMetroDisplay(emptyMapDatasets().metro_lines).features, []);
  assert.deepEqual(createMetroEnds(emptyMapDatasets().metro_lines).features, []);
});

test('priority plates, serif districts, vertical Reserve label and airport key buildings follow Phase 4', () => {
  const style = createMapStyle('/', data), labels = style.layers.filter(l => l.type === 'symbol');
  const overview = labels.find(l => l.id === 'overview-place-labels'); assert.ok(overview?.type === 'symbol');
  assert.equal(overview.minzoom, 7.2); assert.equal(overview.layout?.['icon-text-fit'], 'both'); assert.equal(overview.paint?.['text-color'], '#f4ead1');
  const annotations = createPointAnnotations(data);
  assert.equal(annotations.features.filter(f => f.properties.annotationType === 'place' && (OVERVIEW_PLACES as readonly unknown[]).includes(f.properties.id)).length, 6);
  for (const id of OVERVIEW_PLACES) assert.ok(data.pois.features.some(f => f.properties.id === id));
  const district = labels.find(l => l.id === 'district-labels'); assert.ok(district?.type === 'symbol');
  assert.equal(district.maxzoom, 13); assert.equal(district.layout?.['text-letter-spacing'], 0.42); assert.ok(LOCAL_IDEOGRAPH_FONT.includes('serif'));
  const east = labels.find(l => l.id === 'reserve-east-label'); assert.ok(east?.type === 'symbol'); assert.deepEqual(east.layout?.['text-writing-mode'], ['vertical']);
  const hit = style.layers.find(l => l.id === 'airport-hit'); assert.ok(hit?.type === 'fill'); assert.equal(hit.paint?.['fill-opacity'], 0);
  const buildings = data.buildings.features.filter(f => f.properties.id === 'airport');
  assert.deepEqual(buildings.map(f => f.properties.height).sort((a, b) => Number(a) - Number(b)), [30, 60]); assert.ok(buildings.every(f => f.properties.key === 1));
});

test('shared metro detection tolerates different vertex sampling but not nearby parallel tracks or crossings', () => {
  const lines = emptyMapDatasets().metro_lines;
  const line = (id: string, coordinates: number[][]): typeof lines.features[number] => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { id } });
  lines.features = [line('U1', [[-150, 40], [-149.99, 40], [-149.98, 40]]), line('U2', [[-150, 40], [-149.98, 40]])];
  assert.ok(createMetroDisplay(lines).features.every(f => f.properties.offset !== 0));
  lines.features[1] = line('U2', [[-150, 40.00001], [-149.98, 40.00001]]);
  assert.ok(createMetroDisplay(lines).features.every(f => f.properties.offset === 0));
  lines.features[1] = line('U2', [[-149.99, 39.99], [-149.99, 40.01]]);
  assert.ok(createMetroDisplay(lines).features.every(f => f.properties.offset === 0));
});

test('flat geometry uses polygon metadata instead of unsupported polygon within expressions', () => {
  const tagged = tagManhattanGeometry(data.buildings, data.districts);
  assert.equal(tagged.features.length, data.buildings.features.length);
  assert.ok(tagged.features.filter(f => f.properties.flatManhattan === 1 && f.properties.base === 0).length > 8000);
  assert.ok(tagged.features.filter(f => ['airport', 'old-governors-house', 'city-hall'].includes(String(f.properties.id))).every(f => f.properties.flatManhattan === 0));
  assert.ok(tagged.features.filter(f => f.properties.id === 'continental-tower').every(f => f.properties.flatManhattan === 1));
  assert.ok(!('flatManhattan' in data.buildings.features[0].properties));
  assert.deepEqual(tagManhattanGeometry(emptyMapDatasets().buildings, data.districts).features, []);
  assert.ok(tagManhattanGeometry(data.buildings, emptyMapDatasets().districts).features.every(f => f.properties.flatManhattan === 0));
  const style = createMapStyle('/', data);
  for (const id of ['blocks-fill', 'building-shadows-low', 'building-shadows-high', 'buildings-flat']) {
    const layer = style.layers.find(l => l.id === id)!;
    assert.ok('filter' in layer && JSON.stringify(layer.filter).includes('flatManhattan'));
    assert.ok(!JSON.stringify(layer).includes('within'));
  }
});

test('neighbor annotations stay near the country and sea names use a valid italic font family', () => {
  const labels = displayLabels(data.labels);
  for (const [id, x, y] of [['ottoman', 18, 36], ['east-region', 43, 17.5]] as const) {
    const f = labels.features.find(f => f.properties.id === id)!; assert.ok(f.geometry.type === 'Point');
    const p = toKm(f.geometry.coordinates); assert.ok(Math.hypot(p[0] - x, p[1] - y) < 1e-8);
    assert.notDeepEqual(f.geometry, data.labels.features.find(f => f.properties.id === id)!.geometry);
  }
  assert.deepEqual(displayLabels(emptyMapDatasets().labels).features, []);
  const sea = createMapStyle('/', data).layers.find(l => l.id === 'sea-labels'); assert.ok(sea?.type === 'symbol');
  assert.deepEqual(sea.layout?.['text-font'], ['DejaVu Serif Italic', 'DejaVu Serif', 'serif']);
});

test('Canvas label images are local and stretchable; boundary meanders are visible at overview', () => {
  assert.equal(createLabelImage('unknown'), undefined); assert.equal(createLabelImage('highway-shield'), undefined);
  assert.ok(labelImageIds.includes('place-plate-transport'));
  for (const id of labelImageIds) {
    const o = labelImageOptions(id); assert.equal(o.pixelRatio, 2); assert.ok(o.stretchX[0][0] < o.stretchX[0][1]); assert.ok(o.stretchY[0][0] < o.stretchY[0][1]);
  }
  for (const id of ['st-germain-harlem', 'uptown-brooklyn', 'central-beverly', 'harlem-brooklyn']) {
    const path = internalBoundaries.find(b => b.id === id)!.coordinates;
    assert.ok(Math.max(...path.map(p => segmentDistance(...p, path[0], path.at(-1)!))) > 0.35, id);
  }
});


test('winding boundaries preserve reference signed area and reject invalid inputs', () => {
  const reference = curvedBoundary([0, 0], [13, 0], 0.2, 2.5);
  const path = windingBoundary([0, 0], [13, 0], 0.65, 2.5, reference);
  assert.ok(Math.abs(polygonArea(closeRing(reference)) - polygonArea(closeRing(path))) < 1e-9);
  assert.throws(() => windingBoundary([0, 0], [0, 0], 1, 0), /distinct endpoints/);
  assert.throws(() => windingBoundary([0, 0], [1, 0], NaN, 0), /finite offsets/);
});
