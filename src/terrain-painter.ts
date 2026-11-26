import { MAP_LIGHT } from './map-light';
import { smooth } from './terrain-elevation';
import { noise, toKm, worldHash, type Surface, type WorldModel, type XY } from './world-model';

export const PAINT = { tileSize: 512, bleed: 48, minzoom: 7, maxzoom: 14, middle: 11.7, close: 13.5, fade: 0.3, cacheBytes: 96 * 1024 * 1024 } as const;
export const SURFACE_COLORS: Record<Surface, readonly [number, number, number]> = {
  sea: [16, 52, 94], wood: [85, 123, 66], farm: [183, 187, 120], lowdensity: [177, 194, 139],
  lowrise: [211, 197, 171], midrise: [199, 197, 187], highrise: [176, 190, 201], town: [215, 193, 158],
  park: [148, 177, 113], military: [155, 169, 153], airport: [153, 176, 112], foreign: [151, 142, 113], lake: [78, 135, 155], pier: [154, 139, 114],
};
const FIELDS = [[195, 187, 115], [173, 183, 114], [203, 193, 132], [144, 165, 102], [190, 171, 111], [181, 191, 137], [163, 168, 111]];
export interface PaintView { west: number; north: number; east: number; south: number; width: number; height: number; zoom: number; pitch?: number; buildings?: boolean; }
export interface Pixels { width: number; height: number; data: Uint8ClampedArray; }
export function tileView(z: number, x: number, y: number, zoom = z): PaintView {
  if (![z, x, y].every(Number.isInteger) || z < PAINT.minzoom || z > PAINT.maxzoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new Error('Invalid paint tile coordinates.');
  const corner = (tx: number, ty: number): XY => toKm([tx / 2 ** z * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / 2 ** z))) * 180 / Math.PI]);
  const a = corner(x, y), b = corner(x + 1, y + 1);
  return { west: a[0], north: a[1], east: b[0], south: b[1], width: 512, height: 512, zoom };
}
export function lodWeights(zoom: number): { glyphs: number; manhattan: number } {
  return { glyphs: smooth((zoom - PAINT.middle) / PAINT.fade), manhattan: 1 - smooth((zoom - PAINT.close) / PAINT.fade) };
}
const fract = (n: number): number => n - Math.floor(n);
const blend = (a: number[], b: readonly number[], amount: number): number[] => a.map((v, i) => v + (b[i] - v) * amount);

class Brush {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  pixel(x: number, y: number, color: readonly number[], alpha = 1): void {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c++) this.data[i + c] += (color[c] - this.data[i + c]) * alpha;
  }
  ellipse(x: number, y: number, rx: number, ry: number, color: readonly number[], alpha = 1): void {
    for (let j = Math.floor(y - ry - 1); j <= y + ry + 1; j++) for (let i = Math.floor(x - rx - 1); i <= x + rx + 1; i++) {
      const r = Math.hypot((i + 0.5 - x) / rx, (j + 0.5 - y) / ry);
      this.pixel(i, j, color, alpha * Math.max(0, Math.min(1, (1 - r) * Math.min(rx, ry) + 0.5)));
    }
  }
  polygon(points: readonly XY[], color: readonly number[], alpha = 1): void {
    const min = Math.max(0, Math.floor(Math.min(...points.map(p => p[1])))), max = Math.min(this.height - 1, Math.ceil(Math.max(...points.map(p => p[1]))));
    for (let y = min; y <= max; y++) {
      const cuts: number[] = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a[1] > y + 0.5) !== (b[1] > y + 0.5)) cuts.push(a[0] + (y + 0.5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      cuts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i += 2) for (let x = Math.max(0, Math.ceil(cuts[i] - 0.5)); x < Math.min(this.width, cuts[i + 1] - 0.5); x++) this.pixel(x, y, color, alpha);
    }
  }
  rect(x: number, y: number, w: number, h: number, color: readonly number[], alpha = 1): void {
    this.polygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color, alpha);
  }
}

export function paintPixels(world: WorldModel, view: PaintView, bleed: number = PAINT.bleed): Pixels {
  if (!Object.values(view).every(v => typeof v === 'boolean' || Number.isFinite(v)) || view.width < 1 || view.height < 1 || view.width > 4096 || view.height > 4096 || !Number.isInteger(view.width) || !Number.isInteger(view.height) || view.east <= view.west || view.north <= view.south || bleed < 0 || bleed > 256) throw new Error('Invalid paint view.');
  const width = view.width + bleed * 2, height = view.height + bleed * 2;
  const sx = view.width / (view.east - view.west), sy = view.height / (view.north - view.south), scale = Math.sqrt(sx * sy);
  const west = view.west - bleed / sx, north = view.north + bleed / sy;
  const data = new Uint8ClampedArray(width * height * 4), brush = new Brush(data, width, height), weights = lodWeights(view.zoom);
  const screen = (x: number, y: number): XY => [(x - west) * sx, (north - y) * sy];
  const lightUp = Math.sin(MAP_LIGHT.altitude * Math.PI / 180), lightSide = Math.cos(MAP_LIGHT.altitude * Math.PI / 180);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const x = west + (px + 0.5) / sx, y = north - (py + 0.5) / sy, sample = world.sample(x, y);
    let color = [...SURFACE_COLORS[sample.surface]], texture = (noise(x * 24, y * 24) - 0.5) * 5;
    if (sample.surface === 'sea') {
      const coast = world.coastDistance(x, y), shallow = Math.exp(-coast / 1.9);
      color = blend(color, [52, 122, 168], shallow);
      color = blend(color, [117, 170, 176], smooth(1 - coast / 0.5) * 0.6);
      texture += (noise(x * 0.35, y * 0.35) - 0.5) * 10 + Math.sin(y * 70 + noise(x, y) * 2) * 1.3;
    } else {
      const ex = (world.elevationAt(x + 0.04, y, sample.district) - world.elevationAt(x - 0.04, y, sample.district)) * 7 / 80;
      const ey = (world.elevationAt(x, y + 0.04, sample.district) - world.elevationAt(x, y - 0.04, sample.district)) * 7 / 80;
      const illumination = (-ex * MAP_LIGHT.east * lightSide - ey * MAP_LIGHT.north * lightSide + lightUp) / Math.hypot(ex, ey, 1);
      const shade = 0.67 + 0.48 * illumination;
      if (sample.surface === 'wood') color = blend(color, [143, 160, 77], (noise(x * 2, y * 2) * 0.6 + noise(x * 9, y * 9) * 0.4 * smooth((scale - 12) / 35)) * 0.7);
      if (sample.surface === 'farm') {
        const field = worldHash(sample.field, sample.tone, 21);
        color = [...FIELDS[Math.floor(field * FIELDS.length)]];
        const furrow = y > 25 ? x + 0.03 * Math.sin(y * 3) : y + 0.03 * Math.sin(x * 3);
        texture += Math.sin(furrow * 170) * Math.min(3, scale / 40);
        if (sample.fieldEdge < 0.012) color = color.map(v => v * 0.86);
      }
      if (sample.surface === 'foreign') color = sample.district === 'ottoman' ? [164, 147, 115] : [143, 161, 135];
      if (['lowrise', 'midrise', 'highrise', 'town'].includes(sample.surface)) {
        const a = sample.angle, u = x * Math.cos(a) + y * Math.sin(a), v = -x * Math.sin(a) + y * Math.cos(a);
        const cellW = sample.surface === 'lowrise' || sample.surface === 'town' ? 0.15 : 0.22, cellH = 0.14;
        const fu = fract(u / cellW), fv = fract(v / cellH);
        if (fu < 0.12 || fv < 0.14) color = blend(color, [240, 232, 213], 0.82 * smooth((scale - 8) / 25));
        else texture += (worldHash(Math.floor(u / cellW), Math.floor(v / cellH)) - 0.5) * 18 * smooth((scale - 8) / 25);
      }
      if (sample.surface === 'airport') {
        if (sample.part === 'runway') { color = [66, 73, 79]; if (fract(x * 16 + y * 2.25) < 0.22) color = blend(color, [215, 215, 197], 0.6); }
        if (sample.part === 'airport-apron') color = [187, 186, 171];
        if (sample.part === 'airport-taxiway') color = [133, 137, 133];
        if (sample.part === 'airport-pier') color = [210, 210, 196];
        if (sample.part === 'airport-aircraft') color = [239, 235, 217];
      }
      color = color.map(v => v * shade);
      if (sample.district !== 'ottoman' && sample.district !== 'east-region') {
        const coast = world.coastDistance(x, y);
        if (coast < 0.14) color = blend(color, [211, 205, 166], (1 - coast / 0.14) * 0.65);
        if (coast < 0.6 / scale) color = blend(color, [243, 235, 207], 0.9);
      } else color = blend([...SURFACE_COLORS.sea], color, 0.4);
    }
    const index = (py * width + px) * 4;
    for (let c = 0; c < 3; c++) data[index + c] = color[c] + texture;
    data[index + 3] = 255;
  }
  const tree = (x: number, y: number, size: number, r: number, alpha: number): void => {
    brush.ellipse(x + size * 0.5, y + size * 0.35, size, size * 0.55, [38, 61, 39], alpha * 0.24);
    const colors = [[51, 99, 54], [67, 116, 53], [90, 129, 59], [115, 141, 67]];
    brush.ellipse(x, y - size * 0.5, size * 0.75, size, colors[Math.floor(r * 4)], alpha);
    brush.ellipse(x - size * 0.22, y - size * 0.83, size * 0.4, size * 0.48, [168, 182, 98], alpha * 0.55);
  };
  const house = (x: number, y: number, size: number, r: number, alpha: number): void => {
    brush.rect(x - size * 0.5 + 2, y - size * 0.35 + 2, size, size * 0.75, [55, 64, 48], alpha * 0.25);
    brush.rect(x - size * 0.5, y - size * 0.5, size, size * 0.8, [229, 214, 179], alpha);
    brush.polygon([[x - size * 0.62, y - size * 0.4], [x, y - size * 0.87], [x + size * 0.62, y - size * 0.4], [x, y - size * 0.08]], r > 0.5 ? [157, 98, 72] : [180, 119, 83], alpha);
    brush.rect(x - size * 0.12, y, size * 0.2, size * 0.3, [89, 97, 87], alpha);
  };
  const tower = (x: number, y: number, size: number, r: number, high: boolean, alpha: number): void => {
    const h = size * (high ? 1.2 + r * 2.4 : 0.55 + r * 0.6), w = size * 0.8;
    brush.polygon([[x, y], [x + w, y], [x + w + h * 0.65, y + h * 0.65], [x + h * 0.65, y + h * 0.65]], [46, 60, 61], alpha * 0.25);
    brush.rect(x - w * 0.55, y - size * 0.25, w * 1.6, size * 0.6, [165, 175, 174], alpha);
    brush.rect(x - w / 2, y - h, w, h, [119, 141, 151], alpha);
    brush.rect(x + w * 0.05, y - h, w * 0.45, h, [90, 115, 133], alpha);
    brush.rect(x - w / 2, y - h, w, Math.max(1, size * 0.2), [205, 214, 208], alpha);
    for (let yy = y - h + 3; yy < y - 1; yy += 3) brush.rect(x - w * 0.3, yy, w * 0.5, 0.7, [189, 203, 198], alpha * 0.6);
  };
  const sites = (step: number, salt: number, draw: (x: number, y: number, r: number) => void): void => {
    const points: Array<{ x: number; y: number; r: number }> = [];
    for (let i = Math.floor(Math.max(west, world.bounds[0] - 2) / step) - 1; i <= Math.ceil(Math.min(west + width / sx, world.bounds[2] + 2) / step) + 1; i++) {
      for (let j = Math.floor(Math.max(north - height / sy, world.bounds[1] - 2) / step) - 1; j <= Math.ceil(Math.min(north, world.bounds[3] + 2) / step) + 1; j++) {
        points.push({ x: (i + 0.15 + worldHash(i, j, salt) * 0.7) * step, y: (j + 0.15 + worldHash(i, j, salt + 1) * 0.7) * step, r: worldHash(i, j, salt + 2) });
      }
    }
    points.sort((a, b) => b.y - a.y || a.x - b.x);
    for (const p of points) draw(p.x, p.y, p.r);
  };
  if (weights.glyphs) sites(0.18, 7, (x, y, r) => {
    const s = world.sample(x, y), [px, py] = screen(x, y), a = weights.glyphs;
    if (a && (s.surface === 'wood' || s.surface === 'park' && r > 0.5)) tree(px, py, Math.min(12, scale * (0.06 + r * 0.035)), r, a);
    if (a && s.surface === 'lowdensity' && world.roadClear(x, y)) {
      if (r < 0.4) tree(px, py, Math.min(10, scale * 0.06), r, a); else if (view.buildings !== false) house(px, py, Math.min(11, scale * 0.075), r, a);
    }
  });
  if (view.buildings !== false) sites(0.18, 17, (x, y, r) => {
    const s = world.sample(x, y), [px, py] = screen(x, y);
    let a = weights.glyphs * (s.district === 'manhattan' ? weights.manhattan : 1);
    if (!world.roadClear(x, y) || ['sea', 'wood', 'farm', 'foreign', 'military'].includes(s.surface)) return;
    const size = Math.min(s.surface === 'highrise' ? 12 : 18, Math.max(4, scale * 0.12));
    if ((s.surface === 'highrise' || s.surface === 'midrise') && (view.pitch ?? 0) <= 30) {
      if (s.surface === 'highrise' && r > 0.85) a = Math.max(a, (1 - weights.glyphs) * 0.8);
      if (a) { tower(px, py, size, r, s.surface === 'highrise', a); tower(px + size * 0.8, py + size * 0.3, size * 0.65, 1 - r, false, a); }
    }
    if (a && (s.surface === 'lowrise' || s.surface === 'town')) {
      for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
        const dx = (col - 1) * 0.055, dy = (row - 0.5) * 0.065;
        house(px + (dx * Math.cos(s.angle) - dy * Math.sin(s.angle)) * sx, py - (dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) * sy, size * 0.5, r, a);
      }
    }
  });
  if (weights.glyphs && view.buildings !== false) sites(Math.SQRT2, 31, (x, y, r) => {
    const s = world.sample(x, y), [px, py] = screen(x, y), size = Math.min(14, scale * 0.1), a = weights.glyphs;
    if (s.surface !== 'farm' || !world.roadClear(x, y)) return;
    house(px, py, size, 0.9, a);
    brush.rect(px - size * 0.45, py - size * 0.4, size * 0.9, size * 0.65, [168, 81, 60], a);
    brush.rect(px + size * 0.7, py - size * 0.9, size * 0.42, size, [198, 195, 172], a);
    brush.ellipse(px + size * 0.91, py - size * 0.9, size * 0.21, size * 0.15, [230, 225, 202], a);
    if (r > 0.4) tree(px - size, py, size * 0.35, r, a);
  });
  sites(1.9, 41, (x, y, r) => {
    if (r > 0.45 || world.districtAt(x, y) !== 'sea' || world.districtAt(x + 1.5, y) !== 'fleet-port' || world.coastDistance(x, y) > 1.5) return;
    const [px, py] = screen(x, y), length = Math.min(32, Math.max(8, scale * 0.4)), w = length * 0.2;
    brush.polygon([[px - w, py], [px - w, py - length * 0.7], [px, py - length], [px + w, py - length * 0.7], [px + w, py]], [129, 148, 150]);
    brush.rect(px - w * 0.5, py - length * 0.65, w, length * 0.35, [193, 201, 189]);
  });
  for (const building of view.buildings === false ? [] : world.airportBuildings) {
    const ring = building.rings[0].map(p => screen(p[0], p[1]));
    brush.polygon(ring.map(p => [p[0] + 2, p[1] + 3]), [55, 65, 61], 0.25);
    brush.polygon(ring, [221, 220, 201]);
  }
  const cropped = new Uint8ClampedArray(view.width * view.height * 4);
  for (let y = 0; y < view.height; y++) cropped.set(data.subarray(((y + bleed) * width + bleed) * 4, ((y + bleed) * width + bleed + view.width) * 4), y * view.width * 4);
  return { width: view.width, height: view.height, data: cropped };
}
