import { shadowOffset } from './map-light';

const regionalPatterns = {
  'regional-lowrise-pattern': { size: 8, spacing: 4, square: 2 },
  'regional-midrise-pattern': { size: 12, spacing: 6, square: 3 },
} as const;

export const regionalBlockPatternIds = Object.keys(regionalPatterns);
export const regionalPatternIds = [...regionalBlockPatternIds, 'canopy-pattern', 'furrow-north-pattern', 'furrow-east-pattern', 'tree-clump-0', 'tree-clump-1'];

export function createRegionalBlockPattern(id: string): ImageData | undefined {
  const pattern = regionalPatterns[id as keyof typeof regionalPatterns];
  if (!regionalPatternIds.includes(id) || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  const size = pattern?.size ?? 32;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.clearRect(0, 0, size, size);
  if (!pattern) {
    if (id.startsWith('furrow-')) {
      context.strokeStyle = 'rgba(94, 103, 58, 0.32)';
      context.lineWidth = 1;
      const north = id.includes('north');
      for (let offset = -32; offset <= 64; offset += 6) {
        context.beginPath();
        context.moveTo(north ? 0 : offset, north ? offset : 0);
        context.lineTo(north ? size : offset + 8, north ? offset + 8 : size);
        context.stroke();
      }
    } else {
      const clump = id.startsWith('tree-clump');
      const [shadowX, shadowY] = shadowOffset(1.5);
      const [lightX, lightY] = shadowOffset(-1);
      const count = clump ? 5 : 19;
      for (let index = 0; index < count; index += 1) {
        const x = clump ? 9 + (index * 7 + (id.endsWith('1') ? 3 : 0)) % 15 : (index * 17 + 3) % size;
        const y = clump ? 9 + (index * 11) % 15 : (index * 23 + 7) % size;
        const radius = clump ? 4 + index % 3 : 1.8 + index % 3;
        context.fillStyle = clump ? 'rgba(43, 78, 47, 0.5)' : 'rgba(49, 87, 45, 0.16)';
        context.beginPath(); context.arc(x + shadowX, y + shadowY, radius, 0, Math.PI * 2); context.fill();
        context.fillStyle = clump ? 'rgba(132, 166, 107, 0.9)' : 'rgba(221, 234, 183, 0.24)';
        context.beginPath(); context.arc(x + lightX, y + lightY, radius * 0.8, 0, Math.PI * 2); context.fill();
      }
    }
    return context.getImageData(0, 0, size, size);
  }
  context.fillStyle = 'rgba(73, 80, 67, 0.2)';
  for (let y = 0; y < pattern.size; y += pattern.spacing) {
    for (let x = 0; x < pattern.size; x += pattern.spacing) {
      context.fillRect(x, y, pattern.square, pattern.square);
    }
  }
  return context.getImageData(0, 0, pattern.size, pattern.size);
}
