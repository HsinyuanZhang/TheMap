import {
  Map as MapLibreMap,
  ScaleControl,
  setWorkerUrl,
  type LayerSpecification,
  type LngLatLike,
  type MapGeoJSONFeature,
  type StyleSpecification,
} from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import {
  boundsFromPositions,
  clampCenterToBounds,
  getMapPadding,
  removeTranslationFromRect,
  type CenterBounds,
} from './map-camera';

export type Dataset = FeatureCollection<Geometry, Record<string, string | number>>;

export interface MapDatasets {
  land: Dataset;
  districts: Dataset;
  parks: Dataset;
  roads: Dataset;
  metro_lines: Dataset;
  metro_stations: Dataset;
  buildings: Dataset;
  pois: Dataset;
}

export type MapSelection =
  | { kind: 'place'; id: string; coordinate: [number, number] }
  | { kind: 'station'; id: string; coordinate: [number, number] };

type SelectionHandler = (selection: MapSelection) => void;
type ErrorHandler = (message: string) => void;

const longitudeScale = 111.32 * Math.cos((40 * Math.PI) / 180);
const latitudeScale = 110.574;
setWorkerUrl(mapLibreWorkerUrl);

const toGeographic = (x: number, y: number): [number, number] => [
  -150 + x / longitudeScale,
  40 + y / latitudeScale,
];
const centerSouthwest = toGeographic(-4, -4);
const centerNortheast = toGeographic(48, 46);
const centerBounds: CenterBounds = {
  west: centerSouthwest[0],
  south: centerSouthwest[1],
  east: centerNortheast[0],
  north: centerNortheast[1],
};

function positions(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(positions);
  const result: Position[] = [];
  const visit = (coordinate: unknown): void => {
    if (!Array.isArray(coordinate)) return;
    if (coordinate.length >= 2 && typeof coordinate[0] === 'number' && typeof coordinate[1] === 'number') {
      result.push(coordinate as Position);
      return;
    }
    for (const value of coordinate) visit(value);
  };
  visit(geometry.coordinates);
  return result;
}

function centerOf(feature: Feature<Geometry, Record<string, unknown>>): [number, number] | undefined {
  const points = positions(feature.geometry);
  if (points.length === 0) return undefined;
  if (feature.geometry?.type === 'Point') {
    return [points[0]![0]!, points[0]![1]!];
  }
  const longitudes = points.map((position) => position[0]!);
  const latitudes = points.map((position) => position[1]!);
  return [
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  ];
}

function featureId(feature: MapGeoJSONFeature): string {
  return String(feature.properties?.id ?? '');
}

function setVisibility(map: MapLibreMap, layerIds: string[], visible: boolean): void {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

export class MapController {
  readonly map: MapLibreMap;
  readonly ready: Promise<void>;
  private readonly contentIds: ReadonlySet<string>;
  private readonly onSelection: SelectionHandler;
  private readonly onError: ErrorHandler;
  private readonly datasets: MapDatasets;
  private readonly panel: HTMLElement;
  private applyingLayout = false;
  private constrainingCenter = false;
  private isOverview = true;

  constructor(
    container: HTMLElement,
    datasets: MapDatasets,
    contentIds: ReadonlySet<string>,
    onSelection: SelectionHandler,
    onError: ErrorHandler,
    panel: HTMLElement,
  ) {
    this.datasets = datasets;
    this.contentIds = contentIds;
    this.onSelection = onSelection;
    this.onError = onError;
    this.panel = panel;
    const style: StyleSpecification = {
      version: 8,
      glyphs: `${import.meta.env.BASE_URL}fonts/{fontstack}/{range}.pbf`,
      sources: {},
      layers: [{ id: 'ocean', type: 'background', paint: { 'background-color': '#dce8eb' } }],
    };

    this.map = new MapLibreMap({
      container,
      style,
      center: [-149.8, 40.17],
      zoom: 8.4,
      minZoom: 7.2,
      maxZoom: 17,
      localIdeographFontFamily: 'sans-serif',
      dragRotate: true,
      touchPitch: true,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });
    this.installCenterBounds();
    this.map.on('movestart', () => {
      if (!this.applyingLayout) this.isOverview = false;
    });
    this.map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    this.ready = new Promise((resolve) => {
      this.map.once('load', () => {
        try {
          this.addSourcesAndLayers();
          this.fitInitialBounds();
          this.installHitTesting();
          resolve();
        } catch (error) {
          this.onError(error instanceof Error ? error.message : '地图图层加载失败。');
          resolve();
        }
      });
    });
    this.map.on('error', (event) => {
      const message = event.error instanceof Error ? event.error.message : '地图资源加载失败。';
      this.onError(message);
    });
  }

  private addSourcesAndLayers(): void {
    const sourceEntries = Object.entries(this.datasets) as [keyof MapDatasets, Dataset][];
    for (const [id, data] of sourceEntries) this.map.addSource(id, { type: 'geojson', data });
    const borderFeature: Feature<Geometry, Record<string, string | number>> = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [toGeographic(0, 34), toGeographic(36, 34)] },
      properties: {},
    };
    this.map.addSource('north-border', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [borderFeature] },
    });

    const layers: LayerSpecification[] = [
      {
        id: 'land-fill', type: 'fill', source: 'land',
        paint: { 'fill-color': ['match', ['get', 'kind'], 'monaco', '#e6e5d9', 'ottoman', '#e3dfd2', 'east-region', '#e5e3d8', '#e9e8df'], 'fill-opacity': 0.94 },
      } as LayerSpecification,
      {
        id: 'land-outline', type: 'line', source: 'land',
        paint: { 'line-color': '#879b9b', 'line-width': 1.2, 'line-opacity': 0.75 },
      } as LayerSpecification,
      {
        id: 'district-fill', type: 'fill', source: 'districts',
        paint: { 'fill-color': ['match', ['get', 'kind'], 'urban', '#eadfce', 'military', '#d7dfdb', 'reserve', '#dfe8d7', '#e8e1d6'], 'fill-opacity': 0.88 },
      } as LayerSpecification,
      {
        id: 'district-boundaries', type: 'line', source: 'districts',
        paint: { 'line-color': '#a4aaa0', 'line-width': 1.15, 'line-opacity': 0.9 },
      } as LayerSpecification,
      {
        id: 'north-border', type: 'line', source: 'north-border',
        paint: { 'line-color': '#526e73', 'line-width': 3, 'line-dasharray': [2, 1.3] },
      } as LayerSpecification,
      {
        id: 'parks-fill', type: 'fill', source: 'parks',
        paint: { 'fill-color': '#b8d7bd', 'fill-opacity': 0.96 },
      } as LayerSpecification,
      {
        id: 'parks-outline', type: 'line', source: 'parks',
        paint: { 'line-color': '#7ba889', 'line-width': 1.2 },
      } as LayerSpecification,
      {
        id: 'road-casing', type: 'line', source: 'roads',
        filter: ['any', ['==', ['get', 'class'], 'motorway'], ['==', ['get', 'class'], 'arterial']],
        paint: {
          'line-color': '#fffdf8',
          'line-width': ['match', ['get', 'class'], 'motorway', 7, 'arterial', 4.3, 2],
          'line-opacity': 0.97,
        },
      } as LayerSpecification,
      {
        id: 'roads-main', type: 'line', source: 'roads',
        filter: ['any', ['==', ['get', 'class'], 'motorway'], ['==', ['get', 'class'], 'arterial']],
        paint: {
          'line-color': ['match', ['get', 'class'], 'motorway', '#bd8260', 'arterial', '#d0ad82', '#d4c8b2'],
          'line-width': ['match', ['get', 'class'], 'motorway', 4.2, 'arterial', 2.4, 1],
          'line-opacity': 0.94,
        },
      } as LayerSpecification,
      {
        id: 'streets', type: 'line', source: 'roads', minzoom: 13,
        filter: ['==', ['get', 'class'], 'street'],
        paint: { 'line-color': '#fffdf8', 'line-width': 1.35, 'line-opacity': 0.92 },
      } as LayerSpecification,
      {
        id: 'metro-lines', type: 'line', source: 'metro_lines',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3.2, 'line-opacity': 0.93 },
      } as LayerSpecification,
      {
        id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings', minzoom: 13,
        paint: {
          'fill-extrusion-color': ['match', ['get', 'id'], 'continental-tower', '#b56b48', '#899da0'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.93,
          'fill-extrusion-vertical-gradient': true,
        },
      } as LayerSpecification,
      {
        id: 'metro-stations', type: 'circle', source: 'metro_stations',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'transfer'], 1], 8, 5.3],
          'circle-color': '#fffefa',
          'circle-stroke-color': ['case', ['==', ['get', 'transfer'], 1], '#183d4b', '#536d72'],
          'circle-stroke-width': ['case', ['==', ['get', 'transfer'], 1], 3.3, 2.2],
        },
      } as LayerSpecification,
      {
        id: 'poi-markers', type: 'circle', source: 'pois',
        paint: {
          'circle-radius': ['match', ['get', 'category'], '地标', 6.3, '口岸', 5.8, 4.5],
          'circle-color': ['match', ['get', 'category'], '地标', '#a85e3f', '口岸', '#49656b', '#ffffff'],
          'circle-stroke-color': '#fffefa',
          'circle-stroke-width': 1.8,
        },
      } as LayerSpecification,
      {
        id: 'district-labels', type: 'symbol', source: 'districts', minzoom: 7.7,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DejaVu Sans'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7.7, 11, 10, 14],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: { 'text-color': '#53645d', 'text-halo-color': '#f7f7ef', 'text-halo-width': 1.4 },
      } as LayerSpecification,
      {
        id: 'neighbor-labels', type: 'symbol', source: 'land', minzoom: 7.7,
        filter: ['has', 'name'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DejaVu Sans'],
          'text-size': 14,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#70796f', 'text-halo-color': '#f2f0e7', 'text-halo-width': 1.4 },
      } as LayerSpecification,
      {
        id: 'park-labels', type: 'symbol', source: 'parks', minzoom: 9.5,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11, 'text-allow-overlap': false },
        paint: { 'text-color': '#42694b', 'text-halo-color': '#edf5eb', 'text-halo-width': 1.2 },
      } as LayerSpecification,
      {
        id: 'station-labels', type: 'symbol', source: 'metro_stations', minzoom: 9.3,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': false },
        paint: { 'text-color': '#2d4b55', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
      } as LayerSpecification,
      {
        id: 'poi-labels', type: 'symbol', source: 'pois', minzoom: 10,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 11, 'text-offset': [0, 1.15], 'text-anchor': 'top', 'text-allow-overlap': false },
        paint: { 'text-color': '#344b51', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
      } as LayerSpecification,
      {
        id: 'road-labels', type: 'symbol', source: 'roads', minzoom: 12,
        filter: ['all', ['==', ['get', 'class'], 'arterial'], ['!=', ['get', 'name'], '']],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['DejaVu Sans'], 'text-size': 10, 'text-allow-overlap': false },
        paint: { 'text-color': '#8c684c', 'text-halo-color': '#fffdf8', 'text-halo-width': 1.2 },
      } as LayerSpecification,
    ];

    for (const layer of layers) this.map.addLayer(layer);
  }

  private fitInitialBounds(): void {
    this.applyingLayout = true;
    try {
      this.fitOverviewBounds();
    } finally {
      this.applyingLayout = false;
    }
  }

  private fitOverviewBounds(): void {
    const geometry = [...this.datasets.districts.features, ...this.datasets.land.features]
      .flatMap((feature) => positions(feature.geometry));
    this.map.fitBounds(boundsFromPositions(geometry), {
      padding: this.getCameraPadding(),
      absolutePadding: true,
      duration: 0,
    });
    this.isOverview = true;
  }

  private getCameraPadding() {
    const panelRect = this.panel.getBoundingClientRect();
    const transform = getComputedStyle(this.panel).transform;
    const matrix = transform === 'none' ? undefined : new DOMMatrixReadOnly(transform);
    return getMapPadding(
      this.map.getContainer().getBoundingClientRect(),
      removeTranslationFromRect(panelRect, matrix?.m41 ?? 0, matrix?.m42 ?? 0),
      this.panel.classList.contains('is-open'),
      window.matchMedia('(max-width: 640px)').matches,
    );
  }

  private installCenterBounds(): void {
    this.map.on('move', () => {
      if (this.constrainingCenter) return;
      const current = this.map.getCenter();
      const center = clampCenterToBounds(current, centerBounds);
      if (Math.abs(center[0] - current.lng) < 1e-10 && Math.abs(center[1] - current.lat) < 1e-10) return;
      this.constrainingCenter = true;
      try {
        this.map.jumpTo({ center });
      } finally {
        this.constrainingCenter = false;
      }
    });
  }

  private installHitTesting(): void {
    const clickableLayers = [
      'metro-stations',
      'poi-markers',
      'buildings-3d',
      'parks-fill',
      'roads-main',
      'district-fill',
      'land-fill',
    ];
    this.map.on('click', (event) => {
      for (const layerId of clickableLayers) {
        const rendered = this.map.queryRenderedFeatures(event.point, { layers: [layerId] });
        const feature = rendered.find((candidate) => layerId === 'metro-stations' || this.contentIds.has(featureId(candidate)));
        if (!feature) continue;
        const id = featureId(feature);
        const coordinate: [number, number] = [event.lngLat.lng, event.lngLat.lat];
        if (layerId === 'metro-stations') {
          this.onSelection({ kind: 'station', id, coordinate });
          return;
        }
        this.onSelection({ kind: 'place', id, coordinate });
        return;
      }
    });
    this.map.on('mousemove', (event) => {
      const clickable = clickableLayers.some((layerId) => this.map.queryRenderedFeatures(event.point, { layers: [layerId] })
        .some((feature) => layerId === 'metro-stations' || this.contentIds.has(featureId(feature))));
      this.map.getCanvas().style.cursor = clickable ? 'pointer' : '';
    });
  }

  setLayerVisible(group: 'metro' | 'roads' | 'buildings' | 'places', visible: boolean): void {
    const layers: Record<typeof group, string[]> = {
      metro: ['metro-lines', 'metro-stations', 'station-labels'],
      roads: ['road-casing', 'roads-main', 'streets', 'road-labels'],
      buildings: ['buildings-3d'],
      places: ['poi-markers', 'poi-labels'],
    };
    setVisibility(this.map, layers[group], visible);
  }

  updateLayout(): void {
    const refitOverview = this.isOverview && this.map.isStyleLoaded();
    this.applyingLayout = true;
    try {
      this.map.resize();
      if (refitOverview) this.fitOverviewBounds();
      else {
        const padding = this.getCameraPadding();
        const current = this.map.getPadding();
        if (padding.top !== current.top || padding.right !== current.right
          || padding.bottom !== current.bottom || padding.left !== current.left) {
          this.map.setPadding(padding);
        }
      }
    } finally {
      this.applyingLayout = false;
    }
  }

  setThreeDimensional(enabled: boolean): void {
    this.isOverview = false;
    this.map.easeTo({ pitch: enabled ? 55 : 0, duration: 650 });
  }

  zoomBy(delta: number): void {
    this.isOverview = false;
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: 240 });
  }

  resetNorth(): void {
    this.isOverview = false;
    this.map.easeTo({ bearing: 0, duration: 350 });
  }

  focus(selection: MapSelection, initial = false): void {
    this.isOverview = false;
    const coordinate = selection.coordinate;
    this.map.easeTo({
      center: coordinate as LngLatLike,
      zoom: Math.max(this.map.getZoom(), selection.kind === 'station' ? 12.3 : 11.2),
      padding: this.getCameraPadding(),
      duration: initial ? 0 : 850,
      essential: true,
    });
  }

  focusPlace(id: string, initial = false): void {
    const collectionOrder: Dataset[] = [
      this.datasets.pois,
      this.datasets.parks,
      this.datasets.roads,
      this.datasets.buildings,
      this.datasets.districts,
      this.datasets.land,
    ];
    for (const dataset of collectionOrder) {
      const found = dataset.features.find((feature) => String(feature.properties?.id ?? '') === id);
      const center = found ? centerOf(found as Feature<Geometry, Record<string, unknown>>) : undefined;
      if (center) {
        this.focus({ kind: 'place', id, coordinate: center }, initial);
        return;
      }
    }
  }

  focusStation(id: string, initial = false): void {
    const found = this.datasets.metro_stations.features.find((feature) => String(feature.properties?.id ?? '') === id);
    const center = found ? centerOf(found as Feature<Geometry, Record<string, unknown>>) : undefined;
    if (center) this.focus({ kind: 'station', id, coordinate: center }, initial);
  }
}
