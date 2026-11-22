export type XY = readonly [number, number];
export type Ring = readonly XY[];

export interface DistrictDefinition {
  id: string;
  name: string;
  kind: 'urban' | 'military' | 'reserve';
  ring: Ring;
}

export interface LandDefinition {
  kind: 'monaco' | 'ottoman' | 'east-region';
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
  roadClass: 'motorway' | 'arterial' | 'street';
  coordinates: Ring;
}

const rectangle = (west: number, south: number, east: number, north: number): Ring => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

export const districts: readonly DistrictDefinition[] = [
  {
    id: 'manhattan', name: '曼哈顿区', kind: 'urban',
    ring: [[0, 0], [0, 9], [9, 9], [9, 0], [1, -2], [-2, -2], [-2, 0], [0, 0]],
  },
  { id: 'beverly', name: '比弗利区', kind: 'urban', ring: rectangle(9, 0, 36, 9) },
  { id: 'st-germain', name: '圣日尔曼区', kind: 'urban', ring: rectangle(0, 9, 16, 17) },
  { id: 'harlem', name: '哈林区', kind: 'urban', ring: rectangle(16, 9, 36, 17) },
  { id: 'uptown', name: '上城区', kind: 'urban', ring: rectangle(0, 17, 16, 25) },
  { id: 'brooklyn', name: '布鲁克林区', kind: 'urban', ring: rectangle(16, 17, 36, 25) },
  { id: 'fleet-port', name: '舰队港', kind: 'military', ring: rectangle(0, 25, 13, 34) },
  { id: 'reserve', name: '保留地', kind: 'reserve', ring: rectangle(13, 25, 36, 34) },
];

export const land: readonly LandDefinition[] = [
  {
    kind: 'monaco',
    ring: [[0, 34], [36, 34], [36, 0], [9, 0], [1, -2], [-2, -2], [-2, 0], [0, 0], [0, 34]],
  },
  { kind: 'ottoman', id: 'ottoman', name: '奥斯曼', ring: rectangle(-2, 34, 36, 43) },
  { kind: 'east-region', id: 'east-region', name: '东邻自治区', ring: rectangle(36, -2, 45, 34) },
];

export const parks = [
  {
    id: 'central-park', name: '中央公园',
    ring: rectangle(4.5, 5.5, 6.1, 7.7),
  },
  {
    id: 'battery-park', name: '炮台公园',
    ring: [[-1.45, -1.75], [-0.25, -1.8], [-0.08, -0.75], [-1.3, -0.65], [-1.45, -1.75]],
  },
] as const;

export const points: readonly PointDefinition[] = [
  { id: 'strait-exchange', name: '海峡交易所', category: '地标', district: '曼哈顿区', position: [0, 0] },
  { id: 'continental-tower', name: '大陆集团大厦', category: '地标', district: '曼哈顿区', position: [4.3, 1.45] },
  { id: 'exchange-square', name: '交易广场', category: '地标', district: '曼哈顿区', position: [7.1, 1.55] },
  { id: 'wall-street', name: '华尔街', category: '街道', district: '曼哈顿区', position: [0.35, -0.45] },
  { id: 'queens-road', name: '皇后大道', category: '街道', district: '曼哈顿区', position: [2, 3.2] },
  { id: 'fifth-avenue', name: '第五大道', category: '街道', district: '曼哈顿区', position: [6, 4.2] },
  { id: 'broadway', name: '百老汇大道', category: '街道', district: '曼哈顿区', position: [4.5, 3.35] },
  { id: 'times-square', name: '时代广场', category: '广场', district: '曼哈顿区', position: [6.3, 5.25] },
  { id: 'midtown', name: '中城', category: '地段', district: '曼哈顿区', position: [7.65, 5.9] },
  { id: 'central-park', name: '中央公园', category: '公园', district: '曼哈顿区', position: [5.05, 6.25] },
  { id: 'battery-park', name: '炮台公园', category: '公园', district: '曼哈顿区', position: [-1.25, -1.05] },
  { id: 'promenade', name: '海滨长廊', category: '地点', district: '曼哈顿区', position: [2.1, -0.3] },
  { id: 'star-ferry', name: '天星码头', category: '码头', district: '曼哈顿区', position: [8.1, 0.2] },
  { id: 'city-hall', name: '市政府', category: '地标', district: '上城区', position: [7.1, 20.4] },
  { id: 'hospital', name: '大医院', category: '地标', district: '上城区', position: [10.1, 21.8] },
  { id: 'library', name: '图书馆', category: '地标', district: '上城区', position: [12.6, 20.2] },
  { id: 'north-checkpoint', name: '北部口岸', category: '口岸', district: '北部边境', position: [13, 34] },
];

export const stations: readonly StationDefinition[] = [
  { id: 'station-battery-park', name: '炮台公园', district: '曼哈顿区', position: [-0.8, -1.25] },
  { id: 'station-strait-exchange', name: '海峡交易所', district: '曼哈顿区', position: [0.35, 0.25] },
  { id: 'station-times-square', name: '时代广场', district: '曼哈顿区', position: [6, 5] },
  { id: 'station-central-park', name: '中央公园', district: '曼哈顿区', position: [5.8, 7.1] },
  { id: 'station-st-germain', name: '圣日尔曼', district: '圣日尔曼区', position: [8, 13] },
  { id: 'station-city-hall', name: '市政府', district: '上城区', position: [7.45, 20.75] },
  { id: 'station-hospital', name: '大医院', district: '上城区', position: [10.55, 22.1] },
  { id: 'station-continental-tower', name: '大陆集团大厦', district: '曼哈顿区', position: [4.65, 1.8] },
  { id: 'station-exchange-square', name: '交易广场', district: '曼哈顿区', position: [7.45, 1.9] },
  { id: 'station-beverly', name: '比弗利', district: '比弗利区', position: [23, 5] },
  { id: 'station-beverly-east', name: '比弗利东', district: '比弗利区', position: [33, 5] },
  { id: 'station-harlem', name: '哈林', district: '哈林区', position: [25, 13] },
  { id: 'station-brooklyn', name: '布鲁克林', district: '布鲁克林区', position: [25, 21] },
  { id: 'station-reserve-south', name: '保留地南', district: '保留地', position: [23, 25.2] },
];

export const transitLines: readonly TransitLineDefinition[] = [
  {
    id: 'U1', color: '#D32F2F',
    stations: ['station-battery-park', 'station-strait-exchange', 'station-times-square', 'station-central-park', 'station-st-germain', 'station-city-hall', 'station-hospital'],
  },
  {
    id: 'U2', color: '#1976D2',
    stations: ['station-strait-exchange', 'station-continental-tower', 'station-exchange-square', 'station-beverly', 'station-beverly-east'],
  },
  {
    id: 'U3', color: '#388E3C',
    stations: ['station-times-square', 'station-harlem', 'station-brooklyn', 'station-reserve-south'],
  },
];

const fifthAvenue: Ring = [[6, 2.3], [6, 8.6]];
const broadway: Ring = [[3.7, 2.5], [4.5, 3.35], [6, 5], [7.2, 6.35], [8.5, 7.7]];
const queensRoad: Ring = [[-0.4, 3.45], [1.2, 3.2], [3.2, 3.1], [5.4, 3.35], [7.3, 3.55], [9.2, 3.35]];
const wallStreet: Ring = [[-0.4, -0.45], [0.35, -0.45], [1.1, -0.42]];

export const roads: readonly RoadDefinition[] = [
  { id: 'A1', name: 'A1', roadClass: 'motorway', coordinates: [[7, 3], [4, 8], [4, 13], [8, 19], [8, 21], [11, 25], [13, 28], [13, 34], [13, 36]] },
  { id: 'A2', name: 'A2', roadClass: 'motorway', coordinates: [[7, 3], [15, 3], [24, 4], [36, 4], [41, 4]] },
  { id: 'A3', name: 'A3', roadClass: 'motorway', coordinates: [[8, 21], [16, 21], [21, 20], [23, 17], [25, 13], [29, 9], [33, 7], [36, 4]] },
  { id: 'fifth-avenue', name: '第五大道', roadClass: 'arterial', coordinates: fifthAvenue },
  { id: 'broadway', name: '百老汇大道', roadClass: 'arterial', coordinates: broadway },
  { id: 'queens-road', name: '皇后大道', roadClass: 'arterial', coordinates: queensRoad },
  { id: 'wall-street', name: '华尔街', roadClass: 'arterial', coordinates: wallStreet },
  { id: 'street-01', name: '', roadClass: 'street', coordinates: [[1.5, 4.1], [8.7, 4.1]] },
  { id: 'street-02', name: '', roadClass: 'street', coordinates: [[1.5, 4.8], [8.7, 4.8]] },
  { id: 'street-03', name: '', roadClass: 'street', coordinates: [[1.5, 5.6], [8.7, 5.6]] },
  { id: 'street-04', name: '', roadClass: 'street', coordinates: [[1.5, 6.4], [8.7, 6.4]] },
  { id: 'street-05', name: '', roadClass: 'street', coordinates: [[1.5, 7.2], [8.7, 7.2]] },
  { id: 'street-06', name: '', roadClass: 'street', coordinates: [[1.5, 8], [8.7, 8]] },
  { id: 'street-07', name: '', roadClass: 'street', coordinates: [[2, 3.8], [2, 8.6]] },
  { id: 'street-08', name: '', roadClass: 'street', coordinates: [[3, 3.8], [3, 8.6]] },
  { id: 'street-09', name: '', roadClass: 'street', coordinates: [[4, 3.8], [4, 8.6]] },
  { id: 'street-10', name: '', roadClass: 'street', coordinates: [[5, 3.8], [5, 8.6]] },
  { id: 'street-11', name: '', roadClass: 'street', coordinates: [[7, 3.8], [7, 8.6]] },
  { id: 'street-12', name: '', roadClass: 'street', coordinates: [[8, 3.8], [8, 8.6]] },
];

export const metropolitanBounds = {
  west: -2,
  south: -2,
  east: 45,
  north: 43,
} as const;

export function stationDistrict(id: string): string | undefined {
  return stations.find((station) => station.id === id)?.district;
}
