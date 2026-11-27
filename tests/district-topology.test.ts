import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MultiPolygon, Polygon } from 'geojson';
import { precisionSliverArea, validateDistrictTopology } from '../scripts/district-topology';
import { districts, internalBoundaries, type XY } from '../data/source';

test('Fleet Port guards reject area drift, coastline changes and mismatched neighbour vertices', () => {
  const fleet = districts.find(d => d.id === 'fleet-port')!.ring as XY[];
  const coast = fleet[0]!;
  try {
    fleet[0] = [coast[0] + 10, coast[1]];
    assert.throws(() => validateDistrictTopology(), /Fleet Port area/);
    fleet[0] = [coast[0] + 0.001, coast[1]];
    assert.throws(() => validateDistrictTopology(), /Fleet Port coastline/);
  } finally { fleet[0] = coast; }
  const neighbour = districts.find(d => d.id === 'uptown')!.ring as XY[];
  const shared = internalBoundaries.find(b => b.id === 'uptown-fleet-port')!.coordinates[1]!;
  const index = neighbour.findIndex(p => p[0] === shared[0] && p[1] === shared[1]);
  assert.ok(index >= 0);
  const original = neighbour[index]!;
  try {
    neighbour[index] = [original[0] + 0.00001, original[1]];
    assert.throws(() => validateDistrictTopology(), /neighbouring boundary vertices/);
  } finally { neighbour[index] = original; }
});

test('Phase 4 districts preserve baseline geometry and tile the city with valid areas, stations, and labels', () => {
  const report = validateDistrictTopology();
  const areas = Object.entries(report.areasKm2).map(([id, area]) => `${id}=${area.toFixed(3)}`).join(', ');
  const stations = report.movedStations.map(({ id, district, position }) => `${id} (${position[0]},${position[1]}) → ${district}`).join('; ');
  console.log(`District areas (km²): ${areas}`);
  console.log(`Moved station assignments: ${stations}`);
  console.log(`Labels: reserve=${report.labelCounts.reserve}; other regions=${Object.entries(report.labelCounts).filter(([id]) => id !== 'reserve').length}×1; total=${Object.values(report.labelCounts).reduce((sum, count) => sum + count, 0)}`);
  console.log(`Topology: union=${report.districtUnionAreaKm2.toFixed(3)} km²; Monaco=${report.monacoAreaKm2.toFixed(3)} km²; baseline geometry hashes matched.`);
});

test('exported district clipping permits only sub-cell triangular rounding slivers', () => {
  const roundedBoundarySlivers: MultiPolygon = { type: 'MultiPolygon', coordinates: [
    [[[-149.999899, 40.08193], [-149.999894, 40.081393], [-149.999872, 40.079302], [-149.999899, 40.08193]]],
    [[[-149.999597, 40.223889], [-149.997911, 40.226263], [-149.998032, 40.226093], [-149.999597, 40.223889]]],
    [[[-149.897759, 39.999922], [-149.89446, 40.000182], [-149.893728, 40.00024], [-149.897759, 39.999922]]],
  ] };
  assert.ok(Math.abs(precisionSliverArea(roundedBoundarySlivers, 'district/Monaco') - 14.2798) < 0.01);
  const substantiveOverlap: Polygon = { type: 'Polygon', coordinates: [[
    [-149.671965, 40.045776], [-149.670555, 40.081393],
    [-149.670559, 40.081393], [-149.671965, 40.045776],
  ]] };
  assert.throws(() => precisionSliverArea(substantiveOverlap, 'beverly/reserve'), /substantive area/);
});
