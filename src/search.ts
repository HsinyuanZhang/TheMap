import type { ContentDocument } from './content-format';
import type { MapDatasets } from './dataset-loader';
import type { MapSelection } from './map';

export interface SearchEntry {
  kind: MapSelection['kind'];
  id: string;
  name: string;
  category: string;
  subtitle: string;
  keywords: string;
  priority: number;
}

export function buildSearchIndex(
  places: ReadonlyMap<string, ContentDocument>,
  datasets: Pick<MapDatasets, 'metro_stations'>,
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const doc of places.values()) {
    const { id, name, type, district } = doc.metadata;
    const isRegion = type === '城区' || type === '邻区';
    entries.push({
      kind: 'place',
      id,
      name,
      category: type,
      subtitle: isRegion ? type : `${type} · ${district}`,
      keywords: `${name} ${id} ${type} ${district}`.toLowerCase(),
      priority: type === '城区' ? 1 : type === '地标' ? 2 : type === '邻区' ? 3 : 4,
    });
  }

  for (const feature of datasets.metro_stations.features) {
    const props = feature.properties ?? {};
    const id = String(props.id ?? '');
    const name = String(props.name ?? '');
    if (!id || !name) continue;
    const district = String(props.district ?? '待定');
    const lines = String(props.lines ?? '').split(',').filter(Boolean);
    const transfer = Number(props.transfer) === 1;
    const lineLabel = lines.join(' / ');
    entries.push({
      kind: 'station',
      id,
      name,
      category: transfer ? '换乘站' : '地铁站',
      subtitle: `${lineLabel ? `${lineLabel} · ` : ''}${district}`,
      keywords: `${name} ${id} 地铁 ${lines.join(' ')} ${district} ${transfer ? '换乘' : ''}`.toLowerCase(),
      priority: transfer ? 2.5 : 5,
    });
  }

  return entries.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'zh-CN'));
}

export function searchEntries(entries: readonly SearchEntry[], rawQuery: string, limit = 12): SearchEntry[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return entries.slice(0, limit);
  const terms = query.split(/\s+/).filter(Boolean);

  const scored: Array<{ entry: SearchEntry; score: number }> = [];
  for (const entry of entries) {
    const nameLower = entry.name.toLowerCase();
    if (!terms.every((term) => entry.keywords.includes(term))) continue;
    let score = entry.priority * 10;
    if (nameLower === query) score -= 100;
    else if (nameLower.startsWith(query)) score -= 60;
    else if (nameLower.includes(query)) score -= 30;
    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name, 'zh-CN'))
    .slice(0, limit)
    .map((item) => item.entry);
}
