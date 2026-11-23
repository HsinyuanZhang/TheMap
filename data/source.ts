import {
  chaikinOpen,
  closeRing,
  curvedBoundary,
  reversePath,
  splitPathAtX,
  splitPathAtY,
  stitchPaths,
  type XY as GeometryXY,
} from "./geometry";

export type XY = readonly [number, number];
export type Ring = readonly XY[];

export interface DistrictDefinition {
  id: string;
  name: string;
  kind: "urban" | "military" | "reserve";
  ring: Ring;
}

export interface LandDefinition {
  kind: "monaco" | "ottoman" | "east-region";
  id?: string;
  name?: string;
  ring: Ring;
}

export interface PointDefinition {
  id: string;
  name: string;
  category: string;
  district: string;
  position: XY;
}

export interface StationDefinition {
  id: string;
  name: string;
  district: string;
  position: XY;
}

export interface TransitLineDefinition {
  id: string;
  color: string;
  stations: readonly string[];
}

export interface RoadDefinition {
  id: string;
  name: string;
  roadClass: "motorway" | "arterial" | "street";
  width: number;
  coordinates: Ring;
}

export interface ParkDefinition {
  id: string;
  name: string;
  kind: "park";
  ring: Ring;
}

export interface BoundaryDefinition {
  id: string;
  kind: "coastline" | "north-border";
  coordinates: Ring;
}

export const coastlineControls: readonly XY[] = [
  [0.4, 34], [-0.3, 31.5], [1.8, 30.2], [3.6, 29], [3.9, 27.4],
  [2.2, 26.2], [0.3, 25.6], [-0.6, 23], [0.2, 20], [-0.4, 17],
  [0.3, 14], [-0.2, 11], [0.1, 8.6], [-0.35, 6.4], [-0.15, 4.4],
  [-0.8, 2.8], [-1.6, 1.3], [-2.1, -0.2], [-1.9, -1.4], [-1, -2],
  [0.3, -1.85], [1.5, -1.2], [3.1, -0.85], [5, -0.5], [7, -0.25],
  [9, 0.05], [13, 0.3], [18, -0.2], [24, 0.4], [30, -0.1], [36, 0.2],
];

export const coastline: readonly XY[] = chaikinOpen(coastlineControls, 3) as readonly XY[];

const [coastNorth25, coast25ToEast] = splitPathAtY(coastline, 25);
const [coast25To17, coast17ToEast] = splitPathAtY(coast25ToEast, 17);
const [coast17To9, coast9ToEast] = splitPathAtY(coast17ToEast, 9);
const west9 = coast17To9[coast17To9.length - 1]!;
const west17 = coast25To17[coast25To17.length - 1]!;
const west25 = coastNorth25[coastNorth25.length - 1]!;
const coast9To17 = reversePath(coast17To9);
const coast17To25 = reversePath(coast25To17);
const southernCoast = coast9ToEast;
const [coast9ToManhattanPoint, coastManhattanPointToEast] = splitPathAtX(southernCoast, 9);
const manhattanSouthEast = coast9ToManhattanPoint[coast9ToManhattanPoint.length - 1]!;

const manhattanStGermain = curvedBoundary(west9 as GeometryXY, [9, 9], 0.22, 0.4);
const stGermainBeverly = curvedBoundary([9, 9], [16, 9], 0.2, 2.1);
const beverlyHarlem = curvedBoundary([16, 9], [36, 9], 0.2, 1.2);
const stGermainHarlem = curvedBoundary([16, 9], [16, 17], 0.18, 0.7);
const stGermainUptown = curvedBoundary(west17 as GeometryXY, [16, 17], 0.22, 1.1);
const harlemBrooklyn = curvedBoundary([16, 17], [36, 17], 0.22, 0.9);
const uptownBrooklyn = curvedBoundary([16, 17], [16, 25], 0.18, 1.9);
const uptownFleetPort = curvedBoundary(west25 as GeometryXY, [13, 25], 0.2, 2.5);
const uptownReserve = curvedBoundary([13, 25], [16, 25], 0.14, 0.4);
const brooklynReserve = curvedBoundary([16, 25], [36, 25], 0.2, 2.2);
const fleetPortReserve = curvedBoundary([13, 25], [13, 34], 0.16, 0.5);
const manhattanBeverly = curvedBoundary(manhattanSouthEast as GeometryXY, [9, 9], 0.16, 1.5);
const fleetPortNorth = curvedBoundary([0.4, 34], [13, 34], 0.1, 2.6);
const reserveNorth = curvedBoundary([13, 34], [36, 34], 0.1, 1.8);
const northernBorder = stitchPaths(fleetPortNorth, reserveNorth);
const eastLower = [[36, 0.2], [36, 9]] as const;
const eastMiddle = [[36, 9], [36, 17]] as const;
const eastUpper = [[36, 17], [36, 25]] as const;
const eastNorth = [[36, 25], [36, 34]] as const;
const ottomanWestCoast = chaikinOpen([[0.4, 34], [-0.5, 35.1], [-1.4, 36.2], [-2, 37]], 3);
const eastRegionSouthCoast = chaikinOpen([[36, 0.2], [39, 0.05], [42, -0.4], [45, -0.5], [47, 1]], 3);

const manhattanRing = closeRing(stitchPaths(
  manhattanStGermain,
  reversePath(manhattanBeverly),
  reversePath(coast9ToManhattanPoint),
));
const beverlyRing = closeRing(stitchPaths(
  coastManhattanPointToEast,
  eastLower,
  reversePath(beverlyHarlem),
  reversePath(stGermainBeverly),
  reversePath(manhattanBeverly),
));
const stGermainRing = closeRing(stitchPaths(
  manhattanStGermain,
  stGermainBeverly,
  stGermainHarlem,
  reversePath(stGermainUptown),
  reversePath(coast9To17),
));
const harlemRing = closeRing(stitchPaths(
  beverlyHarlem,
  eastMiddle,
  reversePath(harlemBrooklyn),
  reversePath(stGermainHarlem),
));
const uptownRing = closeRing(stitchPaths(
  stGermainUptown,
  uptownBrooklyn,
  reversePath(uptownReserve),
  reversePath(uptownFleetPort),
  reversePath(coast17To25),
));
const brooklynRing = closeRing(stitchPaths(
  harlemBrooklyn,
  eastUpper,
  reversePath(brooklynReserve),
  reversePath(uptownBrooklyn),
));
const fleetPortRing = closeRing(stitchPaths(
  uptownFleetPort,
  fleetPortReserve,
  reversePath(fleetPortNorth),
  coastNorth25,
));
const reserveRing = closeRing(stitchPaths(
  uptownReserve,
  brooklynReserve,
  eastNorth,
  reversePath(reserveNorth),
  reversePath(fleetPortReserve),
));

export const districts: readonly DistrictDefinition[] = [
  { id: "manhattan", name: "曼哈顿区", kind: "urban", ring: manhattanRing },
  { id: "beverly", name: "比弗利区", kind: "urban", ring: beverlyRing },
  { id: "st-germain", name: "圣日尔曼区", kind: "urban", ring: stGermainRing },
  { id: "harlem", name: "哈林区", kind: "urban", ring: harlemRing },
  { id: "uptown", name: "上城区", kind: "urban", ring: uptownRing },
  { id: "brooklyn", name: "布鲁克林区", kind: "urban", ring: brooklynRing },
  { id: "fleet-port", name: "舰队港", kind: "military", ring: fleetPortRing },
  { id: "reserve", name: "保留地", kind: "reserve", ring: reserveRing },
];

const monacoRing = closeRing(stitchPaths(
  northernBorder,
  [[36, 34], [36, 0.2]],
  reversePath(coastline),
));
const ottomanRing = closeRing(stitchPaths(
  northernBorder,
  [[36, 34], [36, 43], [22, 44], [2, 43], [-2, 41], [-2, 37]],
  reversePath(ottomanWestCoast),
));
const eastRegionRing = closeRing(stitchPaths(
  eastRegionSouthCoast,
  [[47, 1], [47, 34], [36, 34]],
  [[36, 34], [36, 0.2]],
));

export const land: readonly LandDefinition[] = [
  { kind: "monaco", ring: monacoRing },
  { kind: "ottoman", id: "ottoman", name: "奥斯曼", ring: ottomanRing },
  { kind: "east-region", id: "east-region", name: "东邻自治区", ring: eastRegionRing },
];

const batteryParkRing = closeRing([
  [-1.35, -1.52], [-0.12, -1.52], [-0.12, -1.36], [-0.9, -1.36],
  [-0.9, -1.14], [-0.12, -1.14], [-0.08, -0.65], [-1.3, -0.65],
  [-1.35, -1.52],
]);

export const parks: readonly ParkDefinition[] = [
  {
    id: "central-park", name: "中央公园", kind: "park",
    ring: [[4.336, 5.482], [5.896, 5.482], [5.896, 7.69], [4.336, 7.69], [4.336, 5.482]],
  },
  { id: "battery-park", name: "炮台公园", kind: "park", ring: batteryParkRing },
];

const coastYAtX = (x: number): number => {
  let southernmost: number | undefined;
  for (let index = 1; index < southernCoast.length; index += 1) {
    const a = southernCoast[index - 1]!;
    const b = southernCoast[index]!;
    if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0]) || Math.abs(a[0] - b[0]) < 1e-10) continue;
    const t = (x - a[0]) / (b[0] - a[0]);
    const candidate = a[1] + (b[1] - a[1]) * t;
    if (southernmost === undefined || candidate < southernmost) southernmost = candidate;
  }
  if (southernmost !== undefined) return southernmost;
  throw new Error("Coastline does not cross the requested x-coordinate.");
};

const promenadeCoordinates: Ring = Array.from({ length: 30 }, (_, index) => {
  const x = 1.5 + index * (7.3 / 29);
  return [x, coastYAtX(x) + 0.025] as const;
});

export const points: readonly PointDefinition[] = [
  { id: "strait-exchange", name: "海峡交易所", category: "地标", district: "曼哈顿区", position: [0, 0] },
  { id: "continental-tower", name: "大陆集团大厦", category: "地标", district: "曼哈顿区", position: [4.3, 1.45] },
  { id: "exchange-square", name: "交易广场", category: "地标", district: "曼哈顿区", position: [7.1, 1.55] },
  { id: "wall-street", name: "华尔街", category: "街道", district: "曼哈顿区", position: [0.35, -0.45] },
  { id: "queens-road", name: "皇后大道", category: "街道", district: "曼哈顿区", position: [2, 3.45] },
  { id: "fifth-avenue", name: "第五大道", category: "街道", district: "曼哈顿区", position: [5.908, 4.2] },
  { id: "broadway", name: "百老汇大道", category: "街道", district: "曼哈顿区", position: [4.5, 3.35] },
  { id: "times-square", name: "时代广场", category: "广场", district: "曼哈顿区", position: [5.908, 5.013] },
  { id: "midtown", name: "中城", category: "地段", district: "曼哈顿区", position: [7.65, 5.9] },
  { id: "central-park", name: "中央公园", category: "公园", district: "曼哈顿区", position: [5.05, 6.25] },
  { id: "battery-park", name: "炮台公园", category: "公园", district: "曼哈顿区", position: [-1.25, -1.05] },
  { id: "promenade", name: "海滨长廊", category: "地点", district: "曼哈顿区", position: [2.1, coastYAtX(2.1) + 0.025] },
  { id: "star-ferry", name: "天星码头", category: "码头", district: "曼哈顿区", position: [8.1, coastYAtX(8.1) + 0.005] },
  { id: "city-hall", name: "市政府", category: "地标", district: "上城区", position: [7.1, 20.4] },
  { id: "hospital", name: "大医院", category: "地标", district: "上城区", position: [10.1, 21.8] },
  { id: "library", name: "图书馆", category: "地标", district: "上城区", position: [12.6, 20.2] },
  { id: "north-checkpoint", name: "北部口岸", category: "口岸", district: "北部边境", position: [13, 34] },
];

export const stations: readonly StationDefinition[] = [
  { id: "station-battery-park", name: "炮台公园", district: "曼哈顿区", position: [-0.8, -1.25] },
  { id: "station-strait-exchange", name: "海峡交易所", district: "曼哈顿区", position: [0.473172, 0.149533] },
  { id: "station-times-square", name: "时代广场", district: "曼哈顿区", position: [5.908, 5.013] },
  { id: "station-central-park", name: "中央公园", district: "曼哈顿区", position: [5.908, 7.129] },
  { id: "station-st-germain", name: "圣日尔曼", district: "圣日尔曼区", position: [8, 13] },
  { id: "station-city-hall", name: "市政府", district: "上城区", position: [7.45, 20.75] },
  { id: "station-hospital", name: "大医院", district: "上城区", position: [10.55, 22.1] },
  { id: "station-continental-tower", name: "大陆集团大厦", district: "曼哈顿区", position: [4.627522, 1.762421] },
  { id: "station-exchange-square", name: "交易广场", district: "曼哈顿区", position: [7.425816, 1.860139] },
  { id: "station-beverly", name: "比弗利", district: "比弗利区", position: [23, 5] },
  { id: "station-beverly-east", name: "比弗利东", district: "比弗利区", position: [33, 5] },
  { id: "station-harlem", name: "哈林", district: "哈林区", position: [25, 13] },
  { id: "station-brooklyn", name: "布鲁克林", district: "布鲁克林区", position: [25, 21] },
  { id: "station-reserve-south", name: "保留地南", district: "保留地", position: [23, 25] },
];

export const transitLines: readonly TransitLineDefinition[] = [
  {
    id: "U1", color: "#D32F2F",
    stations: ["station-battery-park", "station-strait-exchange", "station-times-square", "station-central-park", "station-st-germain", "station-city-hall", "station-hospital"],
  },
  {
    id: "U2", color: "#1976D2",
    stations: ["station-strait-exchange", "station-continental-tower", "station-exchange-square", "station-beverly", "station-beverly-east"],
  },
  {
    id: "U3", color: "#388E3C",
    stations: ["station-times-square", "station-harlem", "station-brooklyn", "station-reserve-south"],
  },
];

export const urbanGrid = {
  grid: { west: 0.2, east: 9.2, south: 3.55, blockWidth: 0.236, blockDepth: 0.074, stepX: 0.26, stepY: 0.092 },
  financial: { bounds: [-2.05, -1.72, 1.8, 2.2] as const, blockWidth: 0.11, blockDepth: 0.085, stepX: 0.132, stepY: 0.105, angleDegrees: 24, roadWidth: 0.019 },
  reclamation: { bounds: [2.75, -1.35, 9.2, 3.43] as const, blockWidth: 0.17, blockDepth: 0.14, stepX: 0.2, stepY: 0.17, angleDegrees: 2, roadWidth: 0.03 },
} as const;

const financialStreetAngle = urbanGrid.financial.angleDegrees * Math.PI / 180;
const financialStreetOrigin: XY = [0.15, 0.75];
const financialStreetV = urbanGrid.financial.bounds[1] + 4 * urbanGrid.financial.stepY
  + urbanGrid.financial.blockDepth + (urbanGrid.financial.stepY - urbanGrid.financial.blockDepth) / 2;
const financialStreetPoint = (u: number): XY => [
  financialStreetOrigin[0] + u * Math.cos(financialStreetAngle) - financialStreetV * Math.sin(financialStreetAngle),
  financialStreetOrigin[1] + u * Math.sin(financialStreetAngle) + financialStreetV * Math.cos(financialStreetAngle),
];
const financialStreetStartU = (-financialStreetOrigin[0] + financialStreetV * Math.sin(financialStreetAngle))
  / Math.cos(financialStreetAngle);
const wallStreetCoordinates: Ring = [
  financialStreetPoint(financialStreetStartU),
  financialStreetPoint(urbanGrid.financial.bounds[2]),
];

export const roads: readonly RoadDefinition[] = [
  { id: "A1", name: "A1", roadClass: "motorway", width: 0.05, coordinates: [[3.2, 3.4555], [4, 8], [4, 13], [8, 19], [8, 21], [11, 25], [13, 28], [13, 36]] },
  { id: "A2", name: "A2", roadClass: "motorway", width: 0.05, coordinates: [[7.7, 3.465], [15, 3.5], [24, 4], [36, 4], [41, 4]] },
  { id: "A3", name: "A3", roadClass: "motorway", width: 0.05, coordinates: [[8, 21], [16, 21], [21, 19], [23, 17], [27, 14], [29, 9], [33, 7], [36, 4]] },
  { id: "fifth-avenue", name: "第五大道", roadClass: "arterial", width: 0.024, coordinates: [[5.908, 3.45], [5.908, 9.2]] },
  { id: "broadway", name: "百老汇大道", roadClass: "arterial", width: 0.034, coordinates: [[2.8, 1.6], [3.7, 2.5], [4.5, 3.35], [5.908, 5.013], [7.2, 6.35], [8.5, 7.7], [9.15, 8.35]] },
  { id: "queens-road", name: "皇后大道", roadClass: "arterial", width: 0.034, coordinates: [[-0.25, 3.45], [1.5, 3.43], [3.5, 3.46], [5.5, 3.5], [7.7, 3.465], [9.25, 3.45]] },
  { id: "wall-street", name: "华尔街", roadClass: "arterial", width: 0.019, coordinates: wallStreetCoordinates },
  { id: "promenade", name: "海滨长廊", roadClass: "arterial", width: 0.008, coordinates: promenadeCoordinates },
  { id: "battery-access", name: "", roadClass: "street", width: 0.018, coordinates: [[-0.8, -1.25], [-0.05, -1.25]] },
  { id: "battery-junction", name: "", roadClass: "street", width: 0.018, coordinates: [[-0.8, -1.31], [-0.8, -1.19]] },
  { id: "battery-link", name: "", roadClass: "street", width: 0.018, coordinates: [[-0.05, -1.25], [-0.05, -0.65]] },
];

export const regionalDistrictBounds = {
  "beverly": [9, 0, 36, 9],
  "st-germain": [0, 9, 16, 17],
  "harlem": [16, 9, 36, 17],
  "uptown": [0, 17, 16, 25],
  "brooklyn": [16, 17, 36, 25],
} as const;

export const generatedBoundaries: readonly BoundaryDefinition[] = [
  { id: "coastline", kind: "coastline", coordinates: coastline },
  { id: "north-border", kind: "north-border", coordinates: northernBorder },
];


const allLandPoints = land.flatMap(({ ring }) => ring);
export const metropolitanBounds = {
  west: Math.min(...allLandPoints.map(([x]) => x)),
  south: Math.min(...allLandPoints.map(([, y]) => y)),
  east: Math.max(...allLandPoints.map(([x]) => x)),
  north: Math.max(...allLandPoints.map(([, y]) => y)),
} as const;

export const internalBoundaries = [
  { id: "manhattan-st-germain", coordinates: manhattanStGermain },
  { id: "manhattan-beverly", coordinates: manhattanBeverly },
  { id: "st-germain-beverly", coordinates: stGermainBeverly },
  { id: "beverly-harlem", coordinates: beverlyHarlem },
  { id: "st-germain-harlem", coordinates: stGermainHarlem },
  { id: "st-germain-uptown", coordinates: stGermainUptown },
  { id: "harlem-brooklyn", coordinates: harlemBrooklyn },
  { id: "uptown-brooklyn", coordinates: uptownBrooklyn },
  { id: "uptown-fleet-port", coordinates: uptownFleetPort },
  { id: "uptown-reserve", coordinates: uptownReserve },
  { id: "brooklyn-reserve", coordinates: brooklynReserve },
  { id: "fleet-port-reserve", coordinates: fleetPortReserve },
] as const;

export function stationDistrict(id: string): string | undefined {
  return stations.find((station) => station.id === id)?.district;
}

export function coastlineYAtX(x: number): number {
  return coastYAtX(x);
}
