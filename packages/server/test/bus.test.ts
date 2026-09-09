import { describe, expect, it } from 'vitest';
import { formatCursor, parseCursor } from '@imaginator/core';
import { EventBus } from '../src/events/bus.js';

describe('event bus', () => {
  it('assigns per-collection cursors and delivers nested emits in cursor order', () => {
    const bus = new EventBus('boot');
    const seen: string[] = [];
    bus.on((e) => {
      if (e.type === 'row.updated' && e.collection === 'c' && e.row === 'r1') {
        // A listener reacting by emitting more (the runner claiming queued work).
        bus.emit({ type: 'generation.updated', id: 'g1', collection: 'c', row: 'r1', column: 'x', status: 'submitting' });
      }
    });
    bus.on((e) => seen.push('cursor' in e && e.cursor ? e.cursor : e.type));
    bus.emit({ type: 'row.updated', collection: 'c', row: 'r1' });
    bus.emit({ type: 'row.updated', collection: 'c', row: 'r2' });
    bus.emit({ type: 'row.updated', collection: 'other', row: 'r1' });
    bus.emit({ type: 'asset.created', id: 'a' });
    // c.1 (row r1), c.2 (nested generation, delivered after the event that caused it), c.3 (row r2), other.1, asset
    expect(seen).toEqual(['boot.1', 'boot.2', 'boot.3', 'boot.1', 'asset.created']);
    expect(bus.cursor('c')).toBe('boot.3');
    expect(bus.cursor('other')).toBe('boot.1');
    expect(bus.cursor('unknown')).toBe('boot.0');
  });

  it('waitForCursor: past, stale, timeout, wake', async () => {
    const bus = new EventBus('boot');
    expect(await bus.waitForCursor('c', formatCursor('boot', 0), 10)).toBe(false);
    bus.emit({ type: 'collection.updated', collection: 'c' });
    expect(await bus.waitForCursor('c', formatCursor('boot', 0), 10)).toBe(true);
    expect(await bus.waitForCursor('c', formatCursor('boot', 1), 10)).toBe(false);
    expect(await bus.waitForCursor('c', formatCursor('elsewhere', 99), 10)).toBe(true);
    expect(await bus.waitForCursor('c', 'garbage', 10)).toBe(true);
    const pending = bus.waitForCursor('c', formatCursor('boot', 1), 5000);
    bus.touch('c');
    expect(await pending).toBe(true);
    expect(parseCursor(bus.cursor('c'))).toEqual({ bootId: 'boot', seq: 2 });
  });
});
