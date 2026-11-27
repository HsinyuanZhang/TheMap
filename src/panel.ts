import type { ContentDocument } from './content-format';
import { renderSafeMarkdown } from './markdown';
import { getStationNavigation } from './station-info';
import type { MapDatasets, MapSelection } from './map';
import { DISTRICT_LENS_COLORS } from './map-lenses';
import { METRO_COLORS, PLACE_COLORS, placeKind } from './map-overlays';
import { UI_ICONS } from './ui-icons';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

export class PlacePanel {
  private readonly root = element<HTMLElement>('place-panel');
  private readonly stripe = element<HTMLSpanElement>('panel-stripe');
  private readonly kicker = element<HTMLParagraphElement>('panel-kicker');
  private readonly title = element<HTMLHeadingElement>('panel-title');
  private readonly meta = element<HTMLDivElement>('panel-meta');
  private readonly stationMeta = element<HTMLDivElement>('station-meta');
  private readonly body = element<HTMLDivElement>('panel-body');
  private readonly related = element<HTMLDivElement>('panel-related');
  private readonly shareArea = element<HTMLDivElement>('share-area');
  private readonly shareLink = element<HTMLInputElement>('share-link');
  private readonly copyStatus = element<HTMLParagraphElement>('copy-status');
  private renderVersion = 0;
  private closeHandler: (() => void) | undefined;
  private navigateHandler: ((selection: MapSelection) => void) | undefined;
  private districtIdByName = new Map<string, string>();
  private currentTitle: string | undefined;
  private currentSubtitle: string | undefined;

  constructor() {
    element<HTMLButtonElement>('close-panel').addEventListener('click', () => this.closeHandler?.());
    element<HTMLButtonElement>('copy-link').addEventListener('click', () => void this.copyLink());
  }

  get isOpen(): boolean {
    return this.root.classList.contains('is-open');
  }

  get activeSummary(): { title?: string; subtitle?: string } {
    return this.isOpen ? { title: this.currentTitle, subtitle: this.currentSubtitle } : {};
  }

  setOnClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  setOnNavigate(handler: (selection: MapSelection) => void): void {
    this.navigateHandler = handler;
  }

  setDirectory(places: ReadonlyMap<string, ContentDocument>): void {
    this.districtIdByName.clear();
    for (const doc of places.values()) {
      if (doc.metadata.type === '城区' || doc.metadata.type === '邻区') {
        this.districtIdByName.set(doc.metadata.name, doc.metadata.id);
      }
    }
  }

  showAbout(markdown: string): void {
    this.stripe.style.background = '#c9a45c';
    this.kicker.textContent = '城市图志';
    this.title.textContent = '摩纳哥';
    this.currentTitle = '摩纳哥';
    this.currentSubtitle = '太平洋海角特别行政区';
    this.meta.hidden = true;
    this.meta.replaceChildren();
    this.stationMeta.hidden = true;
    this.stationMeta.replaceChildren();
    this.related.hidden = true;
    this.related.replaceChildren();
    this.shareArea.hidden = true;
    this.copyStatus.textContent = '';
    void this.renderBody(markdown);
    this.setOpen(true);
  }

  showPlace(
    document: ContentDocument,
    places?: ReadonlyMap<string, ContentDocument>,
    datasets?: MapDatasets,
  ): void {
    const { id, name, type, district } = document.metadata;
    const isRegion = type === '城区' || type === '邻区';
    this.stripe.style.background = isRegion
      ? (DISTRICT_LENS_COLORS[id]?.color ?? '#c9a45c')
      : PLACE_COLORS[placeKind({ id, category: type })];
    this.kicker.textContent = isRegion ? (type === '城区' ? '行政区划' : '周边邻区') : '地点档案';
    this.title.textContent = name;
    this.currentTitle = name;
    this.currentSubtitle = isRegion ? type : `${type} · ${district}`;
    this.setMeta(type, isRegion ? undefined : district);
    this.stationMeta.hidden = true;
    this.stationMeta.replaceChildren();
    this.renderRelated(document, places, datasets);
    this.setShareLink(id);
    void this.renderBody(document.body);
    this.setOpen(true);
  }

  showStation(id: string, datasets: MapDatasets): string | undefined {
    const station = getStationNavigation(id, datasets);
    if (!station) return undefined;
    this.renderVersion += 1;
    const primaryLine = station.lines[0]?.id as keyof typeof METRO_COLORS | undefined;
    this.stripe.style.background = (primaryLine && METRO_COLORS[primaryLine]) || '#c9a45c';
    this.kicker.textContent = station.lines.length > 1 ? '轨道换乘站' : '轨道交通车站';
    this.title.textContent = station.name;
    this.currentTitle = station.name;
    this.currentSubtitle = `${station.lines.map((l) => l.id).join(' / ')} · ${station.district}`;
    this.setMeta(station.lines.length > 1 ? '换乘站' : '地铁站', station.district);

    this.stationMeta.replaceChildren();
    for (const line of station.lines) {
      const card = document.createElement('div');
      card.className = 'station-line-card';

      const badge = document.createElement('span');
      badge.className = 'metro-pill';
      badge.style.background = METRO_COLORS[line.id as keyof typeof METRO_COLORS] ?? '#c9a45c';
      badge.textContent = line.id;

      const nav = document.createElement('div');
      nav.className = 'station-neighbors';

      const makeStopBtn = (dir: 'prev' | 'next', label: string | undefined, stopId: string | undefined): HTMLElement => {
        if (!label || !stopId) {
          const span = document.createElement('span');
          span.className = 'station-stop-end';
          span.textContent = dir === 'prev' ? '起点站' : '终点站';
          return span;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'station-stop-btn';
        btn.innerHTML = dir === 'prev'
          ? `${UI_ICONS.chevronLeft}<span>${label}</span>`
          : `<span>${label}</span>${UI_ICONS.chevronRight}`;
        btn.title = `跳转到 ${label}`;
        btn.addEventListener('click', () => this.navigateHandler?.({ kind: 'station', id: stopId }));
        return btn;
      };

      nav.append(
        makeStopBtn('prev', line.previous, line.previousId),
        makeStopBtn('next', line.next, line.nextId),
      );
      card.append(badge, nav);
      this.stationMeta.append(card);
    }

    this.stationMeta.hidden = false;
    this.body.replaceChildren();
    this.renderStationRoutes(id, station.lines.map((l) => l.id), datasets);
    this.setShareLink(id);
    this.setOpen(true);
    return station.name;
  }

  private renderStationRoutes(activeId: string, lineIds: string[], datasets: MapDatasets): void {
    this.related.replaceChildren();
    const stationById = new Map(
      datasets.metro_stations.features.map((f) => [String(f.properties?.id ?? ''), f.properties]),
    );
    for (const lineId of lineIds) {
      const line = datasets.metro_lines.features.find((f) => String(f.properties?.id ?? '') === lineId);
      const stops = String(line?.properties?.stations ?? '').split(',').filter(Boolean);
      if (stops.length === 0) continue;

      const heading = document.createElement('h3');
      heading.className = 'panel-sec-title';
      heading.textContent = `${lineId} 沿线车站（${stops.length}）`;
      this.related.append(heading);

      const strip = document.createElement('div');
      strip.className = 'almanac-stops';
      for (const stopId of stops) {
        const props = stationById.get(stopId);
        if (!props) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'almanac-stop-chip';
        if (stopId === activeId) btn.classList.add('is-current');
        else if (Number(props.transfer) === 1) btn.classList.add('is-transfer');
        btn.textContent = String(props.name ?? stopId);
        btn.addEventListener('click', () => this.navigateHandler?.({ kind: 'station', id: stopId }));
        strip.append(btn);
      }
      this.related.append(strip);
    }
    this.related.hidden = this.related.childElementCount === 0;
  }

  hide(): void {
    this.root.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.inert = true;
    document.body.classList.remove('panel-open');
    this.renderVersion += 1;
  }

  private setOpen(open: boolean): void {
    this.root.classList.toggle('is-open', open);
    this.root.setAttribute('aria-hidden', String(!open));
    this.root.inert = !open;
    document.body.classList.toggle('panel-open', open);
  }

  private setMeta(type: string, district: string | undefined): void {
    this.meta.replaceChildren();
    const typeChip = document.createElement('span');
    typeChip.className = 'meta-chip';
    typeChip.textContent = type;
    this.meta.append(typeChip);

    if (district) {
      const districtId = this.districtIdByName.get(district);
      if (districtId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'meta-chip meta-chip-link';
        btn.textContent = `${district} →`;
        btn.title = `定位到 ${district}`;
        btn.addEventListener('click', () => this.navigateHandler?.({ kind: 'place', id: districtId }));
        this.meta.append(btn);
      } else {
        const chip = document.createElement('span');
        chip.className = 'meta-chip';
        chip.textContent = district;
        this.meta.append(chip);
      }
    }
    this.meta.hidden = false;
  }

  private renderRelated(
    contentDoc: ContentDocument,
    places?: ReadonlyMap<string, ContentDocument>,
    datasets?: MapDatasets,
  ): void {
    this.related.replaceChildren();
    if (contentDoc.metadata.type !== '城区' || !places) {
      this.related.hidden = true;
      return;
    }

    const districtName = contentDoc.metadata.name;
    const districtPlaces = [...places.values()]
      .filter((doc) => doc.metadata.id !== contentDoc.metadata.id && doc.metadata.district === districtName);
    const districtStations = (datasets?.metro_stations.features ?? [])
      .filter((f) => String(f.properties?.district ?? '') === districtName)
      .map((f) => ({
        id: String(f.properties?.id ?? ''),
        name: String(f.properties?.name ?? ''),
        lines: String(f.properties?.lines ?? '').split(',').filter(Boolean),
      }))
      .filter((s) => s.id && s.name);

    if (districtPlaces.length === 0 && districtStations.length === 0) {
      this.related.hidden = true;
      return;
    }

    if (districtPlaces.length > 0) {
      const heading = document.createElement('h3');
      heading.className = 'panel-sec-title';
      heading.textContent = `区内地点（${districtPlaces.length}）`;
      this.related.append(heading);

      const list = document.createElement('div');
      list.className = 'related-list';
      for (const item of districtPlaces) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'related-row';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'related-name';
        nameSpan.textContent = item.metadata.name;
        const tag = document.createElement('span');
        tag.className = 'related-tag';
        tag.textContent = item.metadata.type;
        row.append(nameSpan, tag);
        row.addEventListener('click', () => this.navigateHandler?.({ kind: 'place', id: item.metadata.id }));
        list.append(row);
      }
      this.related.append(list);
    }

    if (districtStations.length > 0) {
      const heading = document.createElement('h3');
      heading.className = 'panel-sec-title';
      heading.textContent = `区内地铁站（${districtStations.length}）`;
      this.related.append(heading);

      const list = document.createElement('div');
      list.className = 'related-list';
      for (const station of districtStations) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'related-row';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'related-name';
        nameSpan.textContent = station.name;
        const linesWrap = document.createElement('span');
        linesWrap.className = 'related-lines';
        for (const lineId of station.lines) {
          const pill = document.createElement('span');
          pill.className = 'metro-pill mini';
          pill.style.background = METRO_COLORS[lineId as keyof typeof METRO_COLORS] ?? '#c9a45c';
          pill.textContent = lineId;
          linesWrap.append(pill);
        }
        row.append(nameSpan, linesWrap);
        row.addEventListener('click', () => this.navigateHandler?.({ kind: 'station', id: station.id }));
        list.append(row);
      }
      this.related.append(list);
    }

    this.related.hidden = false;
  }

  private setShareLink(id: string): void {
    const target = new URL(`${location.pathname}${location.search}`, location.origin);
    target.hash = `place=${encodeURIComponent(id)}`;
    this.shareLink.value = target.toString();
    this.copyStatus.textContent = '';
    this.shareArea.hidden = false;
  }

  private async renderBody(markdown: string): Promise<void> {
    const version = ++this.renderVersion;
    this.body.replaceChildren();
    try {
      const html = await renderSafeMarkdown(markdown);
      if (version === this.renderVersion) this.body.innerHTML = html;
    } catch {
      if (version === this.renderVersion) this.body.textContent = markdown;
    }
  }

  private async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.shareLink.value);
      this.copyStatus.textContent = '链接已复制。';
    } catch {
      this.shareLink.focus();
      this.shareLink.select();
      this.copyStatus.textContent = '请手动复制上方链接。';
    }
  }
}
