import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMapRenderState, mapRenderState } from '../src/map-render-state';
import { emptyMapDatasets } from '../src/dataset-loader';
import { createMapStyle } from '../src/map-style';
import { layerIds } from '../src/map-layer-groups';

test('render state applies pitch, building visibility, all-building filters, and selection together', () => {
  const combinations = [
    { pitch: 0, visible: true, all: false, selectedId: 'church', flat: true, extrusions: false, trees: false, keyOnly: true },
    { pitch: 0, visible: true, all: true, selectedId: 'church', flat: true, extrusions: false, trees: false, keyOnly: false },
    { pitch: 9.9, visible: true, all: true, selectedId: 'republic-monument', flat: true, extrusions: false, trees: false, keyOnly: false },
    { pitch: 10, visible: true, all: false, selectedId: 'old-governors-house', flat: true, extrusions: true, trees: true, keyOnly: true },
    { pitch: 72, visible: true, all: true, selectedId: 'church', flat: true, extrusions: true, trees: true, keyOnly: false },
    { pitch: 72, visible: false, all: true, selectedId: undefined, flat: false, extrusions: false, trees: false, keyOnly: false },
  ];
  for (const input of combinations) {
    const state = mapRenderState(input.pitch, input.visible, input.all, input.selectedId);
    const operations: unknown[][] = [];
    applyMapRenderState({
      setVisibility: (layerId, visible) => operations.push(['visibility', layerId, visible]),
      setKeyOnly: (keyOnly) => operations.push(['keyOnly', keyOnly]),
      setSelectedBuildingColor: (layerId, selectedId) => operations.push(['selected', layerId, selectedId]),
    }, state);
    assert.deepEqual(state, {
      flatBuildings: input.flat, extrusions: input.extrusions, trees: input.trees,
      keyOnly: input.keyOnly, selectedId: input.selectedId,
    });
    assert.deepEqual(operations, [
      ['visibility', 'building-shadows-low', input.flat],
      ['visibility', 'building-shadows-high', input.flat],
      ['visibility', 'buildings-flat', input.flat],
      ['visibility', 'buildings-3d', input.extrusions],
      ['visibility', 'trees-3d', input.trees],
      ['keyOnly', input.keyOnly],
      ['selected', 'buildings-flat', input.selectedId],
      ['selected', 'buildings-3d', input.selectedId],
    ]);
  }
});

test('roads layer toggle covers each rendered road layer, including rural roads', () => {
  const style = createMapStyle('/', emptyMapDatasets());
  const renderedRoadLayers = style.layers
    .filter((layer) => 'source' in layer && layer.source === 'roads')
    .map((layer) => layer.id)
    .sort();
  assert.deepEqual([...layerIds.roads].sort(), renderedRoadLayers);
});
