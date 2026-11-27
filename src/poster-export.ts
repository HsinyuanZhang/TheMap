import type { MapLensDefinition } from './map-lenses';
import type { Map as MapLibreMap } from 'maplibre-gl';

export interface PosterMetadata {
  lens: MapLensDefinition;
  selectedTitle?: string;
  selectedSubtitle?: string;
}

const POSTER_W = 1600;
const POSTER_H = 900;
const BAR_H = 112;

export function composeAtlasPoster(
  mapCanvas: HTMLCanvasElement,
  meta: PosterMetadata,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create 2D poster canvas context.');

  const mapH = POSTER_H - BAR_H;
  ctx.fillStyle = '#0d2642';
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  // Center-crop the live MapLibre canvas cleanly into the 1600x788 map viewport.
  const srcW = mapCanvas.width;
  const srcH = mapCanvas.height;
  if (srcW === 0 || srcH === 0) throw new Error('Map canvas is empty.');
  if (srcW > 0 && srcH > 0) {
    const srcAspect = srcW / srcH;
    const dstAspect = POSTER_W / mapH;
    let sx = 0;
    let sy = 0;
    let sw = srcW;
    let sh = srcH;
    if (srcAspect > dstAspect) {
      sw = srcH * dstAspect;
      sx = (srcW - sw) / 2;
    } else {
      sh = srcW / dstAspect;
      sy = (srcH - sh) / 2;
    }
    ctx.drawImage(mapCanvas, sx, sy, sw, sh, 0, 0, POSTER_W, mapH);
  }

  // Soft cartographic edge vignette over the map area.
  const vignette = ctx.createRadialGradient(
    POSTER_W / 2, mapH / 2, mapH * 0.34,
    POSTER_W / 2, mapH / 2, POSTER_W * 0.62,
  );
  vignette.addColorStop(0, 'rgba(9, 20, 34, 0)');
  vignette.addColorStop(1, 'rgba(9, 20, 34, 0.42)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, POSTER_W, mapH);

  // Gilded atlas bottom cartouche bar inspired by classic 4X strategy maps.
  const barGrad = ctx.createLinearGradient(0, mapH, 0, POSTER_H);
  barGrad.addColorStop(0, '#1e2f42');
  barGrad.addColorStop(1, '#111b27');
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, mapH, POSTER_W, BAR_H);

  // Outer frame + gold divider line.
  ctx.strokeStyle = '#c9a45c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, mapH + 1);
  ctx.lineTo(POSTER_W, mapH + 1);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(201, 164, 92, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, POSTER_W - 2, POSTER_H - 2);

  // Circular emblem on the left.
  const cx = 64;
  const cy = mapH + BAR_H / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.fillStyle = '#193556';
  ctx.fill();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = '#ecd08e';
  ctx.stroke();

  ctx.fillStyle = '#f8efd4';
  ctx.font = '700 28px "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('M', cx, cy + 1);

  // Main title & subtitle.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ecd08e';
  ctx.font = '700 32px "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", Georgia, serif';
  ctx.fillText('摩纳哥地图', 110, mapH + 54);

  ctx.fillStyle = '#b9ab88';
  ctx.font = 'italic 16px "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif';
  ctx.fillText('摩纳哥特别行政区 · 交互式图志', 110, mapH + 84);

  // Center lens badge.
  const midX = 630;
  ctx.strokeStyle = 'rgba(201, 164, 92, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(midX - 28, mapH + 24);
  ctx.lineTo(midX - 28, POSTER_H - 24);
  ctx.stroke();

  ctx.fillStyle = '#ecd08e';
  ctx.font = '600 20px "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif';
  ctx.fillText(meta.selectedTitle ? `${meta.lens.label} · ${meta.selectedTitle}` : meta.lens.label, midX, mapH + 50);

  ctx.fillStyle = '#b9ab88';
  ctx.font = '15px system-ui, -apple-system, sans-serif';
  const caption = meta.selectedSubtitle || meta.lens.description;
  ctx.fillText(caption.slice(0, 42), midX, mapH + 80);

  // Right attribution / offline cartography mark.
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9b8f73';
  ctx.font = '13px system-ui, -apple-system, sans-serif';
  ctx.fillText('本地矢量与手绘地形渲染 · TheMap', POSTER_W - 40, mapH + 54);
  ctx.fillStyle = '#c9a45c';
  ctx.font = '600 13px Georgia, serif';
  ctx.fillText('MONACO ATLAS', POSTER_W - 40, mapH + 80);

  return canvas;
}

export function captureAtlasPoster(map: Pick<MapLibreMap, 'loaded' | 'once' | 'on' | 'off' | 'triggerRepaint' | 'getCanvas'>, meta: PosterMetadata): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      map.off('idle', render);
      map.off('render', capture);
      map.off('remove', removed);
    };
    const removed = (): void => {
      cleanup();
      reject(new Error('Map removed during export.'));
    };
    const capture = (): void => {
      cleanup();
      try { resolve(composeAtlasPoster(map.getCanvas(), meta)); }
      catch (error) { reject(error); }
    };
    const render = (): void => {
      map.once('render', capture);
      map.triggerRepaint();
    };
    map.once('remove', removed);
    if (map.loaded()) render();
    else map.once('idle', render);
  });
}

export async function downloadAtlasPoster(map: MapLibreMap, meta: PosterMetadata): Promise<void> {
  const poster = await captureAtlasPoster(map, meta);
  const link = document.createElement('a');
  const slug = meta.selectedTitle ? `-${meta.selectedTitle}` : '';
  link.download = `monaco-map-${meta.lens.id}${slug}.png`;
  link.href = poster.toDataURL('image/png');
  link.click();
}
