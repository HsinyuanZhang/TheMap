export const MAP_LOD = {
  far: { min: 0, max: 10 },
  mid: { min: 10, max: 12 },
  near: { min: 12, max: 14 },
  close: { min: 14, max: 24 },
} as const;

export const MAP_ZOOM = {
  metro: 7, region: 7.2, woods: 8.5, parks: 9.5, blocks: MAP_LOD.mid.min,
  farms: 11, texture: 11.5, extrusion: MAP_LOD.near.min, contours: 13,
  districtLabelEnd: 13, flat: 13.5, detailLabels: 13.5, flatFull: 13.8,
  duplicateLabels: MAP_LOD.close.min,
  surfaceFadeStart: 11, surfaceFadeEnd: MAP_LOD.near.min, fadeSpan: 0.5,
} as const;
