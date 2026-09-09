import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Asset, Column, Row } from '../src/domain.js';
import type { ModelSpec, Provider } from '../src/provider.js';
import { ModelRegistry } from '../src/registry.js';
import { cellHash, resolveCell } from '../src/resolve.js';

function spec(overrides: Partial<ModelSpec> & { id: string }): ModelSpec {
  return {
    name: overrides.id,
    kind: 'image',
    capabilities: {
      inputRoles: ['reference'],
      maxInputImages: 2,
      negativePrompt: false,
      commonKeys: ['aspectRatio', 'seed'],
      count: 4,
      aspectRatios: ['1:1', '16:9'],
    },
    validateRequest: () => [],
    settings: z.object({ steps: z.number().int().default(20) }),
    ...overrides,
  };
}

function registry(specs: ModelSpec[], version = 'v1'): ModelRegistry {
  const provider: Provider = { id: 'test', models: specs, generate: async () => ({ outputs: [] }) };
  return new ModelRegistry([provider], version);
}

const asset: Asset = {
  id: 'k3q2m7', kind: 'image', origin: { type: 'upload' }, mime: 'image/png', width: 10, height: 10, bytes: 1, sha256: 'x', createdAt: 'now',
};
const ctxFor = (r: ModelRegistry) => ({ registry: r, asset: (id: string) => (id === asset.id ? asset : undefined) });

const row: Row = { id: 'r1', prompt: 'a cat', inputs: [], paused: false, position: 0 };
const column: Column = { id: 'm', model: 'test/m', count: 1, position: 0 };
const coll = { defaults: {} };

describe('resolve', () => {
  it('hash is stable across registry defaults and version', () => {
    const r1 = registry([spec({ id: 'test/m', settings: z.object({ steps: z.number().default(20) }) })], 'v1');
    const r2 = registry([spec({ id: 'test/m', settings: z.object({ steps: z.number().default(50) }) })], 'v2');
    const a = resolveCell(coll, row, column, ctxFor(r1));
    const b = resolveCell(coll, row, column, ctxFor(r2));
    expect(a.hash).toBe(b.hash);
    expect(a.request.settings).toEqual({ steps: 20 });
    expect(b.request.settings).toEqual({ steps: 50 });
    expect(a.request.registryVersion).toBe('v1');
    expect(a.unsupported).toEqual([]);
  });

  it('hash changes with prompt, inputs, column settings, count, and honored common keys', () => {
    const r = registry([spec({ id: 'test/m' })]);
    const base = cellHash(coll, row, column, r.get('test/m'));
    expect(cellHash(coll, { ...row, prompt: 'a dog' }, column, r.get('test/m'))).not.toBe(base);
    expect(cellHash(coll, row, { ...column, count: 2 }, r.get('test/m'))).not.toBe(base);
    expect(cellHash(coll, row, { ...column, settings: { steps: 5 } }, r.get('test/m'))).not.toBe(base);
    expect(cellHash(coll, { ...row, settings: { seed: 1 } }, column, r.get('test/m'))).not.toBe(base);
    expect(cellHash({ defaults: { seed: 1 } }, row, column, r.get('test/m'))).not.toBe(base);
    // defaults and row settings resolve to the same content
    expect(cellHash({ defaults: { seed: 1 } }, row, column, r.get('test/m'))).toBe(
      cellHash(coll, { ...row, settings: { seed: 1 } }, column, r.get('test/m')),
    );
  });

  it('unhonored common keys do not affect the hash and are recorded as dropped', () => {
    const r = registry([spec({ id: 'test/m' })]);
    const base = resolveCell(coll, row, column, ctxFor(r));
    const withFormat = resolveCell(coll, { ...row, settings: { outputFormat: 'webp' } }, column, ctxFor(r));
    expect(withFormat.hash).toBe(base.hash);
    expect(withFormat.request.droppedKeys).toEqual(['outputFormat']);
    expect(withFormat.request.common).toEqual({});
  });

  it('flags unsupported combinations without dropping anything', () => {
    const r = registry([spec({ id: 'test/m' })]);
    const res = resolveCell(
      coll,
      { ...row, negativePrompt: 'ugly', inputs: [{ asset: asset.id, role: 'init' }], settings: { aspectRatio: '4:3' } },
      { ...column, count: 9 },
      ctxFor(r),
    );
    expect(res.unsupported.join('\n')).toMatch(/negative prompt/);
    expect(res.unsupported.join('\n')).toMatch(/init/);
    expect(res.unsupported.join('\n')).toMatch(/aspectRatio 4:3/);
    expect(res.unsupported.join('\n')).toMatch(/count 9/);
    expect(res.request.inputs).toHaveLength(1);
  });

  it('size and aspect ratio must agree; missing assets and bad settings are unsupported', () => {
    const r = registry([spec({ id: 'test/m', capabilities: { inputRoles: ['reference'], maxInputImages: 1, negativePrompt: false, commonKeys: ['size', 'aspectRatio'], count: 1 } })]);
    const bad = resolveCell({ defaults: { size: '1024x768' } }, { ...row, settings: { aspectRatio: '1:1' } }, column, ctxFor(r));
    expect(bad.unsupported.join('\n')).toMatch(/disagree/);
    const good = resolveCell({ defaults: { size: '1024x768' } }, { ...row, settings: { aspectRatio: '4:3' } }, column, ctxFor(r));
    expect(good.unsupported).toEqual([]);
    const missing = resolveCell(coll, { ...row, inputs: [{ asset: 'zzzzzz', role: 'reference' }] }, column, ctxFor(r));
    expect(missing.unsupported.join('\n')).toMatch(/not found/);
    const badSettings = resolveCell(coll, row, { ...column, settings: { steps: 'many' } }, ctxFor(r));
    expect(badSettings.unsupported.join('\n')).toMatch(/settings\.steps/);
    const unknownKey = resolveCell(coll, row, { ...column, settings: { nope: 1 } }, ctxFor(r));
    expect(unknownKey.unsupported.join('\n')).toMatch(/nope/);
    const unknownModel = resolveCell(coll, row, { ...column, model: 'test/none' }, ctxFor(r));
    expect(unknownModel.unsupported).toEqual(['unknown model test/none']);
    expect(unknownModel.hash).toBeTruthy();
  });

  it('runs the model validator only when capability checks pass', () => {
    const r = registry([spec({ id: 'test/m', validateRequest: (_req, inputs) => (inputs.some((a) => a.width < 64) ? ['input too small'] : []) })]);
    const res = resolveCell(coll, { ...row, inputs: [{ asset: asset.id, role: 'reference' }] }, column, ctxFor(r));
    expect(res.unsupported).toEqual(['input too small']);
  });
});
