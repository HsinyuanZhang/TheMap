import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { captureAtlasPoster, composeAtlasPoster } from '../src/poster-export';
import { getLensDefinition } from '../src/map-lenses';

test('lens updates do not wait for tiles and are reapplied after style and dataset changes', async () => {
  const source = await readFile(new URL('../src/map.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source.slice(source.indexOf('private applyLensVisuals'), source.indexOf('  setShowAllBuildings(')), /isStyleLoaded\(/);
  assert.match(source, /on\('style.load',[\s\S]*?this.applyLensVisuals\(\)/);
  assert.match(source, /setDataset\([\s\S]*?this.applyLensVisuals\(\)/);
  const hitTesting = source.slice(source.indexOf('private installHitTesting'), source.indexOf('  setDataset('));
  assert.equal(hitTesting.match(/queryRenderedFeatures\(/g)?.length, 1);
  assert.match(hitTesting, /requestAnimationFrame/);
  assert.match(hitTesting, /cancelAnimationFrame/);
});

test('search buttons activate by click and the mobile dock is hidden with its focus targets', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /btn.addEventListener\('click', \(\) => \{\s*searchInput.value/);
  assert.match(source, /consumeSearchEscape\(event\)/);
  assert.match(source, /modalOpen && event.key !== 'Escape'/);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css.slice(css.indexOf('@media (max-width: 640px)')), /body.panel-open .atlas-dock\s*\{[^}]*visibility: hidden;[^}]*pointer-events: none;/);
});

test('poster capture waits for idle and reads once inside render, and rejects empty or removed maps', async () => {
  const listeners = new Map<string, () => void>();
  let reads = 0;
  let paints = 0;
  const map = {
    loaded: () => false,
    once: (type: string, callback: () => void) => { listeners.set(type, callback); },
    off: (type: string) => { listeners.delete(type); },
    triggerRepaint: () => { paints++; },
    getCanvas: () => { reads++; return { width: 0, height: 0 }; },
  } as unknown as Parameters<typeof captureAtlasPoster>[0];
  const meta = { lens: getLensDefinition('standard') };
  const removed = captureAtlasPoster(map, meta);
  assert.equal(listeners.has('render'), false);
  listeners.get('remove')!();
  await assert.rejects(removed, /Map removed/);
  assert.equal(listeners.size, 0);

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = new Proxy({}, { get: (_, key) => key === 'createRadialGradient' || key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {} });
  const canvas = { getContext: () => context };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  try {
    assert.throws(() => composeAtlasPoster({ width: 0, height: 0 } as HTMLCanvasElement, meta), /canvas is empty/);
    const capture = captureAtlasPoster(map, meta);
    assert.equal(reads, 0);
    listeners.get('idle')!();
    assert.equal(paints, 1);
    assert.equal(reads, 0);
    const render = listeners.get('render')!;
    render();
    await assert.rejects(capture, /canvas is empty/);
    assert.equal(reads, 1);
    assert.equal(listeners.size, 0);
    map.loaded = () => true;
    map.getCanvas = () => ({ width: 512, height: 512 } as HTMLCanvasElement);
    const ready = captureAtlasPoster(map, meta);
    listeners.get('render')!();
    assert.equal(await ready, canvas);
    assert.equal(listeners.size, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
