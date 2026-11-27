import type { ContentDocument } from './content-format';
import type { MapDatasets } from './dataset-loader';

export function districtName(id: string, places: ReadonlyMap<string, ContentDocument>, datasets: MapDatasets | undefined): string {
  return places.get(id)?.metadata.name ?? String(datasets?.districts.features.find((feature) => feature.properties?.id === id)?.properties?.name ?? id);
}

export function almanacGroups(places: ReadonlyMap<string, ContentDocument>, datasets: MapDatasets | undefined): {
  districts: ContentDocument[]; neighbors: ContentDocument[];
} {
  const documents = (ids: string[]): ContentDocument[] => [...new Set(ids)]
    .map((id) => places.get(id)).filter((doc): doc is ContentDocument => Boolean(doc));
  return {
    districts: documents((datasets?.districts.features ?? []).map((feature) => String(feature.properties?.id ?? ''))),
    neighbors: documents((datasets?.land.features ?? []).map((feature) => String(feature.properties?.id ?? ''))),
  };
}

export function ignoreMapShortcut(target: EventTarget | null, modalOpen: boolean): boolean {
  const element = target as HTMLElement | null;
  return modalOpen || Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
}

export function consumeSearchEscape(event: Pick<KeyboardEvent, 'stopPropagation'>): void {
  event.stopPropagation();
}
