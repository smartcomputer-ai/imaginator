import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Asset, Column, Row } from '../src/domain.js';
import type { ModelSpec, Provider } from '../src/provider.js';
import { ModelRegistry } from '../src/registry.js';
import { cellHash, createGridResolver, referencedRows, resolveCell } from '../src/resolve.js';

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

  it('a row reference resolves to the upstream output and hashes like that asset input', () => {
    const r = registry([spec({ id: 'test/m', capabilities: { inputRoles: ['init'], maxInputImages: 1, negativePrompt: false, commonKeys: [], count: 1 } })]);
    const follow: Row = { ...row, id: 'r2', prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] };
    const frozen: Row = { ...follow, inputs: [{ asset: asset.id, role: 'init' }] };
    const resolved = resolveCell(coll, follow, column, { ...ctxFor(r), upstream: () => ({ outputs: [asset.id] }) });
    expect(resolved.blocked).toBeUndefined();
    expect(resolved.request.inputs).toEqual([{ asset: asset.id, role: 'init' }]);
    expect(resolved.hash).toBe(resolveCell(coll, frozen, column, ctxFor(r)).hash);
    expect(resolved.unsupported).toEqual([]);

    const blocked = resolveCell(coll, follow, column, { ...ctxFor(r), upstream: () => ({ blocked: 'waiting for r1' }) });
    expect(blocked.blocked).toBe('waiting for r1');
    expect(blocked.request.inputs).toEqual([]);
    expect(blocked.hash).not.toBe(resolved.hash);
    const noLookup = resolveCell(coll, follow, column, ctxFor(r));
    expect(noLookup.blocked).toBe('waiting for r1');
    const missingOutput = resolveCell(coll, { ...follow, inputs: [{ row: 'r1', output: 2, role: 'init' }] }, column, { ...ctxFor(r), upstream: () => ({ outputs: [asset.id] }) });
    expect(missingOutput.blocked).toBe('r1 has no output #2');
    expect(referencedRows(follow.inputs)).toEqual(['r1']);
  });

  it('grid resolver follows references to the current generation and blocks on cycles', () => {
    const r = registry([spec({ id: 'test/m', capabilities: { inputRoles: ['init'], maxInputImages: 1, negativePrompt: false, commonKeys: [], count: 1 } })]);
    const base: Row = { ...row, id: 'r1' };
    const r2: Row = { ...row, id: 'r2', prompt: 'step 2', inputs: [{ row: 'r1', role: 'init' }], position: 1 };
    const r3: Row = { ...row, id: 'r3', prompt: 'step 3', inputs: [{ row: 'r2', role: 'init' }], position: 2 };
    const grid = { defaults: {}, rows: [base, r2, r3], columns: [column] };
    const baseHash = resolveCell(coll, base, column, ctxFor(r)).hash;
    const gens: Record<string, { status: 'succeeded' | 'failed' | 'queued'; outputs: string[] }> = {};
    const resolve = createGridResolver(grid, { ...ctxFor(r), generation: (rowId, _c, hash) => (gens[`${rowId}:${hash}`]) });
    expect(resolve('r1', 'm').hash).toBe(baseHash);
    expect(resolve('r2', 'm').blocked).toBe('waiting for r1');
    expect(resolve('r3', 'm').blocked).toBe('r2: waiting for r1');

    gens[`r1:${baseHash}`] = { status: 'succeeded', outputs: [asset.id] };
    const resolve2 = createGridResolver(grid, { ...ctxFor(r), generation: (rowId, _c, hash) => gens[`${rowId}:${hash}`] });
    const step2 = resolve2('r2', 'm');
    expect(step2.blocked).toBeUndefined();
    expect(step2.request.inputs[0]?.asset).toBe(asset.id);
    expect(resolve2('r3', 'm').blocked).toBe('waiting for r2');
    gens[`r2:${step2.hash}`] = { status: 'failed', outputs: [] };
    expect(createGridResolver(grid, { ...ctxFor(r), generation: (rowId, _c, hash) => gens[`${rowId}:${hash}`] })('r3', 'm').blocked).toBe('r2 failed');

    const loop = { ...grid, rows: [{ ...base, inputs: [{ row: 'r2', role: 'init' as const }] }, r2] };
    const cyc = createGridResolver(loop, { ...ctxFor(r), generation: () => undefined });
    expect(cyc('r1', 'm').blocked).toMatch(/references itself|r2: /);
    const dangling = createGridResolver({ ...grid, rows: [r2] }, { ...ctxFor(r), generation: () => undefined });
    expect(dangling('r2', 'm').blocked).toBe('row r1 not found');
  });
});
