import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyMapDatasets } from '../src/dataset-loader';
import { MAP_LIGHT, shadowOffset } from '../src/map-light';
import { MAP_LOD, MAP_ZOOM } from '../src/map-lod';
import { createMapStyle } from '../src/map-style';

test('four contiguous LOD tiers preserve required thresholds', () => {
  const tiers = Object.values(MAP_LOD);
  assert.equal(tiers.length, 4);
  for (let index = 1; index < tiers.length; index += 1) assert.equal(tiers[index - 1]!.max, tiers[index]!.min);
  assert.equal(MAP_ZOOM.woods, 8.5);
  assert.equal(MAP_ZOOM.contours, 12.5);
  assert.equal(MAP_ZOOM.flat, 13.2);
  assert.equal(MAP_ZOOM.flatFull, 13.7);
  const style = createMapStyle('/', emptyMapDatasets());
  const layers = new Map(style.layers.map((layer) => [layer.id, layer]));
  const blocks = layers.get('blocks-fill');
  assert.ok(blocks?.type === 'fill');
  assert.deepEqual(blocks.paint?.['fill-opacity'], ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1]);
});

test('local textures, northwest light, water shelf and neighbor opacity have explicit styles', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const layers = new Map(style.layers.map((layer) => [layer.id, layer]));
  assert.ok(MAP_LIGHT.east < 0 && MAP_LIGHT.north > 0);
  assert.deepEqual(shadowOffset(7), [7, 7]);
  assert.deepEqual(shadowOffset(-0.7), [-0.7, -0.7]);
  const land = layers.get('land-fill');
  assert.ok(land?.type === 'fill');
  assert.deepEqual(land.paint?.['fill-opacity'], ['match', ['get', 'kind'], ['ottoman', 'east-region'], 0.4, 1]);
  const furrows = layers.get('farm-furrows');
  assert.ok(furrows?.type === 'fill');
  assert.deepEqual(furrows.paint?.['fill-pattern'], ['match', ['get', 'furrow'], 'north', 'furrow-north-pattern', 'furrow-east-pattern']);
  for (const id of ['coastal-shelf', 'coastline-shallows', 'wood-canopy', 'contour-shade']) assert.ok(layers.has(id));
  assert.ok(style.layers.findIndex((layer) => layer.id === 'coastline-shallows') < style.layers.findIndex((layer) => layer.id === 'land-fill'));
});
