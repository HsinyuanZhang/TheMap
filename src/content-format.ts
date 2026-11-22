export interface ContentMetadata {
  id: string;
  name: string;
  type: string;
  district: string;
}

export interface ContentDocument {
  metadata: ContentMetadata;
  body: string;
}

export function parseContentDocument(source: string): ContentDocument {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('内容文件缺少有效的 frontmatter。');

  const metadata = Object.fromEntries(match[1]!
    .split('\n')
    .map((line) => line.match(/^([a-z]+):\s*(.*)$/))
    .filter((entry): entry is RegExpMatchArray => entry !== null)
    .map((entry) => [entry[1]!, entry[2]!.trim()])) as Partial<ContentMetadata>;

  for (const key of ['id', 'name', 'type', 'district'] as const) {
    if (!metadata[key]) throw new Error(`内容 frontmatter 缺少 ${key}。`);
  }

  return {
    metadata: metadata as ContentMetadata,
    body: match[2]!.trim(),
  };
}

export function normalizeProse(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

export function escapeRawHtml(markdown: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  };
  return markdown.replace(/[&<>]/g, (character) => entities[character]!);
}
