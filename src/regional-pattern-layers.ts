import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { createRegionalBlockPattern, regionalPatternIds } from './block-patterns';
import { createLabelImage, labelImageIds, labelImageOptions } from './map-label-images';

type StyleLayer = StyleSpecification['layers'][number];

export interface DeferredPatternLayer {
  layer: StyleLayer;
  beforeId?: string;
}

type PatternMap = Pick<MapLibreMap, 'hasImage' | 'addImage' | 'getLayer' | 'addLayer'>;

const regionalPatternLayerIds = new Set(['wood-canopy', 'farm-furrows']);
const needsImages = (layer: StyleLayer): boolean => regionalPatternLayerIds.has(layer.id) || layer.type === 'symbol' && !!layer.layout?.['icon-image'];

export function deferRegionalPatternLayers(style: StyleSpecification): {
  style: StyleSpecification;
  layers: DeferredPatternLayer[];
} {
  const layers = style.layers.flatMap((layer, index) => needsImages(layer)
    ? [{ layer, beforeId: style.layers.slice(index + 1).find((candidate) => !needsImages(candidate))?.id }]
    : []);
  return {
    style: { ...style, layers: style.layers.filter((layer) => !needsImages(layer)) },
    layers,
  };
}

export function registerRegionalPatternsBeforeLayers(
  map: PatternMap,
  layers: readonly DeferredPatternLayer[],
  imageFactory: (id: string) => ImageData | undefined = id => createLabelImage(id) ?? createRegionalBlockPattern(id),
): boolean {
  const images = [...regionalPatternIds, ...labelImageIds].map((id) => ({ id, image: map.hasImage(id) ? undefined : imageFactory(id) }));
  if (images.some(({ id, image }) => !map.hasImage(id) && !image)) return false;
  for (const { id, image } of images) {
    if (image) map.addImage(id, image, labelImageIds.includes(id) ? labelImageOptions(id) : { pixelRatio: 1 });
  }
  for (const { layer, beforeId } of layers) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId);
  }
  return true;
}
