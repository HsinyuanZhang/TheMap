import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('native legend starts collapsed and stays below the scrollable mobile layer toolbar', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const legend = html.match(/<details class="map-legend"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(legend);
  assert.doesNotMatch(legend, /\sopen(?:\s|>)/);
  assert.match(css, /\.map-legend\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  const mobileStyles = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.match(mobileStyles, /\.layer-toolbar\s*\{[^}]*\+ 62px\)[^}]*overflow-x:\s*auto/s);
  assert.match(mobileStyles, /\.map-legend\s*\{[^}]*\+ 117px\)[^}]*max-height:/s);
  assert.match(css, /\.legend-swatch-dashed::after[^}]*repeating-linear-gradient/);
});

test('mobile scale moves to the right while preserving panel clearance and desktop placement', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const breakpoint = css.indexOf('@media (max-width: 640px)');
  const desktopStyles = css.slice(0, breakpoint);
  const mobileStyles = css.slice(breakpoint);
  assert.match(desktopStyles, /\.maplibregl-ctrl-bottom-left\s*\{\s*margin: 0 0 14px 14px;\s*\}/);
  assert.match(mobileStyles, /\.maplibregl-ctrl-bottom-left\s*\{[^}]*left:\s*auto;[^}]*right:\s*0;[^}]*bottom:\s*var\(--mobile-scale-offset, 0px\);/);
});
