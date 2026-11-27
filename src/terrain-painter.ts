import { MAP_LIGHT } from './map-light';
import { smooth } from './terrain-elevation';
import { noise, toKm, worldHash, type Surface, type WorldModel, type XY } from './world-model';

export const PAINT = { tileSize: 512, bleed: 48, minzoom: 7, maxzoom: 14, middle: 11.7, close: 13.5, fade: 0.3, cacheBytes: 96 * 1024 * 1024 } as const;
export const SURFACE_COLORS: Record<Surface, readonly [number, number, number]> = {
  sea: [16, 52, 94], wood: [85, 123, 66], farm: [183, 187, 120], lowdensity: [177, 194, 139],
  lowrise: [211, 197, 171], midrise: [199, 197, 187], highrise: [176, 190, 201], town: [215, 193, 158],
  park: [148, 177, 113], military: [155, 169, 153], airport: [153, 176, 112], foreign: [151, 142, 113], lake: [78, 135, 155], pier: [154, 139, 114],
};
const FIELDS = [[195, 187, 115], [173, 183, 114], [203, 193, 132], [113, 149, 83], [169, 137, 91], [181, 191, 137], [163, 168, 111]];
export interface PaintView { west: number; north: number; east: number; south: number; width: number; height: number; zoom: number; pitch?: number; buildings?: boolean; pixelRatio?: number; }
export interface Pixels { width: number; height: number; data: Uint8ClampedArray; }
export function paintPixelRatio(deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) throw new Error('Invalid paint pixel ratio.');
  return Math.min(8, Math.ceil(deviceRatio) * 2);
}
export function tileView(z: number, x: number, y: number, zoom = z, pixelRatio = 1): PaintView {
  if (![z, x, y].every(Number.isInteger) || z < PAINT.minzoom || z > PAINT.maxzoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new Error('Invalid paint tile coordinates.');
  if (!Number.isInteger(pixelRatio) || pixelRatio < 1 || pixelRatio > 8) throw new Error('Invalid paint pixel ratio.');
  const corner = (tx: number, ty: number): XY => toKm([tx / 2 ** z * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / 2 ** z))) * 180 / Math.PI]);
  const a = corner(x, y), b = corner(x + 1, y + 1);
  return { west: a[0], north: a[1], east: b[0], south: b[1], width: PAINT.tileSize * pixelRatio, height: PAINT.tileSize * pixelRatio, zoom, pixelRatio };
}
export function lodWeights(zoom: number): { glyphs: number; manhattan: number } {
  return { glyphs: smooth((zoom - PAINT.middle) / PAINT.fade), manhattan: 1 - smooth((zoom - PAINT.close) / PAINT.fade) };
}
const fract = (n: number): number => n - Math.floor(n);
const blend = (a: number[], b: readonly number[], amount: number): number[] => a.map((v, i) => v + (b[i] - v) * amount);
const clamp = (v: number): number => Math.max(0, Math.min(1, v));
export function stripeCoverage(position: number, period: number, stripe: number, footprint: number): number {
  const integral = (v: number): number => Math.floor(v / period) * stripe + Math.min(fract(v / period) * period, stripe);
  const coverage = clamp((integral(position + footprint / 2) - integral(position - footprint / 2)) / footprint);
  return coverage < 1e-12 ? 0 : coverage > 1 - 1e-12 ? 1 : coverage;
}

class Brush {
  private readonly coverage: Float64Array;
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number, private readonly pixelRatio = 1) { this.coverage = new Float64Array(width); }
  pixel(x: number, y: number, color: readonly number[], alpha = 1): void {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c++) this.data[i + c] += (color[c] - this.data[i + c]) * alpha;
  }
  ellipse(x: number, y: number, rx: number, ry: number, color: readonly number[], alpha = 1): void {
    x *= this.pixelRatio; y *= this.pixelRatio; rx *= this.pixelRatio; ry *= this.pixelRatio;
    for (let j = Math.floor(y - ry - 1); j <= y + ry + 1; j++) for (let i = Math.floor(x - rx - 1); i <= x + rx + 1; i++) {
      const r = Math.hypot((i + 0.5 - x) / rx, (j + 0.5 - y) / ry);
      this.pixel(i, j, color, alpha * Math.max(0, Math.min(1, (1 - r) * Math.min(rx, ry) + 0.5)));
    }
  }
  polygon(points: readonly XY[], color: readonly number[], alpha = 1): void {
    points = points.map(([x, y]) => [x * this.pixelRatio, y * this.pixelRatio]);
    const min = Math.max(0, Math.floor(Math.min(...points.map(p => p[1])))), max = Math.min(this.height - 1, Math.ceil(Math.max(...points.map(p => p[1]))));
    const left = Math.max(0, Math.floor(Math.min(...points.map(p => p[0])))), right = Math.min(this.width, Math.ceil(Math.max(...points.map(p => p[0]))));
    for (let y = min; y <= max; y++) {
      this.coverage.fill(0, left, right);
      for (const offset of [0.125, 0.375, 0.625, 0.875]) {
        const cuts: number[] = [];
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const a = points[i], b = points[j];
          if ((a[1] > y + offset) !== (b[1] > y + offset)) cuts.push(a[0] + (y + offset - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
        }
        cuts.sort((a, b) => a - b);
        for (let i = 0; i + 1 < cuts.length; i += 2) for (let x = Math.max(left, Math.floor(cuts[i])); x < Math.min(right, Math.ceil(cuts[i + 1])); x++) {
          this.coverage[x] += Math.max(0, Math.min(x + 1, cuts[i + 1]) - Math.max(x, cuts[i])) / 4;
        }
      }
      for (let x = left; x < right; x++) if (this.coverage[x]) this.pixel(x, y, color, alpha * this.coverage[x]);
    }
  }
  rect(x: number, y: number, w: number, h: number, color: readonly number[], alpha = 1): void {
    this.polygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color, alpha);
  }
}

export function paintPixels(world: WorldModel, view: PaintView, bleed: number = PAINT.bleed): Pixels {
  const pixelRatio = view.pixelRatio ?? 1;
  if (!Object.values(view).every(v => typeof v === 'boolean' || Number.isFinite(v)) || pixelRatio < 1 || pixelRatio > 8 || view.width < 1 || view.height < 1 || view.width > 4096 || view.height > 4096 || !Number.isInteger(view.width) || !Number.isInteger(view.height) || view.east <= view.west || view.north <= view.south || bleed < 0 || bleed > PAINT.bleed * 8) throw new Error('Invalid paint view.');
  const width = view.width + bleed * 2, height = view.height + bleed * 2;
  const sx = view.width / (view.east - view.west) / pixelRatio, sy = view.height / (view.north - view.south) / pixelRatio, scale = Math.sqrt(sx * sy);
  const west = view.west - bleed / (sx * pixelRatio), north = view.north + bleed / (sy * pixelRatio);
  const data = new Uint8ClampedArray(width * height * 4), brush = new Brush(data, width, height, pixelRatio), weights = lodWeights(view.zoom);
  const screen = (x: number, y: number): XY => [(x - west) * sx, (north - y) * sy];
  const lightUp = Math.sin(MAP_LIGHT.altitude * Math.PI / 180), lightSide = Math.cos(MAP_LIGHT.altitude * Math.PI / 180);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const x = west + (px + 0.5) / (sx * pixelRatio), y = north - (py + 0.5) / (sy * pixelRatio), sample = world.sample(x, y);
    const detail = smooth((scale - 9) / 22), footprint = 1 / (scale * pixelRatio);
    let color = [...SURFACE_COLORS[sample.surface]], texture = (noise(x * 3, y * 3) - 0.5) * 3;
    if (sample.surface === 'sea') {
      const coast = world.coastDistance(x, y), shallow = 1 - smooth(coast / 5);
      color = blend(color, [52, 122, 168], shallow);
      color = blend(color, [128, 187, 192], smooth(1 - coast / 0.5) * 0.68);
      const swell = Math.sin(y * 1.45 + Math.sin(x * 0.35) * 1.8) * 1.35 * smooth(coast / 4);
      texture = (noise(x * 0.28, y * 0.28) - 0.5) * 8 + swell + Math.sin(y * 17 + noise(x * 0.4, y * 0.4) * 2) * 0.7 * smooth((scale - 5) / 18);
      color = color.map(v => v * (1 - Math.min(0.08, Math.hypot(x - 19, y - 17.5) / 560)));
    } else {
      const step = Math.max(0.025, footprint * 0.6);
      const elevation = (a: number, b: number): number => world.shadingElevationAt(a, b, sample.district);
      const ex = (elevation(x + step, y) - elevation(x - step, y)) * 7 / (step * 2000);
      const ey = (elevation(x, y + step) - elevation(x, y - step)) * 7 / (step * 2000);
      const illumination = (-ex * MAP_LIGHT.east * lightSide - ey * MAP_LIGHT.north * lightSide + lightUp) / Math.hypot(ex, ey, 1);
      const shade = sample.surface === 'foreign' ? 0.58 + 0.56 * illumination : 0.82 + 0.35 * illumination;
      if (sample.surface === 'wood') {
        const mottle = noise(x * 2.5, y * 2.5) * 0.35 + noise(x * 9, y * 9) * 0.65 * detail;
        color = blend([30, 67, 39], [103, 132, 57], mottle);
        texture += (noise(x * 19, y * 19) - 0.5) * 9 * smooth((scale - 28) / 50);
      }
      if (sample.surface === 'farm') {
        color = [...FIELDS[sample.tone]];
        const field = world.fieldAt(x, y), furrow = y > 25 ? field.u : field.v;
        texture += (stripeCoverage(furrow, 0.027, 0.005, footprint) - 0.005 / 0.027) * 25;
        color = blend(color, [85, 107, 56], clamp((0.009 - sample.fieldEdge) * scale + 0.5) * 0.72);
      }
      if (sample.surface === 'foreign') color = sample.district === 'ottoman' ? [126, 113, 86] : [69, 86, 70];
      if (sample.surface === 'military') color = blend([134, 151, 134], [174, 183, 157], noise(x * 0.8, y * 0.8) * 0.7 + noise(x * 3.2, y * 3.2) * 0.3);
      if (sample.surface === 'lowdensity') color = blend([199, 190, 169], color, 0.2 + 0.8 * smooth(world.urbanEdgeDistance(x, y) / 0.65));
      if (['lowrise', 'midrise', 'highrise', 'town'].includes(sample.surface)) {
        const cell = world.streetAt(x, y, sample.angle, sample.quarter), tone = (sample.quarter - 0.5) * 15;
        color = [213 + tone, 192 + tone * 0.8, 177 + tone * 0.6];
        const roofs = [[172, 144, 119], [167, 160, 143], [188, 163, 130], [142, 153, 147], [175, 132, 112]];
        const roof = roofs[Math.floor(worldHash(cell.col, cell.row, Math.floor(sample.quarter * 10000)) * roofs.length)];
        color = blend(color, roof, detail * 0.48);
        const streetU = stripeCoverage(cell.u, cell.w, 0.018, footprint), streetV = stripeCoverage(cell.v, cell.h, 0.016, footprint);
        color = blend(color, [240, 232, 212], (1 - (1 - streetU) * (1 - streetV)) * 0.95);
        texture += (noise(x * 12, y * 12) - 0.5) * 7 * detail;
      }
      if (sample.surface === 'airport') {
        if (sample.part === 'runway') color = [76, 84, 83];
        const airportColors: Record<string, number[]> = { 'airport-apron': [187, 186, 171], 'airport-taxiway': [133, 137, 133], 'airport-pier': [210, 210, 196], 'airport-aircraft': [239, 235, 217] };
        if (airportColors[sample.part]) color = blend(color, airportColors[sample.part], weights.glyphs);
        texture += (noise(x * 5, y * 5) - 0.5) * 8;
      }
      color = color.map(v => v * shade);
      if (sample.district !== 'ottoman' && sample.district !== 'east-region') {
        const coast = world.coastDistance(x, y);
        if (coast < 0.14) color = blend(color, [211, 205, 166], (1 - coast / 0.14) * 0.65);
        if (coast < 0.6 / scale) color = blend(color, [243, 235, 207], 0.9);
      }
    }
    const index = (py * width + px) * 4;
    for (let c = 0; c < 3; c++) data[index + c] = color[c] + texture;
    data[index + 3] = 255;
  }
  const tree = (x: number, y: number, size: number, r: number, alpha: number): void => {
    brush.ellipse(x + size * 0.5, y + size * 0.35, size, size * 0.55, [38, 61, 39], alpha * 0.24);
    const colors = [[51, 99, 54], [67, 116, 53], [90, 129, 59], [115, 141, 67]];
    brush.ellipse(x, y - size * 0.35, size, size * 0.86, colors[Math.floor(r * 4)], alpha);
    brush.ellipse(x - size * 0.26, y - size * 0.63, size * 0.5, size * 0.42, [168, 182, 98], alpha * 0.5);
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
  const roof = (x: number, y: number, w: number, h: number, angle: number, color: number[], rise: number, alpha: number): void => {
    const c = Math.cos(angle), s = Math.sin(angle);
    const corners: XY[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const points = corners.map(([a, b]): XY => [x + a * c - b * s, y - a * s - b * c]);
    brush.polygon(points.map(p => [p[0] - MAP_LIGHT.east * rise, p[1] + MAP_LIGHT.north * rise]), [65, 65, 53], alpha * 0.25);
    brush.polygon(points, color.map(v => v * 0.8), alpha);
    brush.polygon(points.map(p => [p[0], p[1] - rise]), color, alpha);
    brush.polygon([points[0], points[1], [points[1][0], points[1][1] - rise], [points[0][0], points[0][1] - rise]], color.map(v => Math.min(255, v + 12)), alpha);
  };
  const sites = (step: number, salt: number, draw: (x: number, y: number, r: number) => void): void => {
    const points: Array<{ x: number; y: number; r: number }> = [];
    for (let i = Math.floor(Math.max(west - 0.5, world.bounds[0] - 2) / step) - 1; i <= Math.ceil(Math.min(west + width / (sx * pixelRatio) + 0.5, world.bounds[2] + 2) / step) + 1; i++) {
      for (let j = Math.floor(Math.max(north - height / (sy * pixelRatio) - 0.5, world.bounds[1] - 2) / step) - 1; j <= Math.ceil(Math.min(north + 0.5, world.bounds[3] + 2) / step) + 1; j++) {
        points.push({ x: (i + 0.15 + worldHash(i, j, salt) * 0.7) * step, y: (j + 0.15 + worldHash(i, j, salt + 1) * 0.7) * step, r: worldHash(i, j, salt + 2) });
      }
    }
    points.sort((a, b) => b.y - a.y || a.x - b.x);
    for (const p of points) draw(p.x, p.y, p.r);
  };
  if (weights.glyphs) sites(0.11, 7, (x, y, r) => {
    const s = world.sample(x, y), [px, py] = screen(x, y), a = weights.glyphs;
    if (a && (s.surface === 'wood' || s.surface === 'park' && r > 0.6)) tree(px, py, Math.min(12, scale * (0.045 + r * 0.045)), r, a);
  });
  if (weights.glyphs) sites(0.18, 23, (x, y, r) => {
    const s = world.sample(x, y), [px, py] = screen(x, y);
    if (s.surface !== 'lowdensity' || !world.roadClear(x, y)) return;
    if (r < 0.4) tree(px, py, Math.min(10, scale * 0.06), r, weights.glyphs);
    else if (view.buildings !== false) house(px, py, Math.min(11, scale * 0.075), r, weights.glyphs);
  });
  const paintedBlocks = new Set<string>();
  if (view.buildings !== false && weights.glyphs) sites(0.14, 17, (x, y) => {
    let s = world.sample(x, y);
    if (!['lowrise', 'town', 'midrise', 'highrise'].includes(s.surface)) return;
    const cell = world.streetAt(x, y, s.angle, s.quarter), key = [s.quarter, cell.col, cell.row].join('/');
    if (paintedBlocks.has(key)) return;
    const center = world.sample(cell.x, cell.y);
    if (center.quarter !== s.quarter || center.surface !== s.surface || !world.roadClear(cell.x, cell.y)) return;
    paintedBlocks.add(key); s = center;
    const [px, py] = screen(cell.x, cell.y), r = worldHash(cell.col, cell.row, Math.floor(s.quarter * 10000));
    const a = weights.glyphs * (s.district === 'manhattan' ? weights.manhattan : 1);
    const size = Math.min(12, Math.max(4, scale * 0.1));
    if ((s.surface === 'highrise' || s.surface === 'midrise') && (view.pitch ?? 0) <= 30) {
      if (a && s.surface === 'highrise') { tower(px, py, size, r, true, a); tower(px + size * 0.8, py + size * 0.3, size * 0.65, 1 - r, false, a); }
      if (a && s.surface === 'midrise') {
        const palette = [[182, 183, 172], [199, 190, 169], [163, 168, 163], [207, 202, 184]];
        for (let i = 0; i < 2; i++) {
          const dx = (i - 0.5) * cell.w * 0.43;
          roof(px + dx * sx * Math.cos(s.angle), py - dx * sy * Math.sin(s.angle), Math.min(26, cell.w * sx * 0.37), Math.min(23, cell.h * sy * 0.68), s.angle, palette[Math.floor(r * 4)], 2 + r * 4, a);
        }
      }
    }
    if (a && (s.surface === 'lowrise' || s.surface === 'town')) {
      for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
        const dx = (col - 1) * cell.w * 0.27, dy = (row - 0.5) * cell.h * 0.42;
        const palette = [[156, 87, 64], [176, 114, 77], [145, 128, 100], [113, 128, 118]];
        roof(px + (dx * Math.cos(s.angle) - dy * Math.sin(s.angle)) * sx, py - (dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) * sy, Math.min(12, cell.w * sx * 0.2), Math.min(10, cell.h * sy * 0.28), s.angle, palette[Math.floor(worldHash(cell.col * 3 + col, cell.row * 2 + row, 72) * 4)], 1.5, a);
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
  for (const building of view.buildings === false || !weights.glyphs ? [] : world.airportBuildings) {
    const ring = building.rings[0].map(p => screen(p[0], p[1]));
    brush.polygon(ring.map(p => [p[0] + 2, p[1] + 3]), [55, 65, 61], 0.25);
    brush.polygon(ring, [221, 220, 201], weights.glyphs);
  }
  const horizontal = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    const i = (y * width + x) * 4 + c;
    horizontal[i] = (data[(y * width + Math.max(0, x - 1)) * 4 + c] + 2 * data[i] + data[(y * width + Math.min(width - 1, x + 1)) * 4 + c]) / 4;
  }
  const cropped = new Uint8ClampedArray(view.width * view.height * 4);
  for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) for (let c = 0; c < 4; c++) {
    const px = x + bleed, py = y + bleed;
    cropped[(y * view.width + x) * 4 + c] = (horizontal[(Math.max(0, py - 1) * width + px) * 4 + c] + 2 * horizontal[(py * width + px) * 4 + c] + horizontal[(Math.min(height - 1, py + 1) * width + px) * 4 + c]) / 4;
  }
  return { width: view.width, height: view.height, data: cropped };
}
