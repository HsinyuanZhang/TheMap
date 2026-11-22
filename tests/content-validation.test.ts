import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMarkdownCoverage, collectClickableIds } from '../scripts/content-links';

const collections = {
  districts: { features: [{ properties: { id: 'manhattan' } }] },
  land: { features: [
    { properties: { id: 'monaco', kind: 'monaco' } },
    { properties: { id: 'ottoman', kind: 'ottoman' } },
  ] },
  parks: { features: [{ properties: { id: 'central-park' } }] },
  roads: { features: [
    { properties: { id: 'A1', class: 'motorway', name: 'A1' } },
    { properties: { id: 'street-01', class: 'street', name: '' } },
    { properties: { id: 'wall-street', class: 'arterial', name: '华尔街' } },
  ] },
  buildings: { features: [
    { properties: { id: 'city-hall', name: '市政府' } },
    { properties: { height: 30 } },
  ] },
  pois: { features: [{ properties: { id: 'times-square' } }] },
};

test('clickable IDs include only the content-bearing feature classes', () => {
  assert.deepEqual([...collectClickableIds(collections)].sort(), [
    'central-park', 'city-hall', 'manhattan', 'ottoman', 'times-square', 'wall-street',
  ]);
});

test('validation rejects a clickable feature when its Markdown file is missing', () => {
  const clickableIds = collectClickableIds(collections);
  const markdownIds = new Set(clickableIds);
  markdownIds.delete('city-hall');
  assert.throws(
    () => assertMarkdownCoverage(markdownIds, clickableIds),
    /Clickable features without Markdown: city-hall/,
  );
});
