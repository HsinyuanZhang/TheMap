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
import { MapController, type MapHoverInfo, type MapSelection } from './map';
import { PlacePanel } from './panel';
import { MAP_LEGEND_ITEMS } from './map-style';
import {
  BUILDING_HEIGHT_BANDS,
  DISTRICT_LENS_COLORS,
  MAP_LENSES,
  getLensDefinition,
  nextLensId,
  type MapLensId,
} from './map-lenses';
import { METRO_COLORS, PLACE_COLORS, placeKind } from './map-overlays';
import { buildSearchIndex, searchEntries, type SearchEntry } from './search';
import { AlmanacModal } from './almanac';
import { downloadAtlasPoster } from './poster-export';
import { UI_ICONS } from './ui-icons';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const mapElement = element<HTMLDivElement>('map');
const mapError = element<HTMLDivElement>('map-error');
const mapTooltip = element<HTMLDivElement>('map-tooltip');
const dataNotice = element<HTMLDivElement>('map-data-notice');
const dataMessage = element<HTMLSpanElement>('map-data-message');
const retryDataButton = element<HTMLButtonElement>('retry-map-data');
const panelElement = element<HTMLElement>('place-panel');
const placePanel = new PlacePanel();
const viewToggle = element<HTMLButtonElement>('view-toggle');
const northButton = element<HTMLButtonElement>('north-up');
const almanacButton = element<HTMLButtonElement>('open-almanac');
const shareButton = element<HTMLButtonElement>('open-share');
const helpButton = element<HTMLButtonElement>('open-help');
const resetOverviewButton = element<HTMLButtonElement>('reset-overview');
const brandHome = element<HTMLAnchorElement>('brand-home');
const allBuildings3d = element<HTMLInputElement>('all-buildings-3d');
const layersToggle = element<HTMLButtonElement>('layers-toggle');
const layerPopover = element<HTMLElement>('layer-popover');
const sharePopover = element<HTMLDivElement>('share-popover');
const shareCopyUrl = element<HTMLButtonElement>('share-copy-url');
const shareDownloadPng = element<HTMLButtonElement>('share-download-png');
const sharePopStatus = element<HTMLParagraphElement>('share-pop-status');
const helpModal = element<HTMLDivElement>('help-modal');
const toastElement = element<HTMLDivElement>('toast');
const searchInput = element<HTMLInputElement>('search-input');
const searchResults = element<HTMLDivElement>('search-results');
const lensButtonsContainer = element<HTMLDivElement>('lens-buttons');
const legendSummary = element<HTMLElement>('map-legend-summary');
const legendDesc = element<HTMLParagraphElement>('lens-legend-desc');
const legendInteractive = element<HTMLDivElement>('lens-legend-interactive');
const legendItemsList = element<HTMLUListElement>('map-legend-items');

const almanacModal = new AlmanacModal(
  element<HTMLDivElement>('almanac-modal'),
  element<HTMLElement>('almanac-nav'),
  element<HTMLElement>('almanac-body'),
);

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
let activeLens: MapLensId = 'standard';
let activeHeightBand: string | undefined;
let searchIndex: SearchEntry[] = [];
let currentSearchMatches: SearchEntry[] = [];
let activeSearchIndex = -1;
let toastTimer: number | undefined;

function showToast(message: string): void {
  toastElement.textContent = message;
  toastElement.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastElement.hidden = true;
  }, 2400);
}

function hydrateStaticIcons(): void {
  element<HTMLSpanElement>('search-icon').innerHTML = UI_ICONS.search;
  northButton.innerHTML = `${UI_ICONS.compass}<span class="btn-lbl">北向上</span>`;
  viewToggle.innerHTML = `${UI_ICONS.cube}<span class="btn-lbl">3D</span>`;
  almanacButton.innerHTML = `${UI_ICONS.book}<span class="btn-lbl">图志</span>`;
  shareButton.innerHTML = `${UI_ICONS.share}<span class="btn-lbl">分享</span>`;
  helpButton.innerHTML = UI_ICONS.help;
  resetOverviewButton.innerHTML = UI_ICONS.home;
  shareCopyUrl.innerHTML = `${UI_ICONS.link}<span>复制当前链接</span>`;
  shareDownloadPng.innerHTML = `${UI_ICONS.download}<span>导出视图海报</span><span class="sub">1600×900 PNG</span>`;
  updateLayersToggleLabel();
}

function updateViewToggleButton(enabled: boolean): void {
  viewToggle.setAttribute('aria-pressed', String(enabled));
  viewToggle.innerHTML = `${UI_ICONS.cube}<span class="btn-lbl">${enabled ? '2D' : '3D'}</span>`;
}

function updateLayersToggleLabel(): void {
  const checkboxes = document.querySelectorAll<HTMLInputElement>('#layer-popover input[type="checkbox"]');
  const activeCount = [...checkboxes].filter((cb) => cb.checked).length;
  layersToggle.innerHTML = `${UI_ICONS.layers}<span>图层</span><span class="layers-count">${activeCount}</span>`;
}

function showMapError(): void {
  mapError.textContent = '地图资源加载失败，请刷新页面重试。';
  mapError.hidden = false;
}

function renderStandardLegendItems(): void {
  legendItemsList.replaceChildren();
  for (const item of MAP_LEGEND_ITEMS) {
    const row = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    if ('symbol' in item) {
      swatch.classList.add('legend-swatch-line');
      if (item.symbol === 'dashed-line') swatch.classList.add('legend-swatch-dashed');
      swatch.style.setProperty('--legend-color', item.swatch);
    } else {
      swatch.style.background = item.swatch;
    }
    swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(swatch, label);
    legendItemsList.append(row);
  }
}

function renderLegendForLens(): void {
  const lens = getLensDefinition(activeLens);
  legendSummary.textContent = activeLens === 'standard' ? '地图图例' : `${lens.label} · 图例`;
  legendDesc.textContent = lens.description;
  legendDesc.hidden = activeLens === 'standard';
  legendInteractive.replaceChildren();

  if (activeLens === 'buildings') {
    legendInteractive.hidden = false;
    for (const band of BUILDING_HEIGHT_BANDS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'legend-chip';
      btn.classList.toggle('active', activeHeightBand === band.id);
      const swatch = document.createElement('i');
      swatch.style.background = band.color;
      btn.append(swatch, document.createTextNode(`${band.label} ${band.rangeText}`));
      btn.addEventListener('click', () => {
        activeHeightBand = activeHeightBand === band.id ? undefined : band.id;
        mapController?.setHeightBandFilter(activeHeightBand);
        renderLegendForLens();
      });
      legendInteractive.append(btn);
    }
    legendItemsList.hidden = true;
    return;
  }

  if (activeLens === 'districts') {
    legendInteractive.hidden = false;
    for (const [id, info] of Object.entries(DISTRICT_LENS_COLORS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'legend-chip';
      const swatch = document.createElement('i');
      swatch.style.background = info.color;
      btn.append(swatch, document.createTextNode(info.name));
      btn.addEventListener('click', () => openSelection({ kind: 'place', id }, true));
      legendInteractive.append(btn);
    }
    legendItemsList.hidden = true;
    return;
  }

  if (activeLens === 'transit') {
    legendInteractive.hidden = false;
    for (const [lineId, color] of Object.entries(METRO_COLORS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'legend-chip';
      const swatch = document.createElement('i');
      swatch.style.background = color;
      btn.append(swatch, document.createTextNode(`地铁 ${lineId}`));
      btn.addEventListener('click', () => almanacModal.open('transit'));
      legendInteractive.append(btn);
    }
    legendItemsList.hidden = true;
    return;
  }

  legendInteractive.hidden = true;
  legendItemsList.hidden = false;
}

function renderLensDock(): void {
  const iconForLens: Record<MapLensId, string> = {
    standard: UI_ICONS.map,
    transit: UI_ICONS.transit,
    buildings: UI_ICONS.buildings,
    districts: UI_ICONS.districts,
  };
  lensButtonsContainer.replaceChildren();
  for (const lens of MAP_LENSES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dock-btn';
    btn.classList.toggle('active', lens.id === activeLens);
    btn.setAttribute('aria-pressed', String(lens.id === activeLens));
    btn.title = `${lens.label}：${lens.description}`;
    btn.innerHTML = `${iconForLens[lens.id]}<span>${lens.shortLabel}</span><span class="lens-ramp" style="background:${lens.ramp}" aria-hidden="true"></span>`;
    btn.addEventListener('click', () => setLens(lens.id));
    lensButtonsContainer.append(btn);
  }
}

function setLens(lensId: MapLensId): void {
  activeLens = lensId;
  if (lensId !== 'buildings') activeHeightBand = undefined;
  if (lensId === 'transit') {
    const metroToggle = document.querySelector<HTMLInputElement>('[data-layer-toggle="metro"]');
    if (metroToggle && !metroToggle.checked) {
      metroToggle.checked = true;
      mapController?.setLayerVisible('metro', true);
      updateLayersToggleLabel();
    }
  }
  if (lensId === 'buildings') {
    const bToggle = document.querySelector<HTMLInputElement>('[data-layer-toggle="buildings"]');
    if (bToggle && !bToggle.checked) {
      bToggle.checked = true;
      mapController?.setLayerVisible('buildings', true);
      updateLayersToggleLabel();
    }
  }
  mapController?.setLens(lensId);
  renderLensDock();
  renderLegendForLens();
  const def = getLensDefinition(lensId);
  showToast(`已切换至「${def.label}」视图`);
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
  if (datasets) {
    searchIndex = buildSearchIndex(getPlaces(), datasets);
    almanacModal.configure(getAbout(), getPlaces(), datasets, (sel) => openSelection(sel, true));
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

function stationProperties(id: string): Record<string, string | number | boolean> | undefined {
  const feature = datasets?.metro_stations.features.find((item) => String(item.properties?.id ?? '') === id);
  return feature?.properties as Record<string, string | number | boolean> | undefined;
}

function showStation(id: string): boolean {
  if (!datasets) return false;
  const name = placePanel.showStation(id, datasets);
  if (!name) return false;
  mapController?.setSelectedId(undefined);
  mapController?.setSelectionHighlight({ kind: 'station', id });
  mapController?.updateLayout();
  document.title = `摩纳哥地图 · ${name}`;
  return true;
}

function showPlace(id: string): boolean {
  const place = getPlace(id);
  if (!place) return false;
  placePanel.showPlace(place, getPlaces(), datasets);
  mapController?.setSelectedId(id);
  mapController?.setSelectionHighlight({ kind: 'place', id });
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
  closeSearchResults();
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
    placePanel.hide();
    mapController?.setSelectedId(undefined);
    mapController?.setSelectionHighlight(undefined);
    mapController?.updateLayout();
    document.title = '摩纳哥地图';
    return;
  }
  if (getPlace(id)) {
    showPlace(id);
    mapController?.focusPlace(id, initial);
  } else if (stationProperties(id)) {
    showStation(id);
    mapController?.focusStation(id, initial);
  } else {
    placePanel.hide();
    mapController?.setSelectedId(undefined);
    mapController?.setSelectionHighlight(undefined);
  }
}

function closePanel(): void {
  if (location.hash) {
    history.pushState({}, '', `${location.pathname}${location.search}`);
    lastHandledHash = location.hash;
  }
  placePanel.hide();
  mapController?.setSelectedId(undefined);
  mapController?.setSelectionHighlight(undefined);
  mapController?.updateLayout();
  document.title = '摩纳哥地图';
}

function handleHover(hover: MapHoverInfo | undefined): void {
  if (!hover) {
    mapTooltip.hidden = true;
    return;
  }
  let name = '';
  let sub = '';
  if (hover.selection.kind === 'station') {
    const props = stationProperties(hover.selection.id);
    if (!props) {
      mapTooltip.hidden = true;
      return;
    }
    name = String(props.name ?? '');
    const lines = String(props.lines ?? '').split(',').filter(Boolean).join(' / ');
    sub = `${lines ? `${lines} · ` : ''}${String(props.district ?? '待定')}`;
  } else {
    const place = getPlace(hover.selection.id);
    if (!place) {
      mapTooltip.hidden = true;
      return;
    }
    name = place.metadata.name;
    sub = place.metadata.type === '城区' || place.metadata.type === '邻区'
      ? place.metadata.type
      : `${place.metadata.type} · ${place.metadata.district}`;
  }

  mapTooltip.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = name;
  const subEl = document.createElement('div');
  subEl.className = 'tt-sub';
  subEl.textContent = sub;
  mapTooltip.append(title, subEl);
  mapTooltip.hidden = false;

  const pad = 14;
  const rect = mapTooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 10, hover.x + pad);
  const top = Math.max(54, Math.min(window.innerHeight - rect.height - 10, hover.y - rect.height - 10));
  mapTooltip.style.left = `${Math.max(10, left)}px`;
  mapTooltip.style.top = `${top}px`;
}

function positionSearchResults(): void {
  const rect = searchInput.getBoundingClientRect();
  const width = Math.max(rect.width, 280);
  searchResults.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  searchResults.style.top = `${rect.bottom + 6}px`;
  searchResults.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
}

function closeSearchResults(): void {
  searchResults.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  activeSearchIndex = -1;
}

function entryDotColor(entry: SearchEntry): string {
  if (entry.kind === 'station') {
    const firstLine = entry.subtitle.split(' ')[0] as keyof typeof METRO_COLORS;
    return METRO_COLORS[firstLine] ?? '#c9a45c';
  }
  if (entry.category === '城区') return DISTRICT_LENS_COLORS[entry.id]?.color ?? '#c9a45c';
  return PLACE_COLORS[placeKind({ id: entry.id, category: entry.category })];
}

function renderSearchResults(): void {
  currentSearchMatches = searchEntries(searchIndex, searchInput.value, 12);
  activeSearchIndex = currentSearchMatches.length > 0 ? 0 : -1;
  searchResults.replaceChildren();

  if (currentSearchMatches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sr-empty';
    empty.textContent = '未找到匹配的地点、城区或车站';
    searchResults.append(empty);
  } else {
    currentSearchMatches.forEach((entry, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.role = 'option';
      btn.className = 'sr-item';
      btn.classList.toggle('is-active', index === activeSearchIndex);

      const dot = document.createElement('span');
      dot.className = 'sr-dot';
      dot.style.background = entryDotColor(entry);

      const main = document.createElement('span');
      main.className = 'sr-main';
      const name = document.createElement('span');
      name.className = 'sr-name';
      name.textContent = entry.name;
      const sub = document.createElement('span');
      sub.className = 'sr-sub';
      sub.textContent = entry.subtitle;
      main.append(name, sub);

      const cat = document.createElement('span');
      cat.className = 'sr-cat';
      cat.textContent = entry.category;

      btn.append(dot, main, cat);
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        searchInput.value = '';
        searchInput.blur();
        openSelection({ kind: entry.kind, id: entry.id }, true);
      });
      searchResults.append(btn);
    });
  }

  positionSearchResults();
  searchResults.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}

function updateActiveSearchHighlight(): void {
  const items = searchResults.querySelectorAll<HTMLButtonElement>('.sr-item');
  items.forEach((item, index) => {
    const active = index === activeSearchIndex;
    item.classList.toggle('is-active', active);
    if (active) item.scrollIntoView({ block: 'nearest' });
  });
}

function toggleLayerPopover(force?: boolean): void {
  const open = force ?? layerPopover.hidden;
  layerPopover.hidden = !open;
  layersToggle.setAttribute('aria-expanded', String(open));
  if (open) toggleSharePopover(false);
}

function toggleSharePopover(force?: boolean): void {
  const open = force ?? sharePopover.hidden;
  sharePopover.hidden = !open;
  shareButton.setAttribute('aria-expanded', String(open));
  sharePopStatus.textContent = '';
  if (open) toggleLayerPopover(false);
}

function openHelpModal(): void {
  toggleLayerPopover(false);
  toggleSharePopover(false);
  helpModal.hidden = false;
}

function closeHelpModal(): void {
  helpModal.hidden = true;
}

async function copyCurrentUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    sharePopStatus.textContent = '当前视图链接已复制。';
    showToast('当前视图链接已复制');
  } catch {
    sharePopStatus.textContent = '复制失败，请从地址栏手动复制。';
  }
}

function exportPoster(): void {
  const canvas = mapController?.map.getCanvas();
  if (!canvas) return;
  try {
    const summary = placePanel.activeSummary;
    downloadAtlasPoster(canvas, {
      lens: getLensDefinition(activeLens),
      selectedTitle: summary.title,
      selectedSubtitle: summary.subtitle,
    });
    toggleSharePopover(false);
    showToast('已导出 1600×900 视图海报 PNG');
  } catch {
    sharePopStatus.textContent = '导出失败，请稍后重试。';
  }
}

async function start(): Promise<void> {
  hydrateStaticIcons();
  renderStandardLegendItems();
  renderLensDock();
  renderLegendForLens();
  placePanel.setDirectory(getPlaces());
  placePanel.setOnNavigate((selection) => openSelection(selection, true));

  try {
    datasets = emptyMapDatasets();
    const initial = await datasetLoader.loadMany(initialDatasetNames);
    Object.assign(datasets, initial.datasets);
    showDataNotice(initial.failed);
    searchIndex = buildSearchIndex(getPlaces(), datasets);
    almanacModal.configure(getAbout(), getPlaces(), datasets, (sel) => openSelection(sel, true));

    mapController = new MapController(
      mapElement,
      datasets,
      new Set(getPlaces().keys()),
      (selection) => openSelection(selection, true),
      showMapError,
      panelElement,
      handleHover,
    );
    mapController.map.once('idle', () => { void loadLazyCollections(); });

    for (const checkbox of document.querySelectorAll<HTMLInputElement>('[data-layer-toggle]')) {
      const group = checkbox.dataset.layerToggle;
      if (group !== 'metro' && group !== 'roads' && group !== 'buildings' && group !== 'places') continue;
      mapController.setLayerVisible(group, checkbox.checked);
      checkbox.addEventListener('change', () => {
        mapController?.setLayerVisible(group, checkbox.checked);
        updateLayersToggleLabel();
      });
    }
    allBuildings3d.addEventListener('change', () => {
      mapController?.setShowAllBuildings(allBuildings3d.checked);
      updateLayersToggleLabel();
    });
    element<HTMLButtonElement>('zoom-in').addEventListener('click', () => mapController?.zoomBy(1));
    element<HTMLButtonElement>('zoom-out').addEventListener('click', () => mapController?.zoomBy(-1));
    northButton.addEventListener('click', () => mapController?.resetNorth());
    resetOverviewButton.addEventListener('click', () => {
      closePanel();
      mapController?.resetOverview();
    });
    brandHome.addEventListener('click', (event) => {
      event.preventDefault();
      closePanel();
      mapController?.resetOverview();
    });
    viewToggle.addEventListener('click', () => {
      const enabled = viewToggle.getAttribute('aria-pressed') !== 'true';
      mapController?.setThreeDimensional(enabled);
      updateViewToggleButton(enabled);
    });
    mapController.map.on('pitch', () => {
      const enabled = (mapController?.map.getPitch() ?? 0) >= 10;
      updateViewToggleButton(enabled);
    });
    await mapController.ready;
    syncFromLocation(true);
  } catch {
    showMapError();
  }
}

// UI control listeners
retryDataButton.addEventListener('click', () => { void retryFailedCollections(); });
placePanel.setOnClose(closePanel);
almanacButton.addEventListener('click', () => {
  toggleLayerPopover(false);
  toggleSharePopover(false);
  almanacModal.open();
});
layersToggle.addEventListener('click', () => toggleLayerPopover());
shareButton.addEventListener('click', () => toggleSharePopover());
shareCopyUrl.addEventListener('click', () => { void copyCurrentUrl(); });
shareDownloadPng.addEventListener('click', exportPoster);
helpButton.addEventListener('click', openHelpModal);

helpModal.addEventListener('click', (event) => {
  if (event.target === helpModal || (event.target as HTMLElement | null)?.closest('[data-close-modal]')) {
    closeHelpModal();
  }
});

// Close popovers when clicking outside
document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node | null;
  if (!target) return;
  if (!layerPopover.hidden && !layerPopover.contains(target) && !layersToggle.contains(target)) {
    toggleLayerPopover(false);
  }
  if (!sharePopover.hidden && !sharePopover.contains(target) && !shareButton.contains(target)) {
    toggleSharePopover(false);
  }
  if (!searchResults.hidden && !searchResults.contains(target) && target !== searchInput) {
    closeSearchResults();
  }
});

// Search box interactions
searchInput.addEventListener('focus', () => renderSearchResults());
searchInput.addEventListener('input', () => renderSearchResults());
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (currentSearchMatches.length > 0) {
      activeSearchIndex = (activeSearchIndex + 1) % currentSearchMatches.length;
      updateActiveSearchHighlight();
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (currentSearchMatches.length > 0) {
      activeSearchIndex = (activeSearchIndex - 1 + currentSearchMatches.length) % currentSearchMatches.length;
      updateActiveSearchHighlight();
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const chosen = currentSearchMatches[activeSearchIndex] ?? currentSearchMatches[0];
    if (chosen) {
      searchInput.value = '';
      searchInput.blur();
      openSelection({ kind: chosen.kind, id: chosen.id }, true);
    }
  } else if (event.key === 'Escape') {
    closeSearchResults();
    searchInput.blur();
  }
});

panelElement.addEventListener('transitionend', (event) => {
  if (event.target === panelElement && event.propertyName === 'transform') mapController?.updateLayout();
});
window.addEventListener('resize', () => {
  mapController?.updateLayout();
  if (!searchResults.hidden) positionSearchResults();
});
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

// Global keyboard shortcuts (usaciv-inspired navigation)
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  if (event.key === 'Escape') {
    if (!helpModal.hidden) { closeHelpModal(); return; }
    if (almanacModal.isOpen) { almanacModal.close(); return; }
    if (!sharePopover.hidden) { toggleSharePopover(false); return; }
    if (!layerPopover.hidden) { toggleLayerPopover(false); return; }
    if (!searchResults.hidden) { closeSearchResults(); return; }
    if (placePanel.isOpen) { closePanel(); return; }
    return;
  }

  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === '/') {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key === '?') {
    event.preventDefault();
    if (helpModal.hidden) openHelpModal();
    else closeHelpModal();
  } else if (event.key === 'l' || event.key === 'L') {
    event.preventDefault();
    setLens(nextLensId(activeLens, event.shiftKey ? -1 : 1));
  } else if (event.key === '3') {
    event.preventDefault();
    const enabled = viewToggle.getAttribute('aria-pressed') !== 'true';
    mapController?.setThreeDimensional(enabled);
    updateViewToggleButton(enabled);
  } else if (event.key === 'r' || event.key === 'R') {
    event.preventDefault();
    closePanel();
    mapController?.resetOverview();
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    mapController?.zoomBy(0.8);
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault();
    mapController?.zoomBy(-0.8);
  } else if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
    event.preventDefault();
    mapController?.panBy(0, -140);
  } else if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') {
    event.preventDefault();
    mapController?.panBy(0, 140);
  } else if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') {
    event.preventDefault();
    mapController?.panBy(-160, 0);
  } else if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') {
    event.preventDefault();
    mapController?.panBy(160, 0);
  }
});

void start();
