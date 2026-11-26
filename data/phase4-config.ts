import { rectangleRing } from './geometry';
import type { XY } from './source';

export const centralTerrain = { core: [11.6, 3.6] as XY, coreRadiusKm: 1.5, angleDegrees: 11 };
export const airport = {
  center: [25.5, 12.5] as XY,
  angle: 8 * Math.PI / 180,
  width: 4,
  depth: 3.8,
  runwayLength: 3.4,
  runwayWidth: 0.06,
  runwaySeparation: 1.7,
};
export function airportPosition(east: number, north: number): XY {
  return [airport.center[0] + east * Math.cos(airport.angle) - north * Math.sin(airport.angle),
    airport.center[1] + east * Math.sin(airport.angle) + north * Math.cos(airport.angle)];
}
export const airportRing = rectangleRing(airport.center, airport.width, airport.depth, airport.angle);
export const airportRunways = [-airport.runwaySeparation / 2, airport.runwaySeparation / 2]
  .map((north) => [airportPosition(-airport.runwayLength / 2, north), airportPosition(airport.runwayLength / 2, north)] as const);
export const airportApron = rectangleRing(airportPosition(0, 0.25), 2.5, 0.85, airport.angle);
export const airportTaxiways = [-0.6, 0.6].map((north) =>
  rectangleRing(airportPosition(0, north), airport.runwayLength, 0.025, airport.angle));
export const airportPiers = [-0.4, 0, 0.4].map((east) =>
  rectangleRing(airportPosition(east, -0.045), 0.055, 0.36, airport.angle));
export const airportAircraft = [-0.55, -0.25, -0.15, 0.15, 0.25, 0.55].map((east) =>
  [[0, 0.09], [0.015, 0.025], [0.085, -0.025], [0.015, -0.012], [0.012, -0.065],
    [0.04, -0.085], [-0.04, -0.085], [-0.012, -0.065], [-0.015, -0.012], [-0.085, -0.025],
    [-0.015, 0.025], [0, 0.09]].map(([x, y]) => airportPosition(east + x!, 0.3 + y!)));
