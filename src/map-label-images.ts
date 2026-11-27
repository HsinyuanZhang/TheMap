import { METRO_COLORS, PLACE_COLORS } from './map-overlays';

export const labelImageIds = ['highway-shield', ...Object.keys(METRO_COLORS).map(id => 'metro-badge-' + id), ...Object.keys(PLACE_COLORS).map(id => 'place-plate-' + id)];
export const labelImageOptions = (id: string): { pixelRatio: number; stretchX: [number, number][]; stretchY: [number, number][]; content: [number, number, number, number] } => id.startsWith('place-plate-')
  ? { pixelRatio: 2, stretchX: [[28, 38], [58, 68]], stretchY: [[12, 24]], content: [12, 6, 84, 34] }
  : { pixelRatio: 2, stretchX: [[20, 36]], stretchY: [[10, 22]], content: [8, 4, 48, 28] };

export function createLabelImage(id: string): ImageData | undefined {
  if (!labelImageIds.includes(id) || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas'), plate = id.startsWith('place-plate-');
  canvas.width = plate ? 96 : 56; canvas.height = plate ? 48 : 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = plate ? '#1c2630' : id === 'highway-shield' ? '#285d93' : METRO_COLORS[id.slice(-2) as keyof typeof METRO_COLORS];
  ctx.strokeStyle = plate ? '#d2bf8f' : '#edf0ed'; ctx.lineWidth = plate ? 1.6 : 1.2;
  ctx.beginPath(); ctx.roundRect(1, 1, canvas.width - 2, plate ? 35 : 30, plate ? 8 : 7); ctx.fill(); ctx.stroke();
  if (plate) {
    ctx.beginPath(); ctx.moveTo(41, 35); ctx.lineTo(48, 46); ctx.lineTo(55, 35); ctx.fill(); ctx.stroke();
    ctx.fillRect(42, 32, 12, 4);
    ctx.fillStyle = PLACE_COLORS[id.slice('place-plate-'.length) as keyof typeof PLACE_COLORS];
    ctx.beginPath(); ctx.arc(15, 18, 5, 0, Math.PI * 2); ctx.fill();
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
