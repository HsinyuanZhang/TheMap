import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundsFromPositions,
  clampCenterToBounds,
  geometryFocusZoom,
  getMapPadding,
  initialMapCamera,
  mapCameraLimits,
  mobileScaleOffset,
  pointFocusZoom,
  removeTranslationFromRect,
  threeDimensionalView,
} from '../src/map-camera';

test('center-only bounds clamp the camera center without requiring the viewport to fit inside the ring', () => {
  const bounds = { west: -150.1, south: 39.9, east: -149.5, north: 40.5 };
  assert.deepEqual(clampCenterToBounds({ lng: -151, lat: 41 }, bounds), [-150.1, 40.5]);
  assert.deepEqual(clampCenterToBounds({ lng: -149.8, lat: 40.2 }, bounds), [-149.8, 40.2]);
});

test('overview bounds include every district and neighboring-land vertex', () => {
  assert.deepEqual(boundsFromPositions([
    [-150, 40], [-149.8, 40.3], [-149.6, 40.1],
  ]), [[-150, 40], [-149.6, 40.3]]);
  assert.throws(() => boundsFromPositions([]), /district and neighboring-land geometry is empty/);
});

test('map fit padding follows the open desktop side panel and mobile bottom sheet', () => {
  assert.deepEqual(
    getMapPadding(
      { top: 0, right: 1280, bottom: 841, left: 0 },
      { top: 92, right: 1262, bottom: 823, left: 872 },
      true,
      false,
    ),
    { top: 136, right: 432, bottom: 32, left: 32 },
  );
  assert.deepEqual(
    getMapPadding(
      { top: 0, right: 390, bottom: 844, left: 0 },
      { top: 464, right: 390, bottom: 844, left: 0 },
      true,
      true,
    ),
    { top: 126, right: 32, bottom: 404, left: 32 },
  );
});

test('a closed panel does not reserve its former overlay area', () => {
  assert.deepEqual(
    getMapPadding(
      { top: 0, right: 390, bottom: 844, left: 0 },
      { top: 464, right: 390, bottom: 844, left: 0 },
      false,
      true,
    ),
    { top: 126, right: 32, bottom: 32, left: 32 },
  );
});

test('panel transition transforms do not change focus padding before or after the transition', () => {
  const mobileMap = { top: 0, right: 390, bottom: 844, left: 0 };
  const mobilePanel = removeTranslationFromRect(
    { top: 844, right: 390, bottom: 1224, left: 0 },
    0,
    380,
  );
  assert.deepEqual(mobilePanel, { top: 464, right: 390, bottom: 844, left: 0 });
  assert.deepEqual(getMapPadding(mobileMap, mobilePanel, true, true), {
    top: 126, right: 32, bottom: 404, left: 32,
  });

  const desktopMap = { top: 0, right: 1280, bottom: 841, left: 0 };
  const desktopPanel = removeTranslationFromRect(
    { top: 92, right: 1278, bottom: 823, left: 888 },
    16,
    0,
  );
  assert.deepEqual(desktopPanel, { top: 92, right: 1262, bottom: 823, left: 872 });
  assert.deepEqual(getMapPadding(desktopMap, desktopPanel, true, false), {
    top: 136, right: 432, bottom: 32, left: 32,
  });
});

test('point and geometry focuses zoom in when needed and do not zoom out from a closer view', () => {
  assert.equal(pointFocusZoom(12, 15), 15);
  assert.equal(pointFocusZoom(16, 15), 16);
  assert.equal(geometryFocusZoom(10, 17, 15), 15);
  assert.equal(geometryFocusZoom(16, 12, 15), 16);
});

test('3D camera uses the low-zoom tower preset and preserves close-view bearing', () => {
  assert.deepEqual(initialMapCamera, { pitch: 0, bearing: 0 });
  assert.deepEqual(threeDimensionalView(10, [-149.8, 40.2], 0, [-149.7, 40.3]), {
    preset: true, center: [-149.7, 40.3], zoom: 15, pitch: 72, bearing: -18,
  });
  assert.deepEqual(threeDimensionalView(15, [-149.8, 40.2], 24), {
    preset: false, center: [-149.8, 40.2], zoom: 15, pitch: 60, bearing: 24,
  });
  assert.deepEqual(mapCameraLimits, { minZoom: 7.2, maxZoom: 18, maxPitch: 80, defaultPitch: 60 });
});

test('mobile scale control moves above the visible bottom sheet height', () => {
  assert.equal(
    mobileScaleOffset(
      { top: 0, right: 390, bottom: 844, left: 0 },
      { top: 464, right: 390, bottom: 844, left: 0 },
      true,
      true,
    ),
    402,
  );
  assert.equal(mobileScaleOffset(
    { top: 0, right: 390, bottom: 844, left: 0 },
    { top: 464, right: 390, bottom: 844, left: 0 },
    false,
    true,
  ), 0);
});
