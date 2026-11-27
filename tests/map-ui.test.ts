import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('native legend starts collapsed, scrolls cleanly, and keeps dashed boundary swatches inside the gilded atlas HUD', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const legend = html.match(/<details[^>]*class="map-legend[^"]*"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(legend);
  assert.doesNotMatch(legend, /\sopen(?:\s|>)/);
  assert.match(css, /\.map-legend\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.legend-swatch-dashed::after[^}]*repeating-linear-gradient/);
  assert.match(html, /id="search-input"/);
  assert.match(html, /id="lens-dock"/);
  assert.match(html, /id="almanac-modal"/);
  assert.match(html, /id="help-modal"/);
});

test('mobile scale moves to the right above the dock while preserving panel clearance and desktop placement', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const breakpoint = css.indexOf('@media (max-width: 640px)');
  assert.ok(breakpoint > 0);
  const desktopStyles = css.slice(0, breakpoint);
  const mobileStyles = css.slice(breakpoint);
  assert.match(desktopStyles, /\.maplibregl-ctrl-bottom-left\s*\{\s*margin: 0 0 14px 14px;\s*\}/);
  assert.match(desktopStyles, /body\.panel-open \.atlas-dock\s*\{/);
  assert.match(mobileStyles, /\.maplibregl-ctrl-bottom-left\s*\{[^}]*left:\s*auto;[^}]*right:\s*0;[^}]*bottom:\s*calc\(96px \+ var\(--mobile-scale-offset, 0px\)\);/s);
  assert.match(mobileStyles, /\.lens-dock\s*\{[^}]*env\(safe-area-inset-bottom\)/s);
});
