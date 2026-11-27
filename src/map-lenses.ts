import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { MAP_PALETTE } from './map-style';

export type MapLensId = 'standard' | 'transit' | 'buildings' | 'districts';

export interface MapLensDefinition {
  id: MapLensId;
  label: string;
  shortLabel: string;
  description: string;
  ramp: string;
}

export interface BuildingHeightBand {
  id: string;
  label: string;
  rangeText: string;
  color: string;
  minTop: number;
  maxTop: number;
}

export const MAP_LENSES: readonly MapLensDefinition[] = [
  {
    id: 'standard',
    label: '标准图志',
    shortLabel: '图志',
    description: '手绘丘陵地形、海岸浅水、街区肌理与城市地标全貌。',
    ramp: 'linear-gradient(90deg, #10345e, #557b42, #c1b48e, #f3b54a)',
  },
  {
    id: 'transit',
    label: '轨道交通',
    shortLabel: '轨交',
    description: '压暗底图肌理，突出地铁 U1 / U2 / U3 线路走向与换乘枢纽。',
    ramp: 'linear-gradient(90deg, #D32F2F 0 33%, #1976D2 33% 66%, #388E3C 66% 100%)',
  },
  {
    id: 'buildings',
    label: '建筑高度',
    shortLabel: '建筑',
    description: '按建筑高度分段着墨，点击下方色阶可单独高亮对应高度层级的楼宇与地标。',
    ramp: `linear-gradient(90deg, ${MAP_PALETTE.buildingHeights.low}, ${MAP_PALETTE.buildingHeights.medium}, ${MAP_PALETTE.buildingHeights.high}, ${MAP_PALETTE.buildingHeights.veryHigh}, ${MAP_PALETTE.continental})`,
  },
  {
    id: 'districts',
    label: '行政区划',
    shortLabel: '区划',
    description: '以柔和图志色块区分摩纳哥九个行政区与边界，点击区名可直接定位。',
    ramp: 'linear-gradient(90deg, #c98c53, #7c9eb8, #87ab72, #b88a9a, #6c8d7d)',
  },
] as const;

export const DISTRICT_LENS_COLORS: Readonly<Record<string, { name: string; color: string }>> = {
  manhattan: { name: '曼哈顿区', color: '#d49a57' },
  central: { name: '中区', color: '#789bb8' },
  beverly: { name: '贝弗利区', color: '#7ea670' },
  'st-germain': { name: '圣日耳曼区', color: '#b88392' },
  harlem: { name: '哈林区', color: '#c4a662' },
  uptown: { name: '上城区', color: '#8f88b8' },
  brooklyn: { name: '布鲁克林区', color: '#c77f6b' },
  'fleet-port': { name: '舰队港', color: '#6b9496' },
  reserve: { name: '保留地', color: '#6a8f63' },
};

export const BUILDING_HEIGHT_BANDS: readonly BuildingHeightBand[] = [
  { id: 'low', label: '低层', rangeText: '< 45 m', color: MAP_PALETTE.buildingHeights.low, minTop: 0, maxTop: 45 },
  { id: 'medium', label: '中层', rangeText: '45–90 m', color: MAP_PALETTE.buildingHeights.medium, minTop: 45, maxTop: 90 },
  { id: 'high', label: '高层', rangeText: '90–150 m', color: MAP_PALETTE.buildingHeights.high, minTop: 90, maxTop: 150 },
  { id: 'veryHigh', label: '超高层', rangeText: '≥ 150 m', color: MAP_PALETTE.buildingHeights.veryHigh, minTop: 150, maxTop: Infinity },
  { id: 'landmark', label: '地标 / 古迹', rangeText: '重点建筑', color: MAP_PALETTE.continental, minTop: -1, maxTop: -1 },
] as const;

export function nextLensId(current: MapLensId, step: 1 | -1): MapLensId {
  const index = MAP_LENSES.findIndex((lens) => lens.id === current);
  const next = (index + step + MAP_LENSES.length) % MAP_LENSES.length;
  return MAP_LENSES[next]!.id;
}

export function getLensDefinition(id: MapLensId): MapLensDefinition {
  return MAP_LENSES.find((lens) => lens.id === id) ?? MAP_LENSES[0]!;
}

export function districtLensColorExpression(): ExpressionSpecification {
  const pairs: unknown[] = ['match', ['get', 'id']];
  for (const [id, entry] of Object.entries(DISTRICT_LENS_COLORS)) {
    pairs.push(id, entry.color);
  }
  pairs.push('#9b937a');
  return pairs as unknown as ExpressionSpecification;
}

export function buildingBandColorExpression(
  bandId: string | undefined,
  selectedId: string | undefined,
  defaultExpr: ExpressionSpecification,
): ExpressionSpecification {
  if (!bandId) return defaultExpr;
  const band = BUILDING_HEIGHT_BANDS.find((item) => item.id === bandId);
  if (!band) return defaultExpr;

  const matchBand: unknown[] = band.id === 'landmark'
    ? ['any', ['==', ['get', 'id'], 'continental-tower'], ['==', ['get', 'kind'], 'monument'], ['==', ['get', 'kind'], 'landmark']]
    : band.maxTop === Infinity
      ? ['>=', ['get', 'top'], band.minTop]
      : ['all', ['>=', ['get', 'top'], band.minTop], ['<', ['get', 'top'], band.maxTop]];

  const highlighted: unknown[] = [
    'case',
    ...(selectedId ? [['==', ['get', 'id'], selectedId], MAP_PALETTE.selected] : []),
    matchBand, band.color,
    '#32414e',
  ];
  return highlighted as unknown as ExpressionSpecification;
}

export interface SelectionTarget {
  kind: 'place' | 'station';
  id: string;
}

export function buildSelectionHighlight(
  selection: SelectionTarget | undefined,
  datasets: Pick<import('./dataset-loader').MapDatasets, 'districts' | 'land' | 'parks' | 'roads' | 'pois' | 'metro_stations' | 'metro_lines'>,
): import('geojson').FeatureCollection {
  const features: import('geojson').Feature[] = [];
  if (!selection) return { type: 'FeatureCollection', features };

  if (selection.kind === 'station') {
    const station = datasets.metro_stations.features.find((f) => String(f.properties?.id ?? '') === selection.id);
    if (station) {
      features.push({
        type: 'Feature',
        geometry: station.geometry,
        properties: { highlightKind: 'point' },
      });
      const lineIds = new Set(String(station.properties?.lines ?? '').split(',').filter(Boolean));
      for (const line of datasets.metro_lines.features) {
        if (lineIds.has(String(line.properties?.id ?? ''))) {
          features.push({
            type: 'Feature',
            geometry: line.geometry,
            properties: { highlightKind: 'line' },
          });
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }

  const regions = [
    ...datasets.districts.features.filter((f) => String(f.properties?.id ?? '') === selection.id),
    ...datasets.land.features.filter((f) => String(f.properties?.id ?? '') === selection.id),
    ...datasets.parks.features.filter((f) => String(f.properties?.id ?? '') === selection.id),
  ];
  for (const region of regions) {
    features.push({
      type: 'Feature',
      geometry: region.geometry,
      properties: { highlightKind: 'region' },
    });
  }

  const roads = datasets.roads.features.filter((f) => String(f.properties?.id ?? '') === selection.id);
  for (const road of roads) {
    features.push({
      type: 'Feature',
      geometry: road.geometry,
      properties: { highlightKind: 'line' },
    });
  }

  if (regions.length === 0 && roads.length === 0) {
    const poi = datasets.pois.features.find((f) => String(f.properties?.id ?? '') === selection.id);
    if (poi) {
      features.push({
        type: 'Feature',
        geometry: poi.geometry,
        properties: { highlightKind: 'point' },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

