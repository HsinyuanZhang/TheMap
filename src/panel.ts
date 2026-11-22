import type { ContentDocument } from './content-format';
import { renderSafeMarkdown } from './markdown';
import { getStationInfo } from './station-info';
import type { MapDatasets } from './map';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

export class PlacePanel {
  private readonly root = element<HTMLElement>('place-panel');
  private readonly kicker = element<HTMLParagraphElement>('panel-kicker');
  private readonly title = element<HTMLHeadingElement>('panel-title');
  private readonly meta = element<HTMLDivElement>('panel-meta');
  private readonly stationMeta = element<HTMLDivElement>('station-meta');
  private readonly body = element<HTMLDivElement>('panel-body');
  private readonly shareArea = element<HTMLDivElement>('share-area');
  private readonly shareLink = element<HTMLInputElement>('share-link');
  private readonly copyStatus = element<HTMLParagraphElement>('copy-status');
  private renderVersion = 0;
  private closeHandler: (() => void) | undefined;

  constructor() {
    element<HTMLButtonElement>('close-panel').addEventListener('click', () => this.closeHandler?.());
    element<HTMLButtonElement>('copy-link').addEventListener('click', () => void this.copyLink());
  }

  get isOpen(): boolean {
    return this.root.classList.contains('is-open');
  }

  setOnClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  showAbout(markdown: string): void {
    this.kicker.textContent = '城市简介';
    this.title.textContent = '摩纳哥';
    this.meta.hidden = true;
    this.meta.replaceChildren();
    this.stationMeta.hidden = true;
    this.stationMeta.replaceChildren();
    this.shareArea.hidden = true;
    this.copyStatus.textContent = '';
    void this.renderBody(markdown);
    this.setOpen(true);
  }

  showPlace(document: ContentDocument): void {
    this.kicker.textContent = '地点介绍';
    this.title.textContent = document.metadata.name;
    this.setMeta(document.metadata.type, document.metadata.district);
    this.stationMeta.hidden = true;
    this.stationMeta.replaceChildren();
    this.setShareLink(document.metadata.id);
    void this.renderBody(document.body);
    this.setOpen(true);
  }

  showStation(id: string, datasets: MapDatasets): string | undefined {
    const station = getStationInfo(id, datasets);
    if (!station) return undefined;
    this.renderVersion += 1;
    this.kicker.textContent = '地铁站';
    this.title.textContent = station.name;
    this.setMeta('地铁站', station.district);
    this.stationMeta.replaceChildren();
    for (const line of station.lines) {
      const detail = document.createElement('p');
      detail.textContent = `${line.id}：前一站 ${line.previous ?? '无'}；后一站 ${line.next ?? '无'}`;
      this.stationMeta.append(detail);
    }
    this.stationMeta.hidden = false;
    this.body.replaceChildren();
    this.setShareLink(id);
    this.setOpen(true);
    return station.name;
  }

  hide(): void {
    this.root.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.inert = true;
    this.renderVersion += 1;
  }

  private setOpen(open: boolean): void {
    this.root.classList.toggle('is-open', open);
    this.root.setAttribute('aria-hidden', String(!open));
    this.root.inert = !open;
  }

  private setMeta(type: string, district: string): void {
    this.meta.replaceChildren();
    for (const value of [type, district]) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.textContent = value;
      this.meta.append(chip);
    }
    this.meta.hidden = false;
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
