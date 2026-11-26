import { area, featureCollection, intersect, pointOnFeature } from '@turf/turf';
import type { Feature, Geometry, Polygon, Position } from 'geojson';
import { MAP_LIGHT } from '../src/map-light';
import { pointInRing } from './geometry';
import type { XY } from './source';

type Properties = Record<string, string | number | boolean>;
type Item = Feature<Geometry, Properties>;
const sx = 111.32 * Math.cos(40 * Math.PI / 180);
const sy = 110.574;
const geographic = ([x, y]: XY): Position => [Number((-150 + x / sx).toFixed(6)), Number((40 + y / sy).toFixed(6))];
const local = ([x, y]: Position): XY => [(x! + 150) * sx, (y! - 40) * sy];
const polygon = (ring: XY[], properties: Properties): Feature<Polygon, Properties> => ({
  type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!].map(geographic)] },
});

function spatialLookup(features: readonly Item[]): (position: XY) => Item | undefined {
  const cells = new Map<string, Array<{ feature: Item; rings: XY[][] }>>();
  for (const feature of features) {
    if (feature.geometry.type !== 'Polygon') continue;
    const rings = feature.geometry.coordinates.map((ring) => ring.map(local));
    const xs = rings[0]!.map(([x]) => x), ys = rings[0]!.map(([, y]) => y);
    for (let x = Math.floor(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x += 1) {
      for (let y = Math.floor(Math.min(...ys)); y <= Math.floor(Math.max(...ys)); y += 1) {
        const key = `${x}:${y}`;
        cells.set(key, [...(cells.get(key) ?? []), { feature, rings }]);
      }
    }
  }
  return (position) => cells.get(`${Math.floor(position[0])}:${Math.floor(position[1])}`)
    ?.find(({ rings }) => pointInRing(position, rings[0]!) && !rings.slice(1).some((ring) => pointInRing(position, ring)))?.feature;
}

export function generateAtlas(
  monaco: Feature<Polygon, Properties>, districts: readonly Item[], surfaces: readonly Item[],
  bands: readonly Item[], blocks: readonly Item[], elevation: (position: XY) => number,
): Item[] {
  const districtAt = spatialLookup(districts);
  const woodAt = spatialLookup(surfaces.filter((item) => item.properties?.kind === 'wood'));
  const farmAt = spatialLookup(surfaces.filter((item) => item.properties?.kind === 'farm'));
  const bandAt = spatialLookup([...bands].reverse());
  const blockAt = spatialLookup(blocks);
  const classify = (position: XY): Properties => {
    const district = String(districtAt(position)?.properties?.id ?? 'monaco');
    if (woodAt(position)) return { class: 'wood', district };
    if (farmAt(position)) return { class: 'farm', district };
    const block = blockAt(position);
    if (block) return { class: String(block.properties?.type ?? 'lowrise'), district };
    const band = bandAt(position);
    if (band) return { class: 'hill', level: Number(band.properties?.level ?? 0), district };
    return { class: 'district', district };
  };
  const output: Item[] = [];
  const ring = monaco.geometry.coordinates[0]!.map(local);
  const minX = Math.min(...ring.map(([x]) => x)), maxX = Math.max(...ring.map(([x]) => x));
  const minY = Math.min(...ring.map(([, y]) => y)), maxY = Math.max(...ring.map(([, y]) => y));
  const radius = 0.5, height = Math.sqrt(3) * radius;
  let index = 0;
  for (let column = Math.floor(minX / (1.5 * radius)); column <= Math.ceil(maxX / (1.5 * radius)); column += 1) {
    for (let row = Math.floor(minY / height) - 1; row <= Math.ceil(maxY / height); row += 1) {
      const center: XY = [column * 1.5 * radius, (row + (column % 2 ? 0.5 : 0)) * height];
      const corners: XY[] = Array.from({ length: 6 }, (_, vertex) => [
        center[0] + radius * Math.cos(vertex * Math.PI / 3), center[1] + radius * Math.sin(vertex * Math.PI / 3),
      ]);
      const clipped = intersect(featureCollection([monaco, polygon(corners, {})]));
      if (!clipped || area(clipped) < 1000) continue;
      const parts = clipped.geometry.type === 'Polygon' ? [clipped.geometry.coordinates] : clipped.geometry.coordinates;
      for (const coordinates of parts) {
        const geometry: Polygon = { type: 'Polygon', coordinates: coordinates.map((path) => path.map(([x, y]) => [Number(x!.toFixed(6)), Number(y!.toFixed(6))])) };
        const cell: Feature<Polygon, Properties> = { type: 'Feature', properties: {}, geometry };
        if (area(cell) < 1000) continue;
        const anchor = local(pointOnFeature(cell).geometry.coordinates);
        const cellRings = geometry.coordinates.map((path) => path.map(local));
        const samples = [anchor, ...corners.map(([x, y]): XY => [(x + center[0]) / 2, (y + center[1]) / 2])]
          .filter((position) => pointInRing(position, cellRings[0]!) && !cellRings.slice(1).some((hole) => pointInRing(position, hole)));
        const votes = new Map<string, { count: number; properties: Properties }>();
        for (const sample of samples.length ? samples : [anchor]) {
          const properties = classify(sample), key = JSON.stringify(properties);
          const vote = votes.get(key) ?? { count: 0, properties }; vote.count += 1; votes.set(key, vote);
        }
        const dominant = [...votes.values()].sort((a, b) => b.count - a.count)[0]!.properties;
        cell.properties = { kind: 'hex', ...dominant };
        output.push(cell);
        if (woodAt(anchor) && index % 3 === 0) output.push({ type: 'Feature',
          geometry: { type: 'Point', coordinates: geographic(anchor) }, properties: { kind: 'clump', variant: index % 2 } });
        index += 1;
      }
    }
  }
  const beverly = districts.find((item) => item.properties?.id === 'beverly' && item.geometry.type === 'Polygon') as Feature<Polygon, Properties> | undefined;
  if (!beverly) return output;
  const bounds = beverly.geometry.coordinates[0]!.map(local);
  const shadeMinX = Math.min(...bounds.map(([x]) => x)), shadeMaxX = Math.max(...bounds.map(([x]) => x));
  const shadeMinY = Math.min(...bounds.map(([, y]) => y)), shadeMaxY = Math.max(...bounds.map(([, y]) => y));
  const step = 0.4;
  for (let x = shadeMinX; x < shadeMaxX; x += step) for (let y = shadeMinY; y < shadeMaxY; y += step) {
    const center: XY = [x + step / 2, y + step / 2];
    if (elevation(center) < 35) continue;
    const dx = (elevation([center[0] + 0.05, center[1]]) - elevation([center[0] - 0.05, center[1]])) / 100;
    const dy = (elevation([center[0], center[1] + 0.05]) - elevation([center[0], center[1] - 0.05])) / 100;
    const aspect = (-dx * MAP_LIGHT.east - dy * MAP_LIGHT.north) / Math.sqrt(dx * dx + dy * dy + 0.04);
    const clipped = intersect(featureCollection([beverly, polygon([[x, y], [x + step, y], [x + step, y + step], [x, y + step]], {})]));
    if (!clipped) continue;
    const parts = clipped.geometry.type === 'Polygon' ? [clipped.geometry.coordinates] : clipped.geometry.coordinates;
    for (const coordinates of parts) output.push({ type: 'Feature', properties: { kind: 'hillshade', shade: Number(aspect.toFixed(3)) },
      geometry: { type: 'Polygon', coordinates: coordinates.map((path) => path.map(([lon, lat]) => [Number(lon!.toFixed(6)), Number(lat!.toFixed(6))])) } });
  }
  return output;
}
