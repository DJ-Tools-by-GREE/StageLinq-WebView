export interface SaveState {
  phase: 'idle' | 'pending' | 'saving' | 'error';
  error?: string;
}

export const SETTINGS_DEBOUNCE_MS = 250;

export class SettingsWriter<T, R = T> {
  private pending: { value: T; revision: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private disposed = false;
  private failure: string | undefined;
  private version = 0;

  constructor(
    private send: (value: T) => Promise<R>,
    private saved: (value: R) => void,
    private changed: (state: SaveState) => void,
    private merge: (previous: T, next: T) => T = (_previous, next) => next,
  ) {}

  get revision() { return this.version; }
  get hasUnsaved() { return this.pending !== null || this.active !== null; }

  schedule(value: T, immediate = false): void {
    this.pending = {
      value: this.pending ? this.merge(this.pending.value, value) : value,
      revision: ++this.version,
    };
    this.failure = undefined;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (immediate) void this.flush();
    else this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, SETTINGS_DEBOUNCE_MS);
    this.notify();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) return this.active;
    const item = this.pending;
    if (!item) return;
    this.pending = null;
    this.failure = undefined;
    this.active = Promise.resolve().then(() => this.send(item.value)).then(value => {
      if (!this.disposed && item.revision === this.version) this.saved(value);
    }).catch((error: unknown) => {
      if (this.pending) {
        this.pending.value = this.merge(item.value, this.pending.value);
      } else {
        this.pending = item;
        this.failure = error instanceof Error ? error.message : String(error);
      }
    }).finally(() => {
      this.active = null;
      this.notify();
      if (this.pending && !this.failure && this.timer === null) void this.flush();
    });
    this.notify();
    return this.active;
  }

  retry(): void { this.failure = undefined; void this.flush(); }

  dispose(): void {
    this.disposed = true;
    if (!this.failure) void this.flush();
    else if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private notify(): void {
    if (this.disposed) return;
    this.changed(this.failure ? { phase: 'error', error: this.failure }
      : this.active ? { phase: 'saving' }
      : this.pending ? { phase: 'pending' } : { phase: 'idle' });
  }
}
