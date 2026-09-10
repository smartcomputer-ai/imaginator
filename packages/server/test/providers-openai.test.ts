import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry, ProviderError, resolveCell, type Asset, type Column, type GenerateContext, type ResolvedRequest, type Row } from '@imaginator/core';
import { createOpenAIProvider, OPENAI_MODELS, buildParams, describePricing, estimateCost, orderInputs, sizeForRatio, validateCustomSize } from '../src/providers/openai.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7]);

const assets: Record<string, Asset> = {
  a1: { id: 'a1', kind: 'image', origin: { type: 'upload' }, mime: 'image/png', width: 1024, height: 1024, bytes: PNG.length, sha256: 'x', createdAt: 'now' },
  a2: { id: 'a2', kind: 'image', origin: { type: 'upload' }, mime: 'image/jpeg', width: 640, height: 480, bytes: JPG.length, sha256: 'y', createdAt: 'now' },
  m1: { id: 'm1', kind: 'image', origin: { type: 'upload' }, mime: 'image/png', width: 1024, height: 1024, bytes: PNG.length, sha256: 'z', createdAt: 'now' },
  m2: { id: 'm2', kind: 'image', origin: { type: 'upload' }, mime: 'image/png', width: 100, height: 100, bytes: PNG.length, sha256: 'w', createdAt: 'now' },
};
const bytesOf: Record<string, Uint8Array> = { a1: PNG, a2: JPG, m1: PNG, m2: PNG };

function ctx(): GenerateContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    signal: new AbortController().signal,
    asset: async (id) => ({ bytes: bytesOf[id]!, mime: assets[id]!.mime, path: `/x/${id}` }),
    setProviderRef: async () => {},
    sleep: async () => {},
    log: (m) => logs.push(m),
    logs,
  };
}

function req(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    model: 'openai/gpt-image-2.5-sunburst',
    prompt: 'a lighthouse at dusk',
    inputs: [],
    count: 1,
    common: {},
    settings: { quality: 'auto', background: 'auto', moderation: 'auto' },
    droppedKeys: [],
    registryVersion: 'test',
    ...overrides,
  };
}

const provider = createOpenAIProvider({ apiKey: 'sk-test', baseUrl: 'https://example.test/v1/', timeoutMs: 5000 });
const registry = new ModelRegistry([provider], 'test');
const sunburst = 'openai/gpt-image-2.5-sunburst';
const mini = 'openai/gpt-image-1-mini';

function resolve(row: Partial<Row>, column: Partial<Column> = {}, defaults = {}) {
  const r: Row = { id: 'r1', prompt: 'a cat', inputs: [], paused: false, position: 0, ...row };
  const c: Column = { id: 'c1', model: sunburst, count: 1, position: 0, ...column };
  return resolveCell({ defaults }, r, c, { registry, asset: (id) => assets[id] });
}

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  });
  return calls;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function apiError(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
}

const b64 = Buffer.from(PNG).toString('base64');
const usage = { input_tokens: 20, output_tokens: 1000, total_tokens: 1020, input_tokens_details: { text_tokens: 12, image_tokens: 8 } };

afterEach(() => vi.unstubAllGlobals());

describe('openai provider: registry', () => {
  it('registers every model under the openai/ prefix with settings defaults', () => {
    const ids = provider.models.map((m) => m.id);
    expect(ids).toEqual(OPENAI_MODELS.map((d) => `openai/${d.slug}`));
    expect(ids).toContain(sunburst);
    expect(registry.defaultsFor(sunburst)).toEqual({ quality: 'auto', background: 'auto', moderation: 'auto' });
    expect(registry.get(mini)!.capabilities.sizes).toEqual(['1024x1024', '1536x1024', '1024x1536']);
    expect(registry.get(sunburst)!.capabilities.sizes).toBeUndefined();
  });

  it('validates column settings through resolve', () => {
    expect(resolve({}, { settings: { quality: 'max' } }).unsupported).toEqual([]);
    expect(resolve({}, { model: mini, settings: { quality: 'max' } }).unsupported[0]).toMatch(/settings\.quality/);
    expect(resolve({}, { settings: { steps: 5 } }).unsupported[0]).toMatch(/settings/);
  });
});

describe('openai provider: sizes', () => {
  it('maps aspect ratios to preset or custom sizes', () => {
    expect(sizeForRatio('1:1')).toBe('1024x1024');
    expect(sizeForRatio('3:2')).toBe('1536x1024');
    expect(sizeForRatio('2:3')).toBe('1024x1536');
    expect(sizeForRatio('16:9')).toBe('1360x768');
    expect(sizeForRatio('1:3')).toBe('592x1776');
    expect(sizeForRatio('4:1')).toBeUndefined();
  });

  it('rejects custom sizes the API would reject', () => {
    expect(validateCustomSize('1024x1024')).toBeUndefined();
    expect(validateCustomSize('3840x2160')).toBeUndefined();
    expect(validateCustomSize('1000x1000')).toMatch(/multiples of 16/);
    expect(validateCustomSize('512x512')).toMatch(/total pixels/);
    expect(validateCustomSize('4096x1024')).toMatch(/exceed/);
    expect(validateCustomSize('3200x800')).toMatch(/aspect ratio/);
  });

  it('applies size rules per model at resolve time', () => {
    expect(resolve({ settings: { size: '1360x768' } }).unsupported).toEqual([]);
    expect(resolve({ settings: { size: '1000x1000' } }).unsupported[0]).toMatch(/multiples of 16/);
    expect(resolve({ settings: { aspectRatio: '16:9' } }).unsupported).toEqual([]);
    expect(resolve({ settings: { aspectRatio: '5:1' } }).unsupported[0]).toMatch(/cannot be honored/);
    expect(resolve({ settings: { size: '1360x768' } }, { model: mini }).unsupported[0]).toMatch(/size 1360x768 not supported/);
    expect(resolve({ settings: { aspectRatio: '16:9' } }, { model: mini }).unsupported[0]).toMatch(/aspectRatio 16:9 not supported/);
    expect(resolve({ settings: { aspectRatio: '3:2' } }, { model: mini }).unsupported).toEqual([]);
  });

  it('builds request params from common and model settings', () => {
    const def = OPENAI_MODELS[0]!;
    expect(buildParams(req(), def)).toEqual({ model: 'gpt-image-2.5-sunburst', prompt: 'a lighthouse at dusk', n: 1, size: 'auto', quality: 'auto' });
    const full = buildParams(
      req({
        count: 3,
        common: { aspectRatio: '16:9', outputFormat: 'webp' },
        settings: { quality: 'high', background: 'transparent', moderation: 'low', outputCompression: 70, inputFidelity: 'high' },
      }),
      def,
    );
    expect(full).toEqual({
      model: 'gpt-image-2.5-sunburst', prompt: 'a lighthouse at dusk', n: 3, size: '1360x768', quality: 'high',
      background: 'transparent', output_format: 'webp', output_compression: 70, moderation: 'low',
    });
    // Compression is only meaningful for jpeg/webp; fidelity only when editing.
    const png = buildParams(req({ common: { outputFormat: 'png' }, settings: { outputCompression: 70 } }), def);
    expect(png.output_compression).toBeUndefined();
    const edit = buildParams(req({ inputs: [{ asset: 'a1', role: 'reference' }], settings: { inputFidelity: 'high' } }), def);
    expect(edit.input_fidelity).toBe('high');
  });
});

describe('openai provider: input validation', () => {
  it('accepts references, init and mask; rejects mismatched masks and bad mimes', () => {
    expect(resolve({ inputs: [{ asset: 'a1', role: 'reference' }, { asset: 'a2', role: 'reference' }] }).unsupported).toEqual([]);
    expect(resolve({ inputs: [{ asset: 'a1', role: 'init' }, { asset: 'm1', role: 'mask', maskFor: 0 }] }).unsupported).toEqual([]);
    expect(resolve({ inputs: [{ asset: 'a1', role: 'init' }, { asset: 'm2', role: 'mask', maskFor: 0 }] }).unsupported[0]).toMatch(/must match its init image/);
    expect(resolve({ inputs: [{ asset: 'a2', role: 'init' }, { asset: 'a2', role: 'mask', maskFor: 0 }] }).unsupported[0]).toMatch(/must be a png/);
    expect(resolve({ inputs: Array.from({ length: 17 }, () => ({ asset: 'a1', role: 'reference' as const })) }).unsupported[0]).toMatch(/exceed the maximum of 16/);
    expect(resolve({ prompt: '   ' }).unsupported).toEqual(['prompt is empty']);
  });

  it('rejects transparent background with jpeg output', () => {
    const r = resolve({ settings: { outputFormat: 'jpeg' } }, { settings: { background: 'transparent' } });
    expect(r.unsupported).toEqual(['transparent background requires png or webp output']);
  });

  it('orders the masked init image first', () => {
    const r = req({
      inputs: [{ asset: 'a2', role: 'reference' }, { asset: 'a1', role: 'init' }, { asset: 'm1', role: 'mask', maskFor: 1 }],
    });
    const { images, mask } = orderInputs(r);
    expect(images.map((i) => i.asset)).toEqual(['a1', 'a2']);
    expect(mask?.asset).toBe('m1');
  });
});

describe('openai provider: generate', () => {
  it('posts JSON to /images/generations for text-only requests and decodes base64 outputs', async () => {
    const calls = stubFetch(() => ok({ created: 1, data: [{ b64_json: b64 }, { b64_json: b64 }], output_format: 'webp', size: '1024x1024', quality: 'high', background: 'opaque', usage }));
    const c = ctx();
    const result = await provider.generate(req({ count: 2, common: { outputFormat: 'webp' }, settings: { quality: 'high' } }), c);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.test/v1/images/generations');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ model: 'gpt-image-2.5-sunburst', prompt: 'a lighthouse at dusk', n: 2, size: 'auto', quality: 'high', output_format: 'webp' });

    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0]).toEqual({ bytes: PNG, mime: 'image/webp' });
    // 12 text-in * $5 + 8 image-in * $8 + 1000 out * $30, per million tokens.
    expect(result.cost).toBeCloseTo((12 * 5 + 8 * 8 + 1000 * 30) / 1e6, 9);
    expect(result.providerMeta).toMatchObject({ model: 'gpt-image-2.5-sunburst', endpoint: 'generations', size: '1024x1024', quality: 'high', outputFormat: 'webp', usage });
    expect(c.logs[0]).toMatch(/openai: generations/);
  });

  it('posts multipart to /images/edits with image[] in order plus mask', async () => {
    const calls = stubFetch(() => ok({ data: [{ b64_json: b64 }], output_format: 'png' }));
    const r = req({
      inputs: [{ asset: 'a2', role: 'reference' }, { asset: 'a1', role: 'init' }, { asset: 'm1', role: 'mask', maskFor: 1 }],
      settings: { quality: 'auto', background: 'auto', moderation: 'auto', inputFidelity: 'high' },
    });
    const result = await provider.generate(r, ctx());

    expect(calls[0]!.url).toBe('https://example.test/v1/images/edits');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined(); // fetch sets the multipart boundary
    const form = calls[0]!.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(form.get('n')).toBe('1');
    expect(form.get('input_fidelity')).toBe('high');
    const images = form.getAll('image[]') as File[];
    expect(images.map((f) => f.type)).toEqual(['image/png', 'image/jpeg']);
    expect(images.map((f) => f.name)).toEqual(['a1.png', 'a2.jpg']);
    expect(new Uint8Array(await images[1]!.arrayBuffer())).toEqual(JPG);
    const mask = form.get('mask') as File;
    expect(mask.name).toBe('m1.png');
    expect(new Uint8Array(await mask.arrayBuffer())).toEqual(PNG);
    expect(result.outputs[0]).toEqual({ bytes: PNG, mime: 'image/png' });
    expect(result.cost).toBeUndefined();
    expect(result.providerMeta).toMatchObject({ endpoint: 'edits' });
  });

  it('fails when the response has no images', async () => {
    stubFetch(() => ok({ data: [] }));
    await expect(provider.generate(req(), ctx())).rejects.toMatchObject({ name: 'ProviderError', code: 'no_output', retryable: false });
  });

  it('does not retry the submission and classifies errors', async () => {
    const cases: Array<[Response, Partial<ProviderError>]> = [
      [apiError(429, { message: 'slow down', code: 'rate_limit_exceeded' }), { retryable: true, code: 'rate_limited' }],
      [apiError(429, { message: 'no credits', code: 'insufficient_quota' }), { retryable: false, code: 'insufficient_quota' }],
      [apiError(503, { message: 'overloaded' }), { retryable: true, code: 'http_503' }],
      [apiError(401, { message: 'bad key' }), { retryable: false, code: 'auth' }],
      [apiError(400, { message: 'blocked', code: 'moderation_blocked' }), { retryable: false, code: 'moderation_blocked' }],
      [apiError(400, { message: 'bad size', code: 'invalid_value' }), { retryable: false, code: 'invalid_value' }],
    ];
    for (const [response, expected] of cases) {
      const calls = stubFetch(() => response.clone());
      const err = await provider.generate(req(), ctx()).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: 'failed', ...expected });
      expect(err.message).toContain('openai: HTTP');
      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it('treats connection failures as retryable and timeouts as not', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(provider.generate(req(), ctx())).rejects.toMatchObject({ retryable: true, code: 'network' });
    vi.unstubAllGlobals();

    const slow = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1', timeoutMs: 20 });
    stubFetch(({ init }) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    await expect(slow.generate(req(), ctx())).rejects.toMatchObject({ retryable: false, code: 'timeout' });
  });

  it('propagates the abort reason when the runner cancels', async () => {
    stubFetch(({ init }) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const controller = new AbortController();
    const c = { ...ctx(), signal: controller.signal };
    const pending = provider.generate(req(), c);
    controller.abort(new Error('cancelled by test'));
    await expect(pending).rejects.toThrow('cancelled by test');
  });

  it('describes the price for model pickers', () => {
    expect(describePricing({ textIn: 5, imageIn: 8, imageOut: 30 })).toBe('$30 per 1M output tokens (about $0.032 to $0.125 per 1024x1024 image, medium to high); cost is computed from reported usage');
    for (const m of createOpenAIProvider({ apiKey: 'k' }).models) expect(m.pricing).toMatch(/per 1M output tokens/);
  });

  it('estimates cost per model price table', () => {
    const miniDef = OPENAI_MODELS.find((d) => d.slug === 'gpt-image-1-mini')!;
    expect(estimateCost({ input_tokens: 100, output_tokens: 1000 }, miniDef.price)).toBeCloseTo((100 * 2 + 1000 * 8) / 1e6, 9);
    expect(estimateCost(undefined, miniDef.price)).toBeUndefined();
    expect(estimateCost({}, miniDef.price)).toBeUndefined();
  });
});
