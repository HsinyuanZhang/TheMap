import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { normalizeProse, parseContentDocument, escapeRawHtml } from '../src/content-format';

interface ContentFixture {
  about: string;
  places: Record<string, { name: string; type: string; district: string; body: string }>;
}

const contentFixture = JSON.parse(await readFile(new URL('./content.fixture.json', import.meta.url), 'utf8')) as ContentFixture;

test('all Appendix A Markdown content matches its approved source fixture', async () => {
  const directory = new URL('../content/places/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();
  const actualIds = new Set<string>();
  assert.equal(files.length, Object.keys(contentFixture.places).length);

  for (const file of files) {
    const document = parseContentDocument(await readFile(new URL(file, directory), 'utf8'));
    const expected = contentFixture.places[document.metadata.id as keyof typeof contentFixture.places];
    assert.ok(expected, `Unexpected content id ${document.metadata.id}`);
    actualIds.add(document.metadata.id);
    assert.equal(document.metadata.name, expected.name, `${file} name`);
    assert.equal(document.metadata.type, expected.type, `${file} type`);
    assert.equal(document.metadata.district, expected.district, `${file} district`);
    assert.equal(normalizeProse(document.body), normalizeProse(expected.body), `${file} body`);
  }

  assert.equal(actualIds.size, Object.keys(contentFixture.places).length);
  const about = await readFile(new URL('../content/about.md', import.meta.url), 'utf8');
  assert.equal(normalizeProse(about), normalizeProse(contentFixture.about));
});

test('raw HTML is escaped before Markdown rendering', () => {
  assert.equal(escapeRawHtml('<script>alert(1)</script> &'), '&lt;script&gt;alert(1)&lt;/script&gt; &amp;');
});

test('content parsing handles empty prose and rejects malformed metadata', () => {
  assert.equal(parseContentDocument('---\nid: empty\nname: 空白\ntype: 地点\ndistrict: 待定\n---\n \n').body, '');
  assert.equal(normalizeProse(' \n\t'), '');
  assert.throws(() => parseContentDocument('没有 frontmatter'), /frontmatter/);
  assert.throws(() => parseContentDocument('---\nid: missing-name\ntype: 地点\ndistrict: 待定\n---\n正文'), /name/);
});
