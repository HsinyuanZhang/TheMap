import type { ContentDocument } from './content-format';
import type { MapDatasets } from './dataset-loader';
import type { MapSelection } from './map';
import { DISTRICT_LENS_COLORS } from './map-lenses';
import { METRO_COLORS, PLACE_COLORS, placeKind } from './map-overlays';
import { MAP_LEGEND_ITEMS } from './map-style';
import { renderSafeMarkdown } from './markdown';
import { ModalFocus } from './modal-focus';
import { almanacGroups } from './atlas-ui';

type AlmanacPageId = 'overview' | 'districts' | 'places' | 'transit' | 'legend';

interface AlmanacPage {
  id: AlmanacPageId;
  label: string;
}

const PAGES: readonly AlmanacPage[] = [
  { id: 'overview', label: '城市总览' },
  { id: 'districts', label: '行政区划' },
  { id: 'places', label: '地标与名胜' },
  { id: 'transit', label: '轨道交通' },
  { id: 'legend', label: '图例与说明' },
];

export class AlmanacModal {
  private readonly modal: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly body: HTMLElement;
  private readonly focus: ModalFocus;
  private activePage: AlmanacPageId = 'overview';
  private aboutMarkdown = '';
  private places: ReadonlyMap<string, ContentDocument> = new Map();
  private datasets: MapDatasets | undefined;
  private onSelect: ((selection: MapSelection) => void) | undefined;

  constructor(modal: HTMLElement, nav: HTMLElement, body: HTMLElement) {
    this.modal = modal;
    this.nav = nav;
    this.body = body;
    this.focus = new ModalFocus(modal);

    this.modal.addEventListener('click', (event) => {
      if (event.target === this.modal) this.close();
      const closeBtn = (event.target as HTMLElement | null)?.closest('[data-close-modal]');
      if (closeBtn) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.modal.hidden;
  }

  configure(
    aboutMarkdown: string,
    places: ReadonlyMap<string, ContentDocument>,
    datasets: MapDatasets,
    onSelect: (selection: MapSelection) => void,
  ): void {
    this.aboutMarkdown = aboutMarkdown;
    this.places = places;
    this.datasets = datasets;
    this.onSelect = onSelect;
    this.renderNav();
  }

  open(page: AlmanacPageId = this.activePage): void {
    this.activePage = page;
    this.renderNav();
    void this.renderPage();
    this.focus.open();
  }

  close(): void {
    this.focus.close();
  }

  private renderNav(): void {
    const restoreFocus = this.nav.contains(document.activeElement);
    this.nav.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'almanac-hd';
    heading.textContent = '摩纳哥图志';
    this.nav.append(heading);

    for (const page of PAGES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = page.label;
      button.classList.toggle('active', page.id === this.activePage);
      button.setAttribute('aria-current', page.id === this.activePage ? 'page' : 'false');
      button.addEventListener('click', () => {
        this.activePage = page.id;
        this.renderNav();
        void this.renderPage();
      });
      this.nav.append(button);
    }
    if (restoreFocus) this.nav.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
  }

  private jump(selection: MapSelection): void {
    this.close();
    this.onSelect?.(selection);
  }

  private async renderPage(): Promise<void> {
    this.body.replaceChildren();
    if (this.activePage === 'overview') await this.renderOverview();
    else if (this.activePage === 'districts') this.renderDistricts();
    else if (this.activePage === 'places') this.renderPlaces();
    else if (this.activePage === 'transit') this.renderTransit();
    else this.renderLegend();
  }

  private async renderOverview(): Promise<void> {
    const title = document.createElement('h2');
    title.textContent = '摩纳哥特别行政区';
    this.body.append(title);

    const stats = document.createElement('div');
    stats.className = 'almanac-stats';
    const districtCount = this.datasets?.districts.features.length ?? 9;
    const lineCount = this.datasets?.metro_lines.features.length ?? 3;
    const stationCount = this.datasets?.metro_stations.features.length ?? 0;
    const placeCount = this.places.size;
    for (const [value, label] of [
      [String(districtCount), '行政区'],
      [String(lineCount), '地铁线路'],
      [String(stationCount), '地铁车站'],
      [String(placeCount), '收录词条'],
    ]) {
      const card = document.createElement('div');
      card.className = 'almanac-stat';
      const num = document.createElement('strong');
      num.textContent = value;
      const cap = document.createElement('span');
      cap.textContent = label;
      card.append(num, cap);
      stats.append(card);
    }
    this.body.append(stats);

    const prose = document.createElement('div');
    prose.className = 'almanac-prose';
    prose.innerHTML = await renderSafeMarkdown(this.aboutMarkdown);
    this.body.append(prose);
  }

  private renderDistricts(): void {
    const title = document.createElement('h2');
    title.textContent = '行政区划与周边邻区';
    this.body.append(title);

    const { districts, neighbors } = almanacGroups(this.places, this.datasets);

    const appendGroup = (headingText: string, list: ContentDocument[]): void => {
      const h3 = document.createElement('h3');
      h3.className = 'almanac-group-title';
      h3.textContent = headingText;
      this.body.append(h3);

      const grid = document.createElement('div');
      grid.className = 'almanac-list';
      for (const doc of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'almanac-row';
        const swatch = document.createElement('span');
        swatch.className = 'almanac-swatch';
        swatch.style.background = DISTRICT_LENS_COLORS[doc.metadata.id]?.color ?? '#8b836c';

        const main = document.createElement('span');
        main.className = 'almanac-row-main';
        const name = document.createElement('strong');
        name.textContent = doc.metadata.name;
        const snippet = document.createElement('span');
        snippet.className = 'almanac-row-sub';
        snippet.textContent = doc.body.split('\n')[0] ?? '';
        main.append(name, snippet);

        const arrow = document.createElement('span');
        arrow.className = 'almanac-row-go';
        arrow.textContent = '→';

        row.append(swatch, main, arrow);
        row.addEventListener('click', () => this.jump({ kind: 'place', id: doc.metadata.id }));
        grid.append(row);
      }
      this.body.append(grid);
    };

    appendGroup('摩纳哥九个城区', districts);
    if (neighbors.length) appendGroup('周边邻区', neighbors);
  }

  private renderPlaces(): void {
    const title = document.createElement('h2');
    title.textContent = '地标与名胜索引';
    this.body.append(title);

    const groups = new Map<string, ContentDocument[]>();
    for (const doc of this.places.values()) {
      if (doc.metadata.type === '城区' || doc.metadata.type === '邻区') continue;
      const list = groups.get(doc.metadata.type) ?? [];
      list.push(doc);
      groups.set(doc.metadata.type, list);
    }

    const order = ['地标', '古迹', '公园', '交通', '口岸', '街道'];
    const sortedKeys = [...groups.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh-CN');
    });

    for (const type of sortedKeys) {
      const h3 = document.createElement('h3');
      h3.className = 'almanac-group-title';
      h3.textContent = type;
      this.body.append(h3);

      const list = document.createElement('div');
      list.className = 'almanac-list';
      for (const doc of groups.get(type) ?? []) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'almanac-row';

        const dot = document.createElement('span');
        dot.className = 'almanac-swatch';
        dot.style.background = PLACE_COLORS[placeKind({ id: doc.metadata.id, category: doc.metadata.type })];

        const main = document.createElement('span');
        main.className = 'almanac-row-main';
        const name = document.createElement('strong');
        name.textContent = doc.metadata.name;
        const sub = document.createElement('span');
        sub.className = 'almanac-row-sub';
        sub.textContent = doc.metadata.district;
        main.append(name, sub);

        const arrow = document.createElement('span');
        arrow.className = 'almanac-row-go';
        arrow.textContent = '→';

        row.append(dot, main, arrow);
        row.addEventListener('click', () => this.jump({ kind: 'place', id: doc.metadata.id }));
        list.append(row);
      }
      this.body.append(list);
    }
  }

  private renderTransit(): void {
    const title = document.createElement('h2');
    title.textContent = '摩纳哥轨道交通';
    this.body.append(title);

    if (!this.datasets) return;
    const stationById = new Map(
      this.datasets.metro_stations.features.map((f) => [String(f.properties?.id ?? ''), f.properties]),
    );

    for (const line of this.datasets.metro_lines.features) {
      const lineId = String(line.properties?.id ?? '');
      const color = METRO_COLORS[lineId as keyof typeof METRO_COLORS] ?? String(line.properties?.color ?? '#c9a45c');
      const stops = String(line.properties?.stations ?? '').split(',').filter(Boolean);

      const section = document.createElement('section');
      section.className = 'almanac-line';

      const head = document.createElement('div');
      head.className = 'almanac-line-head';
      const badge = document.createElement('span');
      badge.className = 'metro-pill';
      badge.style.background = color;
      badge.textContent = lineId;
      const count = document.createElement('span');
      count.className = 'almanac-muted';
      count.textContent = `${stops.length} 座车站`;
      head.append(badge, count);
      section.append(head);

      const strip = document.createElement('div');
      strip.className = 'almanac-stops';
      for (const stopId of stops) {
        const props = stationById.get(stopId);
        if (!props) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'almanac-stop-chip';
        if (Number(props.transfer) === 1) btn.classList.add('is-transfer');
        btn.textContent = String(props.name ?? stopId);
        btn.addEventListener('click', () => this.jump({ kind: 'station', id: stopId }));
        strip.append(btn);
      }
      section.append(strip);
      this.body.append(section);
    }
  }

  private renderLegend(): void {
    const title = document.createElement('h2');
    title.textContent = '地图图例与离线说明';
    this.body.append(title);

    const note = document.createElement('p');
    note.className = 'almanac-muted';
    note.textContent = '本图志为纯静态离线应用，所有地形纹理、地标文字、字体字形与地图样式均随站点提供，运行时不请求任何第三方底图或遥测服务。';
    this.body.append(note);

    const grid = document.createElement('ul');
    grid.className = 'almanac-legend-grid';
    for (const item of MAP_LEGEND_ITEMS) {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      if ('symbol' in item) {
        swatch.classList.add('legend-swatch-line');
        if (item.symbol === 'dashed-line') swatch.classList.add('legend-swatch-dashed');
        swatch.style.setProperty('--legend-color', item.swatch);
      } else {
        swatch.style.background = item.swatch;
      }
      const label = document.createElement('span');
      label.textContent = item.label;
      li.append(swatch, label);
      grid.append(li);
    }
    this.body.append(grid);
  }
}
