const regionalPatterns = {
  'regional-lowrise-pattern': { size: 8, spacing: 4, square: 2 },
  'regional-midrise-pattern': { size: 12, spacing: 6, square: 3 },
} as const;

export const regionalBlockPatternIds = Object.keys(regionalPatterns);

export function createRegionalBlockPattern(id: string): ImageData | undefined {
  const pattern = regionalPatterns[id as keyof typeof regionalPatterns];
  if (!pattern || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = pattern.size;
  canvas.height = pattern.size;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.clearRect(0, 0, pattern.size, pattern.size);
  context.fillStyle = 'rgba(73, 80, 67, 0.2)';
  for (let y = 0; y < pattern.size; y += pattern.spacing) {
    for (let x = 0; x < pattern.size; x += pattern.spacing) {
      context.fillRect(x, y, pattern.square, pattern.square);
    }
  }
  return context.getImageData(0, 0, pattern.size, pattern.size);
}
