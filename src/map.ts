import {
  Map as MapLibreMap,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
  type MapGeoJSONFeature,
} from 'maplibre-gl';
import type { Feature, Geometry, Position } from 'geojson';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type {
  Dataset,
  DatasetName,
  MapDatasets,
} from './dataset-loader';
import {
  boundsFromPositions,
  clampCenterToBounds,
  geometryFocusZoom,
  getMapPadding,
  initialMapCamera,
  mapCameraLimits,
  mobileScaleOffset,
  pointFocusZoom,
  removeTranslationFromRect,
  shouldFitOverviewForDataset,
  threeDimensionalView,
  type CenterBounds,
} from './map-camera';
import { buildingColorExpression, createMapStyle, createPointAnnotations } from './map-style';
import { applyMapRenderState, mapRenderState } from './map-render-state';
import { layerIds, type LayerGroup } from './map-layer-groups';
import { createRegionalBlockPattern } from './block-patterns';
import { deferRegionalPatternLayers, registerRegionalPatternsBeforeLayers } from './regional-pattern-layers';
import { PaintProtocol } from './paint-protocol';

export type { Dataset, MapDatasets } from './dataset-loader';

export type MapSelection =
  | { kind: 'place'; id: string }
  | { kind: 'station'; id: string };

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

function featureId(feature: MapGeoJSONFeature): string {
  return String(feature.properties?.id ?? '');
}

function centerOf(features: readonly Feature<Geometry, Record<string, unknown>>[]): [number, number] | undefined {
  const points = features.flatMap((feature) => positions(feature.geometry));
  if (points.length === 0) return undefined;
  const longitudes = points.map((position) => position[0]!);
  const latitudes = points.map((position) => position[1]!);
  return [
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  ];
}

function findById(dataset: Dataset, id: string): Feature<Geometry, Record<string, unknown>>[] {
  return dataset.features.filter((feature) => String(feature.properties?.id ?? '') === id) as
    Feature<Geometry, Record<string, unknown>>[];
}

function setVisibility(map: MapLibreMap, layerIds: readonly string[], visible: boolean): void {
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
  private readonly layerVisibility: Record<LayerGroup, boolean> = {
    metro: true,
    roads: true,
    buildings: true,
    places: true,
  };
  private applyingLayout = false;
  private constrainingCenter = false;
  private isOverview = true;
  private selectedId: string | undefined;
  private showAllBuildings = false;
  private readonly painter: PaintProtocol;

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
    this.painter = new PaintProtocol(datasets, onError);
    const initialStyle = deferRegionalPatternLayers(createMapStyle(import.meta.env.BASE_URL, datasets, undefined, this.painter.tiles()));
    this.map = new MapLibreMap({
      container,
      style: initialStyle.style,
      center: [-149.8, 40.17],
      zoom: 8.4,
      pitch: initialMapCamera.pitch,
      bearing: initialMapCamera.bearing,
      minZoom: mapCameraLimits.minZoom,
      maxZoom: mapCameraLimits.maxZoom,
      maxPitch: mapCameraLimits.maxPitch,
      localIdeographFontFamily: 'sans-serif',
      dragRotate: true,
      touchPitch: true,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });
    this.map.on('styleimagemissing', ({ id }) => {
      if (this.map.hasImage(id)) return;
      const image = createRegionalBlockPattern(id);
      if (image) this.map.addImage(id, image, { pixelRatio: 1 });
    });
    this.map.on('style.load', () => {
      this.painter.attach(this.map);
      registerRegionalPatternsBeforeLayers(this.map, initialStyle.layers);
    });
    this.map.on('remove', () => this.painter.dispose());
    this.map.on('zoom', () => this.painter.renderState(this.map.getZoom(), this.map.getPitch(), this.layerVisibility.buildings));
    this.installCenterBounds();
    this.map.on('movestart', () => {
      if (!this.applyingLayout) this.isOverview = false;
    });
    this.map.on('pitch', () => this.applyRenderingState());
    this.map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    this.ready = new Promise((resolve) => {
      this.map.once('load', () => {
        try {
          this.installHitTesting();
          this.applyLayerVisibility();
          this.setSelectedId(this.selectedId);
          this.fitInitialBounds();
          this.updateLayout();
        } catch (error) {
          this.onError(error instanceof Error ? error.message : '地图图层加载失败。');
        }
        resolve();
      });
    });
    this.map.on('error', (event) => {
      const message = event.error instanceof Error ? event.error.message : '地图资源加载失败。';
      this.onError(message);
    });
  }

  private fitInitialBounds(): boolean {
    const geometry = this.datasets.land.features.flatMap((feature) => positions(feature.geometry))
      .filter((position) => Number.isFinite(position[0]) && Number.isFinite(position[1]));
    if (geometry.length === 0) {
      this.isOverview = true;
      return false;
    }
    const wasApplyingLayout = this.applyingLayout;
    this.applyingLayout = true;
    try {
      this.map.fitBounds(boundsFromPositions(geometry), {
        padding: this.getCameraPadding(),
        absolutePadding: true,
        duration: 0,
      });
      this.isOverview = true;
      return true;
    } finally {
      this.applyingLayout = wasApplyingLayout;
    }
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

  private updateScaleControl(): void {
    const container = this.map.getContainer();
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    if (!mobile || !this.panel.classList.contains('is-open')) {
      container.style.setProperty('--mobile-scale-offset', '0px');
      return;
    }
    const mapRect = container.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const transform = getComputedStyle(this.panel).transform;
    const matrix = transform === 'none' ? undefined : new DOMMatrixReadOnly(transform);
    const visiblePanel = removeTranslationFromRect(panelRect, matrix?.m41 ?? 0, matrix?.m42 ?? 0);
    container.style.setProperty(
      '--mobile-scale-offset',
      mobileScaleOffset(mapRect, visiblePanel, true, true) + 'px',
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
      'transfer-stations', 'normal-stations', 'landmark-markers', 'historic-markers', 'other-place-markers',
      'buildings-flat', 'buildings-3d', 'parks-hit', 'arterials', 'highways', 'district-fill', 'land-fill',
    ];
    const findClickable = (point: MapMouseEvent['point']): { kind: MapSelection['kind']; id: string } | undefined => {
      for (const layerId of clickableLayers) {
        const rendered = this.map.queryRenderedFeatures(point, { layers: [layerId] });
        const feature = rendered.find((candidate) => {
          const id = featureId(candidate);
          return id && (layerId.includes('station') || this.contentIds.has(id));
        });
        if (feature) return { kind: layerId.includes('station') ? 'station' : 'place', id: featureId(feature) };
      }
      return undefined;
    };
    this.map.on('click', (event) => {
      const selection = findClickable(event.point);
      if (selection) this.onSelection(selection);
    });
    this.map.on('mousemove', (event) => {
      this.map.getCanvas().style.cursor = findClickable(event.point) ? 'pointer' : '';
    });
  }

  setDataset(name: DatasetName, data: Dataset): void {
    const shouldRefitOverview = shouldFitOverviewForDataset(name, this.isOverview);
    this.datasets[name] = data;
    const source = this.map.getSource(name) as GeoJSONSource | undefined;
    source?.setData(data);
    if (['land', 'districts', 'parks', 'roads', 'blocks', 'boundaries', 'surface', 'terrain'].includes(name)) this.painter.update(this.datasets);
    if (name === 'buildings' && this.selectedId) this.setSelectedId(this.selectedId);
    if (name === 'pois' || name === 'metro_stations') {
      (this.map.getSource('annotations') as GeoJSONSource | undefined)?.setData(createPointAnnotations(this.datasets));
    }
    this.applyRenderingState();
    if (shouldRefitOverview) this.fitInitialBounds();
  }

  setSelectedId(id: string | undefined): void {
    this.selectedId = id;
    this.applyRenderingState();
  }

  setShowAllBuildings(enabled: boolean): void {
    this.showAllBuildings = enabled;
    this.applyRenderingState();
  }

  private applyRenderingState(): void {
    this.painter.renderState(this.map.getZoom(), this.map.getPitch(), this.layerVisibility.buildings);
    const state = mapRenderState(
      this.map.getPitch(), this.layerVisibility.buildings, this.showAllBuildings, this.selectedId,
    );
    applyMapRenderState({
      setVisibility: (layerId, visible) => setVisibility(this.map, [layerId], visible),
      setKeyOnly: (keyOnly) => {
        if (this.map.getLayer('buildings-3d')) {
          this.map.setFilter('buildings-3d', keyOnly ? ['==', ['get', 'key'], 1] : null);
        }
      },
      setSelectedBuildingColor: (layerId, selectedId) => {
        if (this.map.getLayer(layerId)) {
          const color = buildingColorExpression(selectedId);
          this.map.setPaintProperty(layerId, layerId === 'buildings-flat' ? 'fill-color' : 'fill-extrusion-color', color);
        }
      },
    }, state);
  }

  setLayerVisible(group: LayerGroup, visible: boolean): void {
    this.layerVisibility[group] = visible;
    if (group !== 'buildings') setVisibility(this.map, layerIds[group], visible);
    this.applyRenderingState();
  }

  private applyLayerVisibility(): void {
    for (const group of Object.keys(layerIds) as LayerGroup[]) {
      if (group !== 'buildings') setVisibility(this.map, layerIds[group], this.layerVisibility[group]);
    }
    this.applyRenderingState();
  }

  updateLayout(): void {
    const refitOverview = this.isOverview && this.map.isStyleLoaded();
    this.applyingLayout = true;
    try {
      this.map.resize();
      this.updateScaleControl();
      if (!refitOverview || !this.fitInitialBounds()) {
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
    if (!enabled) {
      this.map.easeTo({ pitch: 0, bearing: 0, padding: this.getCameraPadding(), duration: 650 });
      this.applyRenderingState();
      return;
    }
    const target = this.datasets.pois.features.find((feature) => feature.properties?.id === 'continental-tower');
    const continentalCenter = target?.geometry.type === 'Point'
      ? target.geometry.coordinates as [number, number]
      : undefined;
    const center = this.map.getCenter();
    const view = threeDimensionalView(
      this.map.getZoom(),
      [center.lng, center.lat],
      this.map.getBearing(),
      continentalCenter,
    );
    if (view.preset) {
      this.map.flyTo({
        center: view.center,
        zoom: view.zoom,
        pitch: view.pitch,
        bearing: view.bearing,
        padding: this.getCameraPadding(),
        duration: 1500,
        essential: true,
      });
    } else {
      this.map.easeTo({ pitch: view.pitch, padding: this.getCameraPadding(), duration: 650 });
    }
    this.applyRenderingState();
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
    if (selection.kind === 'station') this.focusStation(selection.id, initial);
    else this.focusPlace(selection.id, initial);
  }

  focusPlace(id: string, initial = false): void {
    const duration = initial ? 0 : 850;
    const padding = this.getCameraPadding();
    const region = [...findById(this.datasets.districts, id), ...findById(this.datasets.land, id)];
    if (region.length > 0) {
      this.isOverview = false;
      this.map.fitBounds(boundsFromPositions(region.flatMap((feature) => positions(feature.geometry))), {
        padding, absolutePadding: true, duration, essential: true,
      });
      return;
    }
    const park = findById(this.datasets.parks, id);
    const road = findById(this.datasets.roads, id);
    const geometry = park.length > 0 ? park : road;
    if (geometry.length > 0) {
      const points = geometry.flatMap((feature) => positions(feature.geometry));
      const bounds = boundsFromPositions(points);
      const fit = this.map.cameraForBounds(bounds, { padding, maxZoom: 15 });
      const center = centerOf(geometry);
      if (fit && center) {
        this.isOverview = false;
        this.map.easeTo({
          center,
          zoom: geometryFocusZoom(this.map.getZoom(), fit.zoom ?? 15),
          padding,
          duration,
          essential: true,
        });
        return;
      }
    }
    const point = findById(this.datasets.pois, id);
    const center = centerOf(point);
    if (center) {
      this.isOverview = false;
      this.map.easeTo({
        center,
        zoom: pointFocusZoom(this.map.getZoom(), 15),
        padding,
        duration,
        essential: true,
      });
    }
  }

  focusStation(id: string, initial = false): void {
    const station = this.datasets.metro_stations.features.find((feature) => feature.properties?.id === id);
    const center = station?.geometry.type === 'Point'
      ? station.geometry.coordinates as [number, number]
      : undefined;
    if (!center) return;
    this.isOverview = false;
    this.map.easeTo({
      center,
      zoom: pointFocusZoom(this.map.getZoom(), 14),
      padding: this.getCameraPadding(),
      duration: initial ? 0 : 850,
      essential: true,
    });
  }
}
