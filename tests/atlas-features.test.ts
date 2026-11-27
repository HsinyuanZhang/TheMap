import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { datasetNames, type Dataset, type MapDatasets } from '../src/dataset-loader';
import { parseContentDocument, type ContentDocument } from '../src/content-format';
import { buildSearchIndex, searchEntries } from '../src/search';
import {
  BUILDING_HEIGHT_BANDS,
  DISTRICT_LENS_COLORS,
  MAP_LENSES,
  buildSelectionHighlight,
  buildingBandColorExpression,
  districtLensColorExpression,
  nextLensId,
} from '../src/map-lenses';
import { buildingColorExpression } from '../src/map-style';
import { getStationNavigation } from '../src/station-info';
import { labelImageIds, labelImageOptions } from '../src/map-label-images';

const data = Object.fromEntries(
  await Promise.all(
    datasetNames.map(async (name) => [
      name,
      JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8')) as Dataset,
    ]),
  ),
) as unknown as MapDatasets;

const placeDir = new URL('../content/places/', import.meta.url);
const placeFiles = (await readdir(placeDir)).filter((name) => name.endsWith('.md'));
const places = new Map<string, ContentDocument>();
for (const file of placeFiles) {
  const doc = parseContentDocument(await readFile(new URL(file, placeDir), 'utf8'));
  places.set(doc.metadata.id, doc);
}

test('search index finds places, districts, and metro stations by name or line id', () => {
  const index = buildSearchIndex(places, data);
  assert.ok(index.length >= places.size + data.metro_stations.features.length);

  const exchange = searchEntries(index, '海峡交易所');
  assert.equal(exchange[0]?.id, 'strait-exchange');
  assert.equal(exchange[0]?.kind, 'place');

  const manhattan = searchEntries(index, '曼哈顿');
  assert.equal(manhattan[0]?.id, 'manhattan');

  const u3Stations = searchEntries(index, 'U3', 30);
  assert.ok(u3Stations.length > 0);
  assert.ok(u3Stations.every((entry) => entry.kind === 'station' && entry.subtitle.includes('U3')));

  assert.deepEqual(searchEntries(index, '不存在的地点xyz'), []);
});

test('map lenses cycle cleanly and cover all nine SAR districts and building height bands', () => {
  assert.deepEqual(MAP_LENSES.map((l) => l.id), ['standard', 'transit', 'buildings', 'districts']);
  assert.equal(nextLensId('standard', 1), 'transit');
  assert.equal(nextLensId('districts', 1), 'standard');
  assert.equal(nextLensId('standard', -1), 'districts');

  for (const district of data.districts.features) {
    const id = String(district.properties?.id ?? '');
    assert.ok(id in DISTRICT_LENS_COLORS, `Missing lens color for district ${id}`);
  }
  const districtExpr = districtLensColorExpression() as unknown[];
  assert.equal(districtExpr[0], 'match');

  const defaultBuildingExpr = buildingColorExpression(undefined);
  assert.equal(buildingBandColorExpression(undefined, undefined, defaultBuildingExpr), defaultBuildingExpr);
  for (const band of BUILDING_HEIGHT_BANDS) {
    const expr = buildingBandColorExpression(band.id, 'continental-tower', defaultBuildingExpr) as unknown[];
    assert.equal(expr[0], 'case');
    assert.deepEqual(expr[1], ['==', ['get', 'id'], 'continental-tower']);
  }
});

test('selection highlight produces region, line, and point overlays for districts, stations, and POIs', () => {
  assert.deepEqual(buildSelectionHighlight(undefined, data).features, []);

  const districtHighlight = buildSelectionHighlight({ kind: 'place', id: 'manhattan' }, data);
  assert.ok(districtHighlight.features.length >= 1);
  assert.ok(districtHighlight.features.every((f) => f.properties?.highlightKind === 'region'));

  const poiHighlight = buildSelectionHighlight({ kind: 'place', id: 'strait-exchange' }, data);
  assert.equal(poiHighlight.features.length, 1);
  assert.equal(poiHighlight.features[0]?.properties?.highlightKind, 'point');

  const firstStationId = String(data.metro_stations.features[0]?.properties?.id ?? '');
  const stationHighlight = buildSelectionHighlight({ kind: 'station', id: firstStationId }, data);
  assert.ok(stationHighlight.features.some((f) => f.properties?.highlightKind === 'point'));
  assert.ok(stationHighlight.features.some((f) => f.properties?.highlightKind === 'line'));
});

test('station navigation exposes navigable adjacent station IDs and overview plates are stretchable', () => {
  const stations = data.metro_stations.features;
  let checkedNeighborLink = false;
  for (const feature of stations) {
    const id = String(feature.properties?.id ?? '');
    const info = getStationNavigation(id, data);
    assert.ok(info);
    for (const line of info.lines) {
      if (line.previous) {
        assert.ok(line.previousId);
        checkedNeighborLink = true;
      }
      if (line.next) {
        assert.ok(line.nextId);
        checkedNeighborLink = true;
      }
    }
  }
  assert.ok(checkedNeighborLink);
  assert.ok(labelImageIds.includes('overview-plate-continental'));
  const opt = labelImageOptions('overview-plate-continental');
  assert.equal(opt.pixelRatio, 2);
  assert.ok(opt.stretchX[0]![0] < opt.stretchX[0]![1]);
});
