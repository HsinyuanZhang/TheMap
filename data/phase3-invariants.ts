export interface BuildingSegmentInvariant {
  base: unknown;
  top: unknown;
}

export function isNumericBuildingKey(value: unknown): value is 0 | 1 {
  return typeof value === 'number' && (value === 0 || value === 1);
}

export function hasGroundFootprintAtBidTop(segments: readonly BuildingSegmentInvariant[]): boolean {
  const bidTop = Math.max(...segments.map((segment) => typeof segment.top === 'number' ? segment.top : Number.NEGATIVE_INFINITY));
  return Number.isFinite(bidTop)
    && segments.some((segment) => segment.base === 0)
    && segments.filter((segment) => segment.base === 0).every((segment) => segment.top === bidTop);
}
