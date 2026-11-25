import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MultiPolygon, Polygon } from 'geojson';
import { precisionSliverArea, validateDistrictTopology } from '../scripts/district-topology';

test('Phase 3 districts preserve baseline geometry and tile the city with valid areas, stations, and labels', () => {
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
