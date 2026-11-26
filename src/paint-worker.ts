import { ByteLRU } from './paint-cache';
import { FIRST_VIEW, type PaintRequest, type PaintResponse } from './paint-messages';
import { PAINT, paintPixels, tileView, type Pixels } from './terrain-painter';
import { WorldModel } from './world-model';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<PaintRequest>) => void;
  postMessage: (message: PaintResponse, transfer?: Transferable[]) => void;
};
const cache = new ByteLRU(PAINT.cacheBytes);
let world: WorldModel | undefined, revision = -1;
async function encode(pixels: Pixels): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2D is unavailable.');
  const image = context.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data); context.putImageData(image, 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}
let queue = Promise.resolve();
const cancelled = new Set<number>();
worker.onmessage = ({ data: message }) => {
  if (message.kind === 'cancel') { cancelled.add(message.id); return; }
  queue = queue.then(async () => {
    try {
      if (message.kind === 'world') {
        world = new WorldModel(message.data); revision = message.revision; cache.clear();
        const data = await encode(paintPixels(world, FIRST_VIEW));
        worker.postMessage({ kind: 'first', revision, data }, [data]);
        return;
      }
      if (cancelled.delete(message.id)) return;
      if (!world || revision !== message.revision) throw new Error('Paint world is not ready.');
      const key = [revision, message.z, message.x, message.y, message.detail, message.pitch > 30, message.buildings].join('/');
      let data = cache.get(key);
      if (!data) {
        data = await encode(paintPixels(world, { ...tileView(message.z, message.x, message.y, message.detail), pitch: message.pitch, buildings: message.buildings }));
        cache.set(key, data);
      }
      if (cancelled.delete(message.id)) return;
      const copy = data.slice(0);
      worker.postMessage({ kind: 'tile', id: message.id, data: copy }, [copy]);
    } catch (error) {
      worker.postMessage({ kind: 'error', id: message.kind === 'tile' ? message.id : undefined, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
