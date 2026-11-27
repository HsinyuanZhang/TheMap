import assert from 'node:assert/strict';
import { test } from 'node:test';
import { area, booleanDisjoint, booleanWithin } from '@turf/turf';
import { beverlyHills } from '../data/source';
import { generateWoodlandsForValidation } from '../data/generate';

const localPosition = ([longitude, latitude]: number[]): [number, number] => [
  (longitude! + 150) * 111.32 * Math.cos(40 * Math.PI / 180),
  (latitude! - 40) * 110.574,
];

test('woodland generation independently meets coverage, size, and overlap constraints', () => {
  const { woods, farms, towns, districts } = generateWoodlandsForValidation();
  const reserve = woods.filter((wood) => wood.properties?.sector === 'reserve');
  const beverly = woods.filter((wood) => wood.properties?.sector === 'beverly');
  const areaKm2 = (feature: typeof woods[number]): number => area(feature) / 1_000_000;
  const coverage = (patches: typeof woods, district: typeof districts.reserve): number =>
    patches.reduce((sum, patch) => sum + areaKm2(patch), 0) / (area(district) / 1_000_000);

  assert.equal(reserve.length, 7);
  assert.equal(beverly.length, beverlyHills.length);
  for (const [sector, patches, district] of [['reserve', reserve, districts.reserve], ['beverly', beverly, districts.beverly]] as const) {
    for (let first = 0; first < patches.length; first += 1) {
      assert.ok(areaKm2(patches[first]!) >= 0.3, `patch area ${areaKm2(patches[first]!).toFixed(3)} km² is below 0.3 km²`);
      assert.ok(booleanWithin(patches[first]!, district), `${sector} patch ${first + 1} must remain inside its district`);
      for (let second = first + 1; second < patches.length; second += 1) {
        assert.ok(booleanDisjoint(patches[first]!, patches[second]!), 'wood patches must not overlap');
      }
    }
    const patchAreas = patches.map(areaKm2);
    const averageArea = patchAreas.reduce((sum, value) => sum + value, 0) / patchAreas.length;
    const areaVariation = Math.sqrt(patchAreas.reduce((sum, value) => sum + (value - averageArea) ** 2, 0)
      / patchAreas.length) / averageArea;
    assert.ok(areaVariation > 0.05, `${sector} patch areas must vary substantially`);
    for (const patch of patches) {
      const points = patch.geometry.coordinates[0]!.slice(0, -1).map(localPosition);
      const center: [number, number] = [
        points.reduce((sum, [x]) => sum + x, 0) / points.length,
        points.reduce((sum, [, y]) => sum + y, 0) / points.length,
      ];
      const radiusX = Math.max(...points.map(([x]) => Math.abs(x - center[0])));
      const radiusY = Math.max(...points.map(([, y]) => Math.abs(y - center[1])));
      const radii = points.map(([x, y]) => Math.hypot((x - center[0]) / radiusX, (y - center[1]) / radiusY));
      const meanRadius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
      const shapeVariation = Math.sqrt(radii.reduce((sum, value) => sum + (value - meanRadius) ** 2, 0)
        / radii.length) / meanRadius;
      assert.ok(shapeVariation > 0.035, `${sector} woodland outlines must be irregular`);
    }
  }
  for (const wood of reserve) for (const town of towns) {
    assert.ok(booleanDisjoint(wood, town), `wood overlaps ${town.properties?.id}`);
  }
  for (const farm of farms) {
    for (const wood of reserve) assert.ok(booleanDisjoint(farm, wood), 'farm and woodland must not overlap');
    for (const town of towns) assert.ok(booleanDisjoint(farm, town), 'farm and town must not overlap');
  }
  const farmCoverage = farms.reduce((sum, farm) => sum + area(farm) / 1_000_000, 0) / (area(districts.reserve) / 1_000_000);
  assert.ok(farms.length >= 1000 && farms.length <= 2000, `farm count ${farms.length}`);
  assert.ok(farmCoverage >= 0.45 && farmCoverage <= 0.55, `farm coverage ${(farmCoverage * 100).toFixed(2)}%`);
  const reserveCoverage = coverage(reserve, districts.reserve);
  const beverlyCoverage = coverage(beverly, districts.beverly);
  assert.ok(reserveCoverage >= 0.3 && reserveCoverage <= 0.4, `Reserve coverage ${(reserveCoverage * 100).toFixed(2)}%`);
  assert.ok(beverlyCoverage >= 0.35 && beverlyCoverage <= 0.5, `Beverly coverage ${(beverlyCoverage * 100).toFixed(2)}%`);
  assert.ok(reserve.filter((patch) => areaKm2(patch) > 5).length >= 3);
  const centers = reserve.map((patch) => {
    const positions = patch.geometry.coordinates[0]!.slice(0, -1).map(localPosition);
    return [positions.reduce((sum, [x]) => sum + x, 0) / positions.length,
      positions.reduce((sum, [, y]) => sum + y, 0) / positions.length] as const;
  });
  assert.ok(centers.some(([x, y]) => x < 28 && y > 25), 'woods must cover the northern arm');
  assert.ok(centers.some(([x]) => x >= 28), 'woods must cover the eastern arm');
  console.log(`Wood area km² — Beverly: ${beverly.map((patch) => areaKm2(patch).toFixed(2)).join(', ')}; Reserve: ${reserve.map((patch) => areaKm2(patch).toFixed(2)).join(', ')}.`);
  console.log(`Wood coverage — Beverly ${(beverlyCoverage * 100).toFixed(2)}%; Reserve ${(reserveCoverage * 100).toFixed(2)}%. Town/wood and wood/wood overlaps: 0.`);
  console.log(`Independent farms: ${farms.length} (${(farmCoverage * 100).toFixed(2)}%); farm/wood and farm/town overlaps: 0.`);
});
