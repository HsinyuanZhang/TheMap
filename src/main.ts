import './style.css';
import { getAbout, getPlace, getPlaces } from './content';
import { MapController, type MapDatasets, type MapSelection } from './map';
import { PlacePanel } from './panel';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const mapElement = element<HTMLDivElement>('map');
const mapError = element<HTMLDivElement>('map-error');
const panelElement = element<HTMLElement>('place-panel');
const placePanel = new PlacePanel();
const viewToggle = element<HTMLButtonElement>('view-toggle');
const datasetNames = [
  'land', 'districts', 'parks', 'roads', 'metro_lines', 'metro_stations', 'buildings', 'pois',
] as const;

let mapController: MapController | undefined;
let datasets: MapDatasets | undefined;
let lastHandledHash = location.hash;

function showMapError(): void {
  mapError.textContent = '地图资源加载失败，请刷新页面重试。';
  mapError.hidden = false;
}

function showAbout(): void {
  placePanel.showAbout(getAbout());
  mapController?.updateLayout();
  document.title = '摩纳哥地图';
}

function stationProperties(id: string): Record<string, string | number> | undefined {
  const feature = datasets?.metro_stations.features.find((item) => String(item.properties?.id ?? '') === id);
  return feature?.properties as Record<string, string | number> | undefined;
}

function showStation(id: string): boolean {
  if (!datasets) return false;
  const name = placePanel.showStation(id, datasets);
  if (!name) return false;
  mapController?.updateLayout();
  document.title = `摩纳哥地图 · ${name}`;
  return true;
}

function showPlace(id: string): boolean {
  const place = getPlace(id);
  if (!place) return false;
  placePanel.showPlace(place);
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
  mapController?.updateLayout();
}

async function loadDatasets(): Promise<MapDatasets> {
  const entries = await Promise.all(datasetNames.map(async (name) => {
    const url = new URL(`${import.meta.env.BASE_URL}data/${name}.geojson`, location.origin);
    if (url.origin !== location.origin) throw new Error('Map data must be same-origin.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Map data failed: ${name}`);
    const value = await response.json() as MapDatasets[typeof name];
    if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) throw new Error(`Invalid map data: ${name}`);
    return [name, value] as const;
  }));
  return Object.fromEntries(entries) as unknown as MapDatasets;
}

async function start(): Promise<void> {
  showAbout();
  try {
    datasets = await loadDatasets();
    mapController = new MapController(
      mapElement,
      datasets,
      new Set(getPlaces().keys()),
      (selection) => openSelection(selection, true),
      showMapError,
      panelElement,
    );

    await mapController.ready;
    for (const checkbox of document.querySelectorAll<HTMLInputElement>('[data-layer-toggle]')) {
      checkbox.addEventListener('change', () => {
        const group = checkbox.dataset.layerToggle;
        if (group === 'metro' || group === 'roads' || group === 'buildings' || group === 'places') {
          mapController?.setLayerVisible(group, checkbox.checked);
        }
      });
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
    syncFromLocation(true);
  } catch {
    showMapError();
  }
}

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
