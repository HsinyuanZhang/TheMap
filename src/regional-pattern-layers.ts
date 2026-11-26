import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { createRegionalBlockPattern, regionalPatternIds } from './block-patterns';

type StyleLayer = StyleSpecification['layers'][number];

export interface DeferredPatternLayer {
  layer: StyleLayer;
  beforeId?: string;
}

type PatternMap = Pick<MapLibreMap, 'hasImage' | 'addImage' | 'getLayer' | 'addLayer'>;

const regionalPatternLayerIds = new Set(['superblock-texture', 'wood-canopy', 'farm-furrows', 'wood-clumps']);

export function deferRegionalPatternLayers(style: StyleSpecification): {
  style: StyleSpecification;
  layers: DeferredPatternLayer[];
} {
  const layers = style.layers.flatMap((layer, index) => regionalPatternLayerIds.has(layer.id)
    ? [{ layer, beforeId: style.layers.slice(index + 1).find((candidate) => !regionalPatternLayerIds.has(candidate.id))?.id }]
    : []);
  return {
    style: { ...style, layers: style.layers.filter((layer) => !regionalPatternLayerIds.has(layer.id)) },
    layers,
  };
}

export function registerRegionalPatternsBeforeLayers(
  map: PatternMap,
  layers: readonly DeferredPatternLayer[],
  imageFactory: (id: string) => ImageData | undefined = createRegionalBlockPattern,
): boolean {
  const images = regionalPatternIds.map((id) => ({ id, image: map.hasImage(id) ? undefined : imageFactory(id) }));
  if (images.some(({ id, image }) => !map.hasImage(id) && !image)) return false;
  for (const { id, image } of images) {
    if (image) map.addImage(id, image, { pixelRatio: 1 });
  }
  for (const { layer, beforeId } of layers) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId);
  }
  return true;
}
