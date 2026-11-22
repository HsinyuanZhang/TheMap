import type { MapDatasets } from './map';

export interface StationLineInfo {
  id: string;
  previous?: string;
  next?: string;
}

export interface StationInfo {
  name: string;
  district: string;
  lines: StationLineInfo[];
}

export function getStationInfo(id: string, datasets: MapDatasets): StationInfo | undefined {
  const station = datasets.metro_stations.features.find((feature) => String(feature.properties?.id ?? '') === id);
  if (!station) return undefined;

  const namesById = new Map(datasets.metro_stations.features.map((feature) => [
    String(feature.properties?.id ?? ''),
    String(feature.properties?.name ?? ''),
  ]));
  const lineIds = String(station.properties?.lines ?? '').split(',').filter(Boolean);
  const lines = lineIds.flatMap((lineId): StationLineInfo[] => {
    const line = datasets.metro_lines.features.find((feature) => String(feature.properties?.id ?? '') === lineId);
    const stops = String(line?.properties?.stations ?? '').split(',').filter(Boolean);
    const index = stops.indexOf(id);
    if (index < 0) return [];
    return [{
      id: lineId,
      ...(index > 0 ? { previous: namesById.get(stops[index - 1]!) } : {}),
      ...(index < stops.length - 1 ? { next: namesById.get(stops[index + 1]!) } : {}),
    }];
  });

  return {
    name: String(station.properties?.name ?? ''),
    district: String(station.properties?.district ?? '待定'),
    lines,
  };
}
