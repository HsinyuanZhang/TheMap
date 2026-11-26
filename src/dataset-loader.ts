import type { FeatureCollection, Geometry } from 'geojson';

export type Dataset = FeatureCollection<Geometry, Record<string, string | number | boolean>>;

export interface MapDatasets {
  land: Dataset;
  districts: Dataset;
  parks: Dataset;
  roads: Dataset;
  metro_lines: Dataset;
  metro_stations: Dataset;
  buildings: Dataset;
  pois: Dataset;
  blocks: Dataset;
  boundaries: Dataset;
  labels: Dataset;
  trees: Dataset;
  surface: Dataset;
  terrain: Dataset;
  overview: Dataset;
  atlas: Dataset;
}

export type DatasetName = keyof MapDatasets;
export type DatasetFetcher = (url: string) => Promise<unknown>;

export const initialDatasetNames = [
  'land', 'districts', 'roads', 'metro_lines', 'metro_stations', 'pois', 'labels', 'boundaries', 'parks', 'overview', 'atlas',
] as const satisfies readonly DatasetName[];

export const lazyDatasetNames = ['blocks', 'buildings', 'trees', 'surface', 'terrain'] as const satisfies readonly DatasetName[];

export const datasetNames: readonly DatasetName[] = [
  'land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois',
  'blocks', 'boundaries', 'labels', 'trees', 'surface', 'terrain', 'overview', 'atlas',
];

export interface DatasetLoadResult {
  datasets: Partial<Record<DatasetName, Dataset>>;
  failed: DatasetName[];
}

export function emptyDataset(): Dataset {
  return { type: 'FeatureCollection', features: [] };
}

export function emptyMapDatasets(): MapDatasets {
  return Object.fromEntries(datasetNames.map((name) => [name, emptyDataset()])) as unknown as MapDatasets;
}

function isDataset(value: unknown): value is Dataset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; features?: unknown };
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features);
}

export class DatasetLoader {
  private readonly cache = new Map<DatasetName, Dataset>();
  private readonly inflight = new Map<DatasetName, Promise<Dataset>>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: DatasetFetcher,
  ) {}

  url(name: DatasetName): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    return base + 'data/' + name + '.geojson';
  }

  load(name: DatasetName, force = false): Promise<Dataset> {
    const active = this.inflight.get(name);
    if (active) return active;
    const cached = this.cache.get(name);
    if (cached && !force) return Promise.resolve(cached);

    const request = (async () => {
      const value = await this.fetcher(this.url(name));
      if (!isDataset(value)) throw new Error('Invalid GeoJSON FeatureCollection: ' + name);
      this.cache.set(name, value);
      return value;
    })();
    this.inflight.set(name, request);
    void request.finally(() => {
      if (this.inflight.get(name) === request) this.inflight.delete(name);
    }).catch(() => undefined);
    return request;
  }

  async loadMany(names: readonly DatasetName[], force = false): Promise<DatasetLoadResult> {
    const settled = await Promise.allSettled(names.map((name) => this.load(name, force)));
    const datasets: Partial<Record<DatasetName, Dataset>> = {};
    const failed: DatasetName[] = [];
    settled.forEach((result, index) => {
      const name = names[index]!;
      if (result.status === 'fulfilled') datasets[name] = result.value;
      else failed.push(name);
    });
    return { datasets, failed };
  }
}
