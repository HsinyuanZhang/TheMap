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

export interface StationNavLineInfo extends StationLineInfo {
  previousId?: string;
  nextId?: string;
}

export interface StationNavInfo {
  name: string;
  district: string;
  lines: StationNavLineInfo[];
}

export function getStationNavigation(id: string, datasets: MapDatasets): StationNavInfo | undefined {
  const station = datasets.metro_stations.features.find((feature) => String(feature.properties?.id ?? '') === id);
  if (!station) return undefined;

  const namesById = new Map(datasets.metro_stations.features.map((feature) => [
    String(feature.properties?.id ?? ''),
    String(feature.properties?.name ?? ''),
  ]));
  const lineIds = String(station.properties?.lines ?? '').split(',').filter(Boolean);
  const lines = lineIds.flatMap((lineId): StationNavLineInfo[] => {
    const line = datasets.metro_lines.features.find((feature) => String(feature.properties?.id ?? '') === lineId);
    const stops = String(line?.properties?.stations ?? '').split(',').filter(Boolean);
    const index = stops.indexOf(id);
    if (index < 0) return [];
    const prevStop = index > 0 ? stops[index - 1] : undefined;
    const nextStop = index < stops.length - 1 ? stops[index + 1] : undefined;
    return [{
      id: lineId,
      ...(prevStop ? { previous: namesById.get(prevStop), previousId: prevStop } : {}),
      ...(nextStop ? { next: namesById.get(nextStop), nextId: nextStop } : {}),
    }];
  });

  return {
    name: String(station.properties?.name ?? ''),
    district: String(station.properties?.district ?? '待定'),
    lines,
  };
}

export function getStationInfo(id: string, datasets: MapDatasets): StationInfo | undefined {
  const nav = getStationNavigation(id, datasets);
  if (!nav) return undefined;
  return {
    name: nav.name,
    district: nav.district,
    lines: nav.lines.map((line) => ({
      id: line.id,
      ...(line.previous !== undefined ? { previous: line.previous } : {}),
      ...(line.next !== undefined ? { next: line.next } : {}),
    })),
  };
}
