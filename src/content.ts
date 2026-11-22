import aboutSource from '../content/about.md?raw';
import { parseContentDocument, type ContentDocument } from './content-format';

const placeSources = import.meta.glob<string>('../content/places/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

const places = new Map<string, ContentDocument>();
for (const source of Object.values(placeSources)) {
  const document = parseContentDocument(source);
  if (places.has(document.metadata.id)) throw new Error(`重复的地点内容 id：${document.metadata.id}`);
  places.set(document.metadata.id, document);
}

export function getPlace(id: string): ContentDocument | undefined {
  return places.get(id);
}

export function getPlaces(): ReadonlyMap<string, ContentDocument> {
  return places;
}

export function getAbout(): string {
  return aboutSource.trim();
}
