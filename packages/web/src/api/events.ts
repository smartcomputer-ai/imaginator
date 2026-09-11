import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ImaginatorEvent } from '@imaginator/core';
import { invalidateAssets, invalidateCollection, keys } from './queries';

const EVENT_TYPES: ImaginatorEvent['type'][] = [
  'collection.created',
  'collection.updated',
  'collection.deleted',
  'collection.invalidated',
  'collection.reconciled',
  'cell.updated',
  'row.updated',
  'row.deleted',
  'column.updated',
  'column.deleted',
  'generation.updated',
  'asset.created',
];

// ---------------------------------------------------------------------------
// Connection state store (drives the global connected/disconnected dot)
// ---------------------------------------------------------------------------

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

const sources = new Map<EventSource, ConnectionState>();
const listeners = new Set<() => void>();
let snapshot: ConnectionState = 'idle';

function recompute(): void {
  let next: ConnectionState = 'idle';
  const states = [...sources.values()];
  if (states.length) {
    if (states.includes('connected')) next = 'connected';
    else if (states.includes('connecting')) next = 'connecting';
    else next = 'disconnected';
  }
  if (next !== snapshot) {
    snapshot = next;
    listeners.forEach((l) => l());
  }
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => 'idle' as const,
  );
}

// ---------------------------------------------------------------------------
// Debounced invalidation
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 100;

function makeInvalidator(qc: QueryClient) {
  const pending = new Set<string>();
  let assetsPending = false;
  let listPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    for (const slug of pending) invalidateCollection(qc, slug);
    pending.clear();
    if (listPending) void qc.invalidateQueries({ queryKey: keys.collections });
    if (assetsPending) invalidateAssets(qc);
    listPending = false;
    assetsPending = false;
  };
  const schedule = () => {
    if (timer === undefined) timer = setTimeout(flush, DEBOUNCE_MS);
  };

  return {
    handle(ev: ImaginatorEvent) {
      if (ev.type === 'asset.created') assetsPending = true;
      else if ('collection' in ev && ev.collection) {
        pending.add(ev.collection);
        if (ev.type === 'collection.deleted') qc.removeQueries({ queryKey: keys.collection(ev.collection) });
      } else listPending = true;
      schedule();
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to `GET /api/events[?collection=<slug>]` for the lifetime of the
 * component and invalidate the matching queries on every event. The browser's
 * EventSource reconnects on its own; after a reconnect we refetch everything
 * active, since a refetch is the recovery (DESIGN §5).
 */
export function useEvents(collection?: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    const url = collection ? `/api/events?collection=${encodeURIComponent(collection)}` : '/api/events';
    const es = new EventSource(url);
    const inv = makeInvalidator(qc);
    let hadError = false;

    sources.set(es, 'connecting');
    recompute();

    es.onopen = () => {
      sources.set(es, 'connected');
      recompute();
      if (hadError) {
        hadError = false;
        void qc.invalidateQueries();
      }
    };
    es.onerror = () => {
      hadError = true;
      sources.set(es, es.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting');
      recompute();
    };
    const onEvent = (e: MessageEvent<string>) => {
      let ev: ImaginatorEvent | undefined;
      try {
        ev = JSON.parse(e.data) as ImaginatorEvent;
      } catch {
        return;
      }
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') inv.handle(ev);
    };
    for (const type of EVENT_TYPES) es.addEventListener(type, onEvent as EventListener);
    // Fallback for servers that send unnamed `message` events.
    es.addEventListener('message', onEvent as EventListener);

    return () => {
      inv.dispose();
      es.close();
      sources.delete(es);
      recompute();
    };
  }, [qc, collection]);
}
