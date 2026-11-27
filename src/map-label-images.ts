import { METRO_COLORS, PLACE_COLORS } from './map-overlays';

const placeKinds = Object.keys(PLACE_COLORS) as (keyof typeof PLACE_COLORS)[];

export const labelImageIds = [
  'highway-shield',
  ...Object.keys(METRO_COLORS).map((id) => 'metro-badge-' + id),
  ...placeKinds.map((id) => 'place-plate-' + id),
  ...placeKinds.map((id) => 'overview-plate-' + id),
];

function isPlateId(id: string): boolean {
  return id.startsWith('place-plate-') || id.startsWith('overview-plate-');
}

export const labelImageOptions = (id: string): {
  pixelRatio: number;
  stretchX: [number, number][];
  stretchY: [number, number][];
  content: [number, number, number, number];
} => (isPlateId(id)
  // Keep stretchY strictly inside content [3..43] so MapLibre centers text inside the frame,
  // while staying outside the medallion vertical span (y = 14.5..31.5) so the circle never distorts.
  ? { pixelRatio: 2, stretchX: [[34, 46], [62, 74]], stretchY: [[4, 9], [37, 42]], content: [30, 3, 98, 43] }
  : { pixelRatio: 2, stretchX: [[20, 36]], stretchY: [[10, 22]], content: [8, 4, 48, 28] });

function drawCategoryGlyph(ctx: CanvasRenderingContext2D, kind: keyof typeof PLACE_COLORS, cx: number, cy: number): void {
  ctx.save();
  ctx.strokeStyle = '#f8efd4';
  ctx.fillStyle = '#f8efd4';
  ctx.lineWidth = 1.35;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kind === 'continental') {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy - 2.5);
    ctx.stroke();
    ctx.fillRect(cx - 2.1, cy - 2.5, 4.2, 6.8);
    ctx.fillRect(cx - 3.4, cy + 1.1, 6.8, 3.2);
  } else if (kind === 'historic') {
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 1.5);
    ctx.lineTo(cx, cy - 4.4);
    ctx.lineTo(cx + 4, cy - 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 2.5, cy - 1.1); ctx.lineTo(cx - 2.5, cy + 3.4);
    ctx.moveTo(cx, cy - 1.1); ctx.lineTo(cx, cy + 3.4);
    ctx.moveTo(cx + 2.5, cy - 1.1); ctx.lineTo(cx + 2.5, cy + 3.4);
    ctx.moveTo(cx - 4, cy + 3.8); ctx.lineTo(cx + 4, cy + 3.8);
    ctx.stroke();
  } else if (kind === 'park') {
    ctx.beginPath();
    ctx.arc(cx, cy - 1.3, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + 1.3);
    ctx.lineTo(cx, cy + 4.4);
    ctx.stroke();
  } else if (kind === 'transport') {
    ctx.beginPath();
    ctx.arc(cx, cy, 3.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 4.5, cy); ctx.lineTo(cx + 4.5, cy);
    ctx.moveTo(cx, cy - 4.5); ctx.lineTo(cx, cy + 4.5);
    ctx.stroke();
  } else if (kind === 'border') {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4.4);
    ctx.lineTo(cx + 3.6, cy - 2.4);
    ctx.lineTo(cx + 3, cy + 1.5);
    ctx.lineTo(cx, cy + 4.5);
    ctx.lineTo(cx - 3, cy + 1.5);
    ctx.lineTo(cx - 3.6, cy - 2.4);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4.5);
    ctx.lineTo(cx + 1.4, cy - 1.4);
    ctx.lineTo(cx + 4.5, cy);
    ctx.lineTo(cx + 1.4, cy + 1.4);
    ctx.lineTo(cx, cy + 4.5);
    ctx.lineTo(cx - 1.4, cy + 1.4);
    ctx.lineTo(cx - 4.5, cy);
    ctx.lineTo(cx - 1.4, cy - 1.4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function createLabelImage(id: string): ImageData | undefined {
  if (!labelImageIds.includes(id) || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  const plate = isPlateId(id);
  const overview = id.startsWith('overview-plate-');
  canvas.width = plate ? 108 : 56;
  canvas.height = plate ? 56 : 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  if (plate) {
    const kind = id.slice(overview ? 'overview-plate-'.length : 'place-plate-'.length) as keyof typeof PLACE_COLORS;
    const boxX = 2;
    const boxY = 2;
    const boxW = canvas.width - 4;
    const boxH = 42;
    const midX = canvas.width / 2;

    // Subtle dark drop shadow beneath beveled plate
    ctx.save();
    ctx.fillStyle = 'rgba(6, 10, 16, 0.54)';
    ctx.beginPath();
    ctx.roundRect(boxX + 1, boxY + 2, boxW, boxH, 7);
    ctx.fill();
    ctx.restore();

    // Deep-sea slate vertical gradient body
    const bodyGrad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
    bodyGrad.addColorStop(0, overview ? '#283b50' : '#223244');
    bodyGrad.addColorStop(1, overview ? '#131f2c' : '#141e29');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 7);
    ctx.fill();

    // Inner top sheen hairline
    ctx.strokeStyle = overview ? 'rgba(255, 240, 198, 0.24)' : 'rgba(255, 240, 198, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(boxX + 7, boxY + 1.5);
    ctx.lineTo(boxX + boxW - 7, boxY + 1.5);
    ctx.stroke();

    // Three-stop beveled metallic bronze / gold rim
    const rimGrad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH + 8);
    if (overview) {
      rimGrad.addColorStop(0, '#f7e1a0');
      rimGrad.addColorStop(0.52, '#cfa758');
      rimGrad.addColorStop(1, '#7a5a22');
    } else {
      rimGrad.addColorStop(0, '#e5ca87');
      rimGrad.addColorStop(0.52, '#b08b47');
      rimGrad.addColorStop(1, '#5e451e');
    }
    ctx.strokeStyle = rimGrad;
    ctx.lineWidth = overview ? 1.9 : 1.55;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 7);
    ctx.stroke();

    // Bottom pointer triangle integrated into the beveled frame
    ctx.fillStyle = overview ? '#131f2c' : '#141e29';
    ctx.beginPath();
    ctx.moveTo(midX - 6.5, boxY + boxH - 0.5);
    ctx.lineTo(midX, boxY + boxH + 8.5);
    ctx.lineTo(midX + 6.5, boxY + boxH - 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rimGrad;
    ctx.lineWidth = overview ? 1.7 : 1.45;
    ctx.beginPath();
    ctx.moveTo(midX - 6.5, boxY + boxH);
    ctx.lineTo(midX, boxY + boxH + 8.5);
    ctx.lineTo(midX + 6.5, boxY + boxH);
    ctx.stroke();

    // Circular gilded category medallion kept completely outside stretchX/stretchY bands
    const medX = 16;
    const medY = boxY + boxH / 2;
    ctx.beginPath();
    ctx.arc(medX, medY, 8.6, 0, Math.PI * 2);
    ctx.fillStyle = PLACE_COLORS[kind];
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = overview ? '#f5dc96' : '#d2bf8f';
    ctx.stroke();
    drawCategoryGlyph(ctx, kind, medX, medY);

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  // Highway shields & Metro line badges with crisp beveled sheen
  const baseColor = id === 'highway-shield'
    ? '#235182'
    : METRO_COLORS[id.slice(-2) as keyof typeof METRO_COLORS];
  const grad = ctx.createLinearGradient(0, 1, 0, 31);
  grad.addColorStop(0, baseColor);
  grad.addColorStop(1, '#14202b');

  ctx.fillStyle = baseColor;
  ctx.beginPath();
  ctx.roundRect(1.5, 1.5, canvas.width - 3, 29, 7);
  ctx.fill();

  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  ctx.roundRect(1.5, 1.5, canvas.width - 3, 29, 7);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = id === 'highway-shield' ? '#e5ca87' : '#f7f1de';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.roundRect(1.5, 1.5, canvas.width - 3, 29, 7);
  ctx.stroke();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
