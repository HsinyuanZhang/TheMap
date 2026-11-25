export type LayerGroup = 'metro' | 'roads' | 'buildings' | 'places';

export const layerIds = {
  metro: ['metro-lines', 'transfer-stations', 'normal-stations', 'station-labels', 'duplicate-station-labels'],
  roads: ['highway-casing', 'highways', 'arterial-casing', 'arterials', 'local-roads', 'rural-roads', 'road-labels'],
  buildings: ['building-shadows-low', 'building-shadows-high', 'buildings-flat', 'buildings-3d', 'trees-3d'],
  places: ['landmark-markers', 'historic-markers', 'other-place-markers', 'park-labels', 'landmark-labels', 'other-place-labels'],
} as const satisfies Record<LayerGroup, readonly string[]>;
