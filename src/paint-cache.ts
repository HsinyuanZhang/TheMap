export class ByteLRU {
  private readonly entries = new Map<string, ArrayBuffer>();
  bytes = 0;
  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 0) throw new Error('Invalid cache limit.');
  }
  get(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: ArrayBuffer): void {
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.byteLength; this.entries.delete(key); }
    if (value.byteLength > this.limit) return;
    this.entries.set(key, value); this.bytes += value.byteLength;
    while (this.bytes > this.limit) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.byteLength; this.entries.delete(oldest);
    }
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
