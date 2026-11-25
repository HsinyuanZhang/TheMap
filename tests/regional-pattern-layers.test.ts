import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyMapDatasets } from '../src/dataset-loader';
import { createMapStyle } from '../src/map-style';
import { regionalBlockPatternIds } from '../src/block-patterns';
import { deferRegionalPatternLayers, registerRegionalPatternsBeforeLayers } from '../src/regional-pattern-layers';

test('regional Canvas images are installed before their layers on initial load and retries', () => {
  const sourceStyle = createMapStyle('/', emptyMapDatasets());
  const textureIndex = sourceStyle.layers.findIndex((layer) => layer.id === 'superblock-texture');
  const expectedBefore = sourceStyle.layers[textureIndex + 1]?.id;
  const deferred = deferRegionalPatternLayers(sourceStyle);
  assert.ok(textureIndex >= 0);
  assert.ok(!deferred.style.layers.some((layer) => layer.id === 'superblock-texture'));

  const images = new Set<string>();
  const layers = new Set(deferred.style.layers.map((layer) => layer.id));
  const events: string[] = [];
  const beforeIds: Array<string | undefined> = [];
  const map = {
    hasImage: (id: string) => images.has(id),
    addImage: (id: string) => { events.push(`image:${id}`); images.add(id); },
    getLayer: (id: string) => layers.has(id) ? { id } : undefined,
    addLayer: (layer: { id: string }, beforeId?: string) => {
      events.push(`layer:${layer.id}`);
      beforeIds.push(beforeId);
      layers.add(layer.id);
    },
  } as unknown as Parameters<typeof registerRegionalPatternsBeforeLayers>[0];
  const imageFactory = () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) as ImageData;
  const install = (): void => {
    assert.equal(registerRegionalPatternsBeforeLayers(map, deferred.layers, imageFactory), true);
    const layerEvent = events.indexOf('layer:superblock-texture');
    assert.ok(layerEvent >= 0);
    for (const id of regionalBlockPatternIds) assert.ok(events.indexOf(`image:${id}`) < layerEvent);
    assert.equal(beforeIds.at(-1), expectedBefore);
  };

  install();
  assert.equal(registerRegionalPatternsBeforeLayers(map, deferred.layers, imageFactory), true);
  assert.equal(events.filter((event) => event === 'layer:superblock-texture').length, 1);
  images.clear();
  layers.delete('superblock-texture');
  events.length = 0;
  beforeIds.length = 0;
  install();

  images.clear();
  layers.delete('superblock-texture');
  events.length = 0;
  assert.equal(registerRegionalPatternsBeforeLayers(map, deferred.layers, () => undefined), false);
  assert.ok(!layers.has('superblock-texture'));
  assert.deepEqual(events, []);
});
