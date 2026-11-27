import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyMapDatasets } from '../src/dataset-loader';
import { createMapStyle } from '../src/map-style';
import { labelImageIds } from '../src/map-label-images';
import { regionalPatternIds } from '../src/block-patterns';
import { deferRegionalPatternLayers, registerRegionalPatternsBeforeLayers } from '../src/regional-pattern-layers';

test('regional Canvas images are installed before their layers on initial load and retries', () => {
  const sourceStyle = createMapStyle('/', emptyMapDatasets());
  sourceStyle.layers.splice(1, 0,
    { id: 'wood-canopy', type: 'fill', source: 'surface', paint: { 'fill-pattern': 'canopy-pattern' } },
    { id: 'farm-furrows', type: 'fill', source: 'surface', paint: { 'fill-pattern': 'furrow-north-pattern' } });
  const textureIndex = sourceStyle.layers.findIndex((layer) => layer.id === 'farm-furrows');
  const expectedBefore = sourceStyle.layers[textureIndex + 1]?.id;
  const deferred = deferRegionalPatternLayers(sourceStyle);
  assert.ok(textureIndex >= 0);
  assert.ok(!deferred.style.layers.some((layer) => layer.id === 'farm-furrows'));
  for (const id of ['wood-canopy', 'farm-furrows']) {
    assert.ok(deferred.layers.some(({ layer }) => layer.id === id));
    assert.ok(!deferred.style.layers.some((layer) => layer.id === id));
  }

  for (const id of ['overview-place-labels', 'highway-shields', 'metro-badges']) assert.ok(!deferred.style.layers.some(layer => layer.id === id));
  const images = new Set<string>();
  const layers = new Set(deferred.style.layers.map((layer) => layer.id));
  const events: string[] = [];
  const beforeIds: Array<{ id: string; beforeId?: string }> = [];
  const map = {
    hasImage: (id: string) => images.has(id),
    addImage: (id: string) => { events.push(`image:${id}`); images.add(id); },
    getLayer: (id: string) => layers.has(id) ? { id } : undefined,
    addLayer: (layer: { id: string }, beforeId?: string) => {
      assert.ok(!beforeId || layers.has(beforeId));
      assert.ok(regionalPatternIds.every((id) => images.has(id)));
      events.push(`layer:${layer.id}`);
      beforeIds.push({ id: layer.id, beforeId });
      layers.add(layer.id);
    },
  } as unknown as Parameters<typeof registerRegionalPatternsBeforeLayers>[0];
  const imageFactory = () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) as ImageData;
  const install = (): void => {
    assert.equal(registerRegionalPatternsBeforeLayers(map, deferred.layers, imageFactory), true);
    const layerEvent = events.indexOf('layer:farm-furrows');
    assert.ok(layerEvent >= 0);
    for (const id of [...regionalPatternIds, ...labelImageIds]) assert.ok(events.indexOf(`image:${id}`) < events.findIndex((event) => event.startsWith('layer:')));
    assert.equal(beforeIds.find(item => item.id === 'farm-furrows')?.beforeId, expectedBefore);
  };

  install();
  assert.equal(registerRegionalPatternsBeforeLayers(map, deferred.layers, imageFactory), true);
  assert.equal(events.filter((event) => event === 'layer:farm-furrows').length, 1);
  images.clear();
  layers.delete('farm-furrows');
  events.length = 0;
  beforeIds.length = 0;
  install();

  images.clear();
  layers.delete('farm-furrows');
  events.length = 0;
  assert.equal(registerRegionalPatternsBeforeLayers(map, deferred.layers, () => undefined), false);
  assert.ok(!layers.has('farm-furrows'));
  assert.deepEqual(events, []);
});
