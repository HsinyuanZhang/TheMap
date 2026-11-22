interface FeatureLike {
  properties?: Record<string, unknown> | null;
}

interface CollectionLike {
  features: readonly FeatureLike[];
}

export interface ClickableCollections {
  land: CollectionLike;
  districts: CollectionLike;
  parks: CollectionLike;
  roads: CollectionLike;
  buildings: CollectionLike;
  pois: CollectionLike;
}

export function collectClickableIds(collections: ClickableCollections): Set<string> {
  const ids = new Set<string>();
  const addIds = (collection: CollectionLike, include: (properties: Record<string, unknown>) => boolean = () => true) => {
    for (const feature of collection.features) {
      const properties = feature.properties;
      const id = properties?.id;
      if (typeof id === 'string' && properties && include(properties)) ids.add(id);
    }
  };

  addIds(collections.districts);
  addIds(collections.land, (properties) => properties.kind !== 'monaco');
  addIds(collections.parks);
  addIds(collections.pois);
  addIds(collections.buildings, (properties) => typeof properties.name === 'string' && properties.name.length > 0);
  addIds(collections.roads, (properties) => (
    properties.class === 'arterial' && typeof properties.name === 'string' && properties.name.length > 0
  ));
  return ids;
}

export function assertMarkdownCoverage(contentIds: ReadonlySet<string>, clickableIds: ReadonlySet<string>): void {
  const missingMarkdown = [...clickableIds].filter((id) => !contentIds.has(id)).sort();
  const missingFeature = [...contentIds].filter((id) => !clickableIds.has(id)).sort();
  const errors: string[] = [];
  if (missingMarkdown.length > 0) errors.push(`Clickable features without Markdown: ${missingMarkdown.join(', ')}`);
  if (missingFeature.length > 0) errors.push(`Markdown without clickable features: ${missingFeature.join(', ')}`);
  if (errors.length > 0) throw new Error(errors.join('\n'));
}
