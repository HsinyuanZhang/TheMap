import { beverlyHills } from '../data/source';

export function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function beverlyHeight(x: number, y: number): number {
  if (x < 9 || x > 28 || y < 0 || y > 9) return 0;
  if (y < 2.8) return Math.min(35, 18 + 8 * Math.sin(x * 0.6)) * smooth((2.8 - y) / 0.5);
  const edge = Math.min(x - 15.3, 28 - x, y - 2.8, 9 - y);
  if (edge <= 0) return 0;
  const hills = Math.pow(beverlyHills.reduce((sum, hill) => {
    const dx = (x - hill.center[0]) / hill.sigmaX, dy = (y - hill.center[1]) / hill.sigmaY;
    return sum + Math.pow(hill.peak * Math.exp(-0.5 * (dx * dx + dy * dy)), 4);
  }, 0), 0.25);
  return Math.min(320, hills * smooth(edge / 1.15));
}
