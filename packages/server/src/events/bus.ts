import { formatCursor, parseCursor, randomId, type Cursor, type ImaginatorEvent } from '@imaginator/core';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the bus assigns its cursor. */
export type EventInput = DistributiveOmit<ImaginatorEvent, 'cursor'>;

export type Listener = (event: ImaginatorEvent) => void;

/**
 * In-process typed event bus with per-collection cursors. Cursors are memory
 * only: a cursor from another boot is stale and any wait on it returns at once.
 */
export class EventBus {
  readonly bootId: string;
  private readonly seqs = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly queue: ImaginatorEvent[] = [];
  private dispatching = false;

  constructor(bootId = randomId(8)) {
    this.bootId = bootId;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Current cursor of a collection. */
  cursor(collection: string): Cursor {
    return formatCursor(this.bootId, this.seqs.get(collection) ?? 0);
  }

  seq(collection: string): number {
    return this.seqs.get(collection) ?? 0;
  }

  /** Advance the collection cursor and wake waiters without emitting an event. */
  touch(collection: string): Cursor {
    const seq = (this.seqs.get(collection) ?? 0) + 1;
    this.seqs.set(collection, seq);
    this.wake(collection);
    return formatCursor(this.bootId, seq);
  }

  /**
   * Emit an event; `cursor` is assigned here (events without a collection get
   * none). Delivery is queued so that an event emitted from inside a listener
   * is delivered after the one being dispatched: listeners always see events
   * in cursor order.
   */
  emit(event: EventInput): ImaginatorEvent {
    let full: ImaginatorEvent;
    const collection = (event as { collection?: string }).collection;
    if (collection !== undefined) {
      const seq = (this.seqs.get(collection) ?? 0) + 1;
      this.seqs.set(collection, seq);
      full = { ...event, cursor: formatCursor(this.bootId, seq) } as ImaginatorEvent;
    } else {
      full = { ...event } as ImaginatorEvent;
    }
    this.queue.push(full);
    if (!this.dispatching) this.drain();
    return full;
  }

  private drain(): void {
    this.dispatching = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        for (const l of [...this.listeners]) {
          try {
            l(next);
          } catch (e) {
            console.error('event listener failed', e);
          }
        }
        const collection = (next as { collection?: string }).collection;
        if (collection !== undefined) this.wake(collection);
      }
    } finally {
      this.dispatching = false;
    }
  }

  /** True when `cursor` is from another boot or older than the collection's current cursor. */
  isPast(collection: string, cursor: Cursor): boolean {
    const parsed = parseCursor(cursor);
    if (!parsed || parsed.bootId !== this.bootId) return true;
    return this.seq(collection) > parsed.seq;
  }

  /** Resolve when the collection's cursor moves past `cursor`, or after `timeoutMs`. */
  waitForCursor(collection: string, cursor: Cursor, timeoutMs: number): Promise<boolean> {
    if (this.isPast(collection, cursor)) return Promise.resolve(true);
    return this.waitForChange(collection, timeoutMs);
  }

  /** Resolve true on the next change to the collection, false on timeout. */
  waitForChange(collection: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let set = this.waiters.get(collection);
      if (!set) this.waiters.set(collection, (set = new Set()));
      const done = (changed: boolean) => {
        clearTimeout(timer);
        set!.delete(wake);
        resolve(changed);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      set.add(wake);
    });
  }

  private wake(collection: string): void {
    const set = this.waiters.get(collection);
    if (!set) return;
    for (const w of [...set]) w();
  }
}
