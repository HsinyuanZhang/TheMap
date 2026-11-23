import './style.css';
import { getAbout, getPlace, getPlaces } from './content';
import {
  DatasetLoader,
  emptyMapDatasets,
  initialDatasetNames,
  lazyDatasetNames,
  type Dataset,
  type DatasetName,
  type MapDatasets,
} from './dataset-loader';
import { MapController, type MapSelection } from './map';
import { PlacePanel } from './panel';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const mapElement = element<HTMLDivElement>('map');
const mapError = element<HTMLDivElement>('map-error');
const dataNotice = element<HTMLDivElement>('map-data-notice');
const dataMessage = element<HTMLSpanElement>('map-data-message');
const retryDataButton = element<HTMLButtonElement>('retry-map-data');
const panelElement = element<HTMLElement>('place-panel');
const placePanel = new PlacePanel();
const viewToggle = element<HTMLButtonElement>('view-toggle');
const datasetLoader = new DatasetLoader(import.meta.env.BASE_URL, async (path) => {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) throw new Error('Map data must be same-origin.');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Map data failed: ${path}`);
  return response.json() as Promise<unknown>;
});

let mapController: MapController | undefined;
let datasets: MapDatasets | undefined;
let failedDatasets: DatasetName[] = [];
let retryingData = false;
let lazyLoadStarted = false;
let lastHandledHash = location.hash;

function showMapError(): void {
  mapError.textContent = '地图资源加载失败，请刷新页面重试。';
  mapError.hidden = false;
}

function showDataNotice(failed: DatasetName[]): void {
  failedDatasets = failed;
  if (failed.length === 0) {
    dataNotice.hidden = true;
    return;
  }
  dataMessage.textContent = '部分地图细节加载失败，请重试。';
  retryDataButton.hidden = false;
  dataNotice.hidden = false;
}

function updateDataFailures(attempted: readonly DatasetName[], failed: DatasetName[]): void {
  const stillFailed = failedDatasets.filter((name) => !attempted.includes(name));
  showDataNotice([...stillFailed, ...failed]);
}

async function loadCollections(names: readonly DatasetName[], force = false): Promise<DatasetName[]> {
  const result = await datasetLoader.loadMany(names, force);
  for (const [name, data] of Object.entries(result.datasets) as [DatasetName, Dataset][]) {
    if (datasets) datasets[name] = data;
    mapController?.setDataset(name, data);
  }
  return result.failed;
}

async function loadLazyCollections(): Promise<void> {
  if (lazyLoadStarted || !mapController) return;
  lazyLoadStarted = true;
  updateDataFailures(lazyDatasetNames, await loadCollections(lazyDatasetNames));
}

async function retryFailedCollections(): Promise<void> {
  if (retryingData || failedDatasets.length === 0) return;
  retryingData = true;
  retryDataButton.disabled = true;
  try {
    const attempted = [...failedDatasets];
    updateDataFailures(attempted, await loadCollections(attempted, true));
  } finally {
    retryingData = false;
    retryDataButton.disabled = false;
  }
}

function showAbout(): void {
  placePanel.showAbout(getAbout());
  mapController?.setSelectedId(undefined);
  mapController?.updateLayout();
  document.title = '摩纳哥地图';
}

function stationProperties(id: string): Record<string, string | number | boolean> | undefined {
  const feature = datasets?.metro_stations.features.find((item) => String(item.properties?.id ?? '') === id);
  return feature?.properties as Record<string, string | number | boolean> | undefined;
}

function showStation(id: string): boolean {
  if (!datasets) return false;
  const name = placePanel.showStation(id, datasets);
  if (!name) return false;
  mapController?.setSelectedId(undefined);
  mapController?.updateLayout();
  document.title = `摩纳哥地图 · ${name}`;
  return true;
}

function showPlace(id: string): boolean {
  const place = getPlace(id);
  if (!place) return false;
  placePanel.showPlace(place);
  mapController?.setSelectedId(id);
  mapController?.updateLayout();
  document.title = `摩纳哥地图 · ${place.metadata.name}`;
  return true;
}

function pushLocation(id: string): void {
  const hash = `#place=${encodeURIComponent(id)}`;
  if (location.hash !== hash) {
    history.pushState({ place: id }, '', `${location.pathname}${location.search}${hash}`);
  }
  lastHandledHash = location.hash;
}

function openSelection(selection: MapSelection, updateHistory: boolean): void {
  if (updateHistory) pushLocation(selection.id);
  const displayed = selection.kind === 'station' ? showStation(selection.id) : showPlace(selection.id);
  if (!displayed) return;
  mapController?.focus(selection);
}

function locationIdFromHash(): string | undefined {
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('place') ?? undefined;
}

function syncFromLocation(initial = false): void {
  const id = locationIdFromHash();
  if (!id) {
    showAbout();
    return;
  }
  if (getPlace(id)) {
    showPlace(id);
    mapController?.focusPlace(id, initial);
  } else if (stationProperties(id)) {
    showStation(id);
    mapController?.focusStation(id, initial);
  } else {
    showAbout();
  }
}

function closePanel(): void {
  if (location.hash) {
    history.pushState({}, '', `${location.pathname}${location.search}`);
    lastHandledHash = location.hash;
  }
  placePanel.hide();
  mapController?.setSelectedId(undefined);
  mapController?.updateLayout();
}

async function start(): Promise<void> {
  showAbout();
  try {
    datasets = emptyMapDatasets();
    const initial = await datasetLoader.loadMany(initialDatasetNames);
    Object.assign(datasets, initial.datasets);
    showDataNotice(initial.failed);
    mapController = new MapController(
      mapElement,
      datasets,
      new Set(getPlaces().keys()),
      (selection) => openSelection(selection, true),
      showMapError,
      panelElement,
    );
    mapController.map.once('idle', () => { void loadLazyCollections(); });

    for (const checkbox of document.querySelectorAll<HTMLInputElement>('[data-layer-toggle]')) {
      const group = checkbox.dataset.layerToggle;
      if (group !== 'metro' && group !== 'roads' && group !== 'buildings' && group !== 'places') continue;
      mapController.setLayerVisible(group, checkbox.checked);
      checkbox.addEventListener('change', () => mapController?.setLayerVisible(group, checkbox.checked));
    }
    element<HTMLButtonElement>('zoom-in').addEventListener('click', () => mapController?.zoomBy(1));
    element<HTMLButtonElement>('zoom-out').addEventListener('click', () => mapController?.zoomBy(-1));
    element<HTMLButtonElement>('north-up').addEventListener('click', () => mapController?.resetNorth());
    viewToggle.addEventListener('click', () => {
      const enabled = viewToggle.getAttribute('aria-pressed') !== 'true';
      mapController?.setThreeDimensional(enabled);
      viewToggle.setAttribute('aria-pressed', String(enabled));
      viewToggle.textContent = enabled ? '切换到 2D' : '切换到 3D';
    });
    mapController.map.on('pitch', () => {
      const enabled = mapController?.map.getPitch() !== 0;
      viewToggle.setAttribute('aria-pressed', String(enabled));
      viewToggle.textContent = enabled ? '切换到 2D' : '切换到 3D';
    });
    await mapController.ready;
    syncFromLocation(true);
  } catch {
    showMapError();
  }
}

retryDataButton.addEventListener('click', () => { void retryFailedCollections(); });
placePanel.setOnClose(closePanel);
panelElement.addEventListener('transitionend', (event) => {
  if (event.target === panelElement && event.propertyName === 'transform') mapController?.updateLayout();
});
window.addEventListener('resize', () => mapController?.updateLayout());
window.addEventListener('popstate', () => {
  if (location.hash === lastHandledHash) return;
  lastHandledHash = location.hash;
  syncFromLocation();
});
window.addEventListener('hashchange', () => {
  if (location.hash === lastHandledHash) return;
  lastHandledHash = location.hash;
  syncFromLocation();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && placePanel.isOpen) closePanel();
});

void start();
