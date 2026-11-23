import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAreaCoverage,
  assertFinalTierTop,
  assertLabelCoverage,
  assertNoPositiveAreaOverlap,
  assertRoadClearance,
  assertTierContinuity,
  groupBuildingBidsWithinDistrict,
} from "../scripts/data-invariants";
import type { Feature, Polygon } from "geojson";

function polygon(
  coordinates: [number, number][][],
  properties: Record<string, string | number | boolean> = {},
): Feature<Polygon, Record<string, string | number | boolean>> {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates } };
}

test("district area coverage rejects a boundary gap", () => {
  assert.throws(() => assertAreaCoverage(0.9, 1), /boundary gap/);
});

test("building validation rejects road-corridor intrusion", () => {
  assert.throws(() => assertRoadClearance(
    [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
    [{ coordinates: [[-1, 0.5], [2, 0.5]], width: 0.05 }],
  ), /road corridor/);
});

test("building validation rejects discontinuous tiers", () => {
  assert.throws(() => assertTierContinuity([
    { base: 0, height: 10 },
    { base: 11, height: 20 },
  ]), /contiguous/);
});

test("building validation rejects a final tier that does not reach its bid top", () => {
  const tiers = [{ base: 0, height: 10 }, { base: 10, height: 20 }];
  assertTierContinuity(tiers);
  assert.throws(() => assertFinalTierTop(tiers, 21), /reach the bid top/);
});

test("positive-area overlap validation rejects identical and nested footprints", () => {
  const outer = polygon([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]]);
  const identical = polygon([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]]);
  const nested = polygon([[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]]);
  assert.throws(() => assertNoPositiveAreaOverlap(outer, identical), /must not overlap/);
  assert.throws(() => assertNoPositiveAreaOverlap(outer, nested), /must not overlap/);
});

test("Manhattan bid selection excludes Uptown landmarks with the same kind", () => {
  const district = polygon([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
  const manhattanLandmark = polygon(
    [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
    { bid: "L-manhattan", kind: "landmark", base: 0 },
  );
  const uptownLandmark = polygon(
    [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]],
    { bid: "L-uptown", kind: "landmark", base: 0 },
  );
  const selected = groupBuildingBidsWithinDistrict([manhattanLandmark, uptownLandmark], district);
  assert.deepEqual([...selected.keys()], ["L-manhattan"]);
});

test("label validation rejects a missing area label", () => {
  assert.throws(() => assertLabelCoverage(["district-a", "district-b"], ["district-a"]), /exactly one label/);
});
