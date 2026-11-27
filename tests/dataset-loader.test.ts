import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DatasetLoader,
  emptyDataset,
  initialDatasetNames,
  lazyDatasetNames,
} from '../src/dataset-loader';

test('dataset groups keep large GeoJSON out of the initial request set', () => {
  assert.deepEqual(initialDatasetNames, [
    'land', 'districts', 'roads', 'metro_lines', 'metro_stations', 'pois', 'labels', 'boundaries', 'parks', 'surface', 'terrain', 'blocks',
  ]);
  assert.deepEqual(lazyDatasetNames, ['buildings', 'trees']);
});

test('dataset loader deduplicates in-flight requests and caches successful data', async () => {
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const data = emptyDataset();
  const loader = new DatasetLoader('/map/', async (url) => {
    calls += 1;
    assert.equal(url, '/map/data/roads.geojson');
    await wait;
    return data;
  });
  const first = loader.load('roads');
  const second = loader.load('roads');
  release();
  assert.strictEqual(await first, data);
  assert.strictEqual(await second, data);
  assert.strictEqual(await loader.load('roads'), data);
  assert.equal(calls, 1);
});

test('dataset loader reports partial failures and retries without discarding successful collections', async () => {
  let districtAttempts = 0;
  const land = emptyDataset();
  const districts = emptyDataset();
  const loader = new DatasetLoader('/', async (url) => {
    if (url.endsWith('/land.geojson')) return land;
    districtAttempts += 1;
    if (districtAttempts === 1) throw new Error('offline');
    return districts;
  });

  const initial = await loader.loadMany(['land', 'districts']);
  assert.deepEqual(initial.failed, ['districts']);
  assert.strictEqual(initial.datasets.land, land);
  assert.equal(initial.datasets.districts, undefined);

  const retry = await loader.loadMany(initial.failed, true);
  assert.deepEqual(retry.failed, []);
  assert.strictEqual(retry.datasets.districts, districts);
  assert.strictEqual(await loader.load('land'), land);
});

test('dataset loader rejects invalid collections and allows a later retry', async () => {
  let attempts = 0;
  const data = emptyDataset();
  const loader = new DatasetLoader('/', async () => {
    attempts += 1;
    return attempts === 1 ? { type: 'Feature', features: [] } : data;
  });
  await assert.rejects(loader.load('blocks'), /Invalid GeoJSON FeatureCollection/);
  assert.strictEqual(await loader.load('blocks'), data);
  assert.equal(attempts, 2);
});
