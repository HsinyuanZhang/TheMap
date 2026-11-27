export type LayerGroup = 'metro' | 'roads' | 'buildings' | 'places';

export const layerIds = {
  metro: ['metro-casing', 'metro-lines', 'transfer-stations', 'normal-stations', 'station-labels', 'transfer-station-labels', 'metro-badges'],
  roads: ['highway-casing', 'highways', 'arterial-casing', 'arterials', 'local-roads-casing', 'rural-roads-casing', 'local-roads', 'rural-roads', 'highway-centerline', 'highway-shields', 'road-labels'],
  buildings: ['building-shadows-low', 'building-shadows-high', 'buildings-flat', 'buildings-3d', 'trees-3d'],
  places: ['overview-place-labels', 'park-labels', 'landmark-labels', 'other-place-labels'],
} as const satisfies Record<LayerGroup, readonly string[]>;
