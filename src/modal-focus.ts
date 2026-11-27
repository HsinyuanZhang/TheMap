export class ModalFocus {
  private previousFocus: HTMLElement | null = null;

  constructor(private readonly modal: HTMLElement) {}

  private focusable(): HTMLElement[] {
    return [...this.modal.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
      .filter((element) => !element.matches(':disabled, [tabindex="-1"]') && element.getClientRects().length > 0);
  }

  private readonly onFocus = (event: FocusEvent): void => {
    if (!this.modal.contains(event.target as Node)) this.focusFirst();
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const items = this.focusable();
    const index = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    if (items.length) items[index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length]!.focus();
    else this.modal.focus();
  };

  private focusFirst(): void {
    (this.focusable()[0] ?? this.modal).focus();
  }

  open(): void {
    if (!this.modal.hidden) return;
    this.previousFocus = document.activeElement as HTMLElement | null;
    this.modal.hidden = false;
    this.modal.tabIndex = -1;
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('focusin', this.onFocus);
    this.focusFirst();
  }

  close(): void {
    if (this.modal.hidden) return;
    this.modal.hidden = true;
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('focusin', this.onFocus);
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
  }
}
