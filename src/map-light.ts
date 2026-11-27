export const MAP_LIGHT = {
  east: -Math.SQRT1_2,
  north: Math.SQRT1_2,
  azimuth: 315,
  altitude: 42,
} as const;

export function shadowOffset(distance: number): [number, number] {
  return [Number((-MAP_LIGHT.east * Math.SQRT2 * distance).toFixed(6)), Number((MAP_LIGHT.north * Math.SQRT2 * distance).toFixed(6))];
}
