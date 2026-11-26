import { addProtocol, removeProtocol, type ImageSource, type Map as MapLibreMap, type RasterTileSource } from 'maplibre-gl';
import type { MapDatasets } from './dataset-loader';
import type { PaintRequest, PaintResponse } from './paint-messages';
import { PAINT } from './terrain-painter';
const clients = new Map<string, PaintProtocol>();
let sequence = 0;
interface Pending { resolve: (value: { data: ArrayBuffer }) => void; reject: (error: Error) => void; cleanup: () => void; }
export class PaintProtocol {
  private readonly worker = new Worker(new URL('./paint-worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Pending>();
  private readonly name = String(++sequence);
  private id = 0;
  private revision = 0;
  private state = '';
  private firstUrl?: string;
  private map?: MapLibreMap;
  private first?: ArrayBuffer;
  constructor(data: MapDatasets, private readonly onError: (message: string) => void) {
    if (!clients.size) addProtocol('paint', (params, controller) => {
      const url = new URL(params.url), owner = clients.get(url.hostname);
      if (!owner) return Promise.reject(new Error('Paint source was removed.'));
      return owner.request(url, controller.signal);
    });
    clients.set(this.name, this);
    this.worker.onmessage = ({ data: message }: MessageEvent<PaintResponse>) => {
      if (message.kind === 'first') {
        if (message.revision === this.revision) { this.first = message.data; this.installFirst(); }
      } else if (message.kind === 'error') {
        const pending = message.id === undefined ? undefined : this.pending.get(message.id);
        if (pending) { pending.cleanup(); pending.reject(new Error(message.error)); this.pending.delete(message.id!); }
        else if (message.id === undefined) this.onError(message.error);
      } else {
        const pending = this.pending.get(message.id);
        if (pending) { pending.cleanup(); pending.resolve({ data: message.data }); this.pending.delete(message.id); }
      }
    };
    this.worker.onerror = event => {
      const error = new Error(event.message || 'Terrain worker failed.');
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
      this.pending.clear(); this.onError(error.message);
    };
    this.update(data);
  }
  tiles(detail = 9, pitch = 0, buildings = true): string[] {
    return [`paint://${this.name}/{z}/{x}/{y}?revision=${this.revision}&detail=${detail}&pitch=${pitch > 30 ? 31 : 0}&buildings=${buildings ? 1 : 0}`];
  }
  attach(map: MapLibreMap): void { this.map = map; this.installFirst(); }
  private installFirst(): void {
    const source = this.map?.getSource('paint-first') as ImageSource | undefined;
    if (!source || !this.first) return;
    const previous = this.firstUrl;
    this.firstUrl = URL.createObjectURL(new Blob([this.first], { type: 'image/png' }));
    source.updateImage({ url: this.firstUrl });
    if (previous) URL.revokeObjectURL(previous);
    this.first = undefined;
  }
  update(data: MapDatasets): void {
    this.revision++;
    this.send({ kind: 'world', revision: this.revision, data });
    this.state = '';
  }
  renderState(zoom: number, pitch: number, buildings: boolean): void {
    const detail = zoom >= PAINT.middle && zoom <= PAINT.middle + PAINT.fade || zoom >= PAINT.close && zoom <= PAINT.close + PAINT.fade
      ? Math.round(zoom * 10) / 10 : zoom < PAINT.middle ? 10 : zoom < PAINT.close ? 12.5 : 14;
    const state = [detail, pitch > 30, buildings, this.revision].join('/');
    if (state === this.state) return;
    this.state = state;
    (this.map?.getSource('painted-terrain') as RasterTileSource | undefined)?.setTiles(this.tiles(detail, pitch, buildings));
  }
  private send(message: PaintRequest): void { this.worker.postMessage(message); }
  private request(url: URL, signal: AbortSignal): Promise<{ data: ArrayBuffer }> {
    const [z, x, y] = url.pathname.slice(1).split('/').map(Number), detail = Number(url.searchParams.get('detail')), pitch = Number(url.searchParams.get('pitch'));
    const revision = Number(url.searchParams.get('revision'));
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (revision !== this.revision) return Promise.reject(new DOMException('Obsolete terrain data', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const abort = (): void => { this.pending.delete(id); this.send({ kind: 'cancel', id }); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) });
      this.send({ kind: 'tile', id, revision, z, x, y, detail, pitch, buildings: url.searchParams.get('buildings') === '1' });
    });
  }
  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) { p.cleanup(); p.reject(new DOMException('Removed', 'AbortError')); }
    this.pending.clear(); clients.delete(this.name);
    if (!clients.size) removeProtocol('paint');
    if (this.firstUrl) URL.revokeObjectURL(this.firstUrl);
  }
}
