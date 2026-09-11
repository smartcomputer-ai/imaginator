import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Asset, Column, Row } from '../src/domain.js';
import type { ModelSpec, Provider } from '../src/provider.js';
import { ModelRegistry } from '../src/registry.js';
import { cellHash, createWorkbookResolver, renderPrompts, resolveCell, type CellState, type GridLike } from '../src/resolve.js';
import { parseReference } from '../src/ids.js';

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
const coll: GridLike = { slug: 'c', defaults: {}, rows: [], columns: [] };

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
    expect(cellHash({ ...coll, defaults: { seed: 1 } }, row, column, r.get('test/m'))).not.toBe(base);
    // defaults and row settings resolve to the same content
    expect(cellHash({ ...coll, defaults: { seed: 1 } }, row, column, r.get('test/m'))).toBe(
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
    const bad = resolveCell({ ...coll, defaults: { size: '1024x768' } }, { ...row, settings: { aspectRatio: '1:1' } }, column, ctxFor(r));
    expect(bad.unsupported.join('\n')).toMatch(/disagree/);
    const good = resolveCell({ ...coll, defaults: { size: '1024x768' } }, { ...row, settings: { aspectRatio: '4:3' } }, column, ctxFor(r));
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
    expect(resolved.precedents).toEqual([{ collection: 'c', row: 'r1', column: 'm' }]);

    const blocked = resolveCell(coll, follow, column, { ...ctxFor(r), upstream: () => ({ blocked: 'waiting for r1', pending: true }) });
    expect(blocked.blocked).toBe('waiting for r1');
    expect(blocked.pending).toBe(true);
    expect(blocked.request.inputs).toEqual([]);
    expect(blocked.hash).not.toBe(resolved.hash);
    expect(resolveCell(coll, follow, column, ctxFor(r)).blocked).toBe('waiting for r1/m');
    const missingOutput = resolveCell(coll, { ...follow, inputs: [{ row: 'r1', output: 2, role: 'init' }] }, column, { ...ctxFor(r), upstream: () => ({ outputs: [asset.id] }) });
    expect(missingOutput.blocked).toBe('r1/m has no output #2');
  });

  it('reference anchors: absolute column on a row, same-row column on a column, other collection', () => {
    const r = registry([spec({ id: 'test/m', capabilities: { inputRoles: ['init'], maxInputImages: 1, negativePrompt: false, commonKeys: [], count: 1 } })]);
    const seen: string[] = [];
    const up = (t: { collection: string; row: string; column: string }) => {
      seen.push(`${t.collection}/${t.row}/${t.column}`);
      return { outputs: [asset.id] };
    };
    resolveCell(coll, { ...row, id: 'r2', inputs: [{ row: 'r1', column: 'flux', role: 'init' }] }, column, { ...ctxFor(r), upstream: up });
    resolveCell(coll, { ...row, id: 'r2', inputs: [] }, { ...column, id: 'film', inputs: [{ column: 'flux', role: 'init' }] }, { ...ctxFor(r), upstream: up });
    resolveCell(coll, { ...row, id: 'r2', inputs: [{ collection: 'other', row: 'r9', column: 'x', role: 'init' }] }, column, { ...ctxFor(r), upstream: up });
    expect(seen).toEqual(['c/r1/flux', 'c/r2/flux', 'other/r9/x']);
    expect(parseReference('r3')).toEqual({ row: 'r3' });
    expect(parseReference('flux')).toEqual({ column: 'flux' });
    expect(parseReference('r3/flux')).toEqual({ row: 'r3', column: 'flux' });
    expect(parseReference('moon/r3/flux')).toEqual({ collection: 'moon', row: 'r3', column: 'flux' });
    expect(() => parseReference('flux/r3')).toThrow();
  });

  it('column recipes: templates render, a replacing column ignores row inputs, sparse rows skip', () => {
    const r = registry([spec({ id: 'test/m', capabilities: { inputRoles: ['init'], maxInputImages: 1, negativePrompt: true, commonKeys: [], count: 1 } })]);
    const base: Row = { ...row, prompt: 'a cat', negativePrompt: 'text', inputs: [{ asset: asset.id, role: 'init' }] };
    const plain = resolveCell(coll, base, column, ctxFor(r));
    expect(plain.request.prompt).toBe('a cat');
    expect(plain.request.negativePrompt).toBe('text');
    const stage: Column = { ...column, id: 'film', prompt: 'add film grain', negativePrompt: '', inputs: [{ column: 'm', role: 'init' }] };
    const staged = resolveCell(coll, base, stage, { ...ctxFor(r), upstream: () => ({ outputs: [asset.id] }) });
    expect(staged.request.prompt).toBe('add film grain');
    expect(staged.request.negativePrompt).toBeUndefined();
    expect(staged.precedents).toEqual([{ collection: 'c', row: 'r1', column: 'm' }]);
    // A literal template that renders the same text as the row prompt shares the hash.
    const literal = resolveCell(coll, base, { ...column, prompt: 'a cat' }, ctxFor(r));
    expect(literal.hash).toBe(plain.hash);
    // Row inputs under a replacing column do not affect the hash.
    const edited = resolveCell(coll, { ...base, inputs: [] }, stage, { ...ctxFor(r), upstream: () => ({ outputs: [asset.id] }) });
    expect(edited.hash).toBe(staged.hash);
    expect(renderPrompts({ ...base, negativePrompt: undefined }, { ...column, prompt: '{prompt}, woodcut' })).toEqual({ prompt: 'a cat, woodcut', negativePrompt: undefined });
    expect(resolveCell(coll, { ...base, columns: ['other'] }, column, ctxFor(r)).skipped).toBe(true);
  });

  it('workbook resolver follows references across cells and collections and blocks on cycles', () => {
    const r = registry([spec({ id: 'test/m', capabilities: { inputRoles: ['init'], maxInputImages: 1, negativePrompt: false, commonKeys: [], count: 1 } })]);
    const base: Row = { ...row, id: 'r1' };
    const r2: Row = { ...row, id: 'r2', prompt: 'step 2', inputs: [{ row: 'r1', role: 'init' }], position: 1 };
    const r3: Row = { ...row, id: 'r3', prompt: 'step 3', inputs: [{ row: 'r2', role: 'init' }], position: 2 };
    const grid: GridLike = { slug: 'c', status: 'live', defaults: {}, rows: [base, r2, r3], columns: [column] };
    const other: GridLike = { slug: 'o', status: 'live', defaults: {}, rows: [{ ...row, id: 'r1', prompt: 'style', inputs: [{ collection: 'c', row: 'r3', column: 'm', role: 'init' }] }], columns: [column] };
    const states = new Map<string, CellState>();
    const make = () =>
      createWorkbookResolver({
        ...ctxFor(r),
        grid: (slug) => (slug === 'c' ? grid : slug === 'o' ? other : undefined),
        cell: (t, hash) => states.get(`${t.collection}/${t.row}/${t.column}:${hash}`) ?? {},
      });
    let wb = make();
    const baseHash = wb.resolve({ collection: 'c', row: 'r1', column: 'm' })!.hash;
    expect(wb.resolve({ collection: 'c', row: 'r2', column: 'm' })!.blocked).toBe('waiting for r1/m');
    expect(wb.resolve({ collection: 'c', row: 'r2', column: 'm' })!.pending).toBe(true);
    expect(wb.resolve({ collection: 'c', row: 'r3', column: 'm' })!.blocked).toBe('r2/m: waiting for r1/m');
    expect(wb.resolve({ collection: 'o', row: 'r1', column: 'm' })!.blocked).toBe('c/r3/m: r2/m: waiting for r1/m');
    expect(wb.resolve({ collection: 'c', row: 'r9', column: 'm' })).toBeUndefined();

    states.set(`c/r1/m:${baseHash}`, { outputs: [asset.id], latestStatus: 'succeeded' });
    wb = make();
    const step2 = wb.resolve({ collection: 'c', row: 'r2', column: 'm' })!;
    expect(step2.blocked).toBeUndefined();
    expect(step2.request.inputs[0]?.asset).toBe(asset.id);
    // A failed newer attempt does not hide an older success.
    states.set(`c/r1/m:${baseHash}`, { outputs: [asset.id], latestStatus: 'failed' });
    expect(make().resolve({ collection: 'c', row: 'r2', column: 'm' })!.blocked).toBeUndefined();
    states.set(`c/r2/m:${step2.hash}`, { latestStatus: 'failed' });
    expect(make().resolve({ collection: 'c', row: 'r3', column: 'm' })!.blocked).toBe('r2/m cannot produce an output (failed); see that cell');
    states.set(`c/r2/m:${step2.hash}`, { held: true });
    expect(make().resolve({ collection: 'c', row: 'r3', column: 'm' })!.blocked).toBe('r2/m was cancelled');
    states.delete(`c/r2/m:${step2.hash}`);
    grid.status = 'paused';
    expect(make().resolve({ collection: 'c', row: 'r3', column: 'm' })!.blocked).toBe('r2/m is paused and needs generation');
    grid.status = 'live';

    const loop: GridLike = { ...grid, rows: [{ ...base, inputs: [{ row: 'r2', role: 'init' as const }] }, r2] };
    const cyc = createWorkbookResolver({ ...ctxFor(r), grid: () => loop, cell: () => ({}) });
    expect(cyc.resolve({ collection: 'c', row: 'r1', column: 'm' })!.blocked).toMatch(/cycle/);
    const dangling = createWorkbookResolver({ ...ctxFor(r), grid: () => ({ ...grid, rows: [r2] }), cell: () => ({}) });
    expect(dangling.resolve({ collection: 'c', row: 'r2', column: 'm' })!.blocked).toBe('r1/m not found');
  });
});
