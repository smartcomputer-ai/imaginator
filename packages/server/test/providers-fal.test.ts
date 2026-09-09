import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry, ProviderError, resolveCell, type Asset, type Column, type GenerateContext, type ProviderRef, type ResolvedRequest, type Row } from '@imaginator/core';
import { createFalProvider, FAL_MODELS, buildInput, sizeFields } from '../src/providers/fal.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const assets: Record<string, Asset> = {
  a1: { id: 'a1', kind: 'image', origin: { type: 'upload' }, mime: 'image/png', width: 1024, height: 1024, bytes: PNG.length, sha256: 'x', createdAt: 'now' },
  a2: { id: 'a2', kind: 'image', origin: { type: 'upload' }, mime: 'image/jpeg', width: 640, height: 480, bytes: PNG.length, sha256: 'y', createdAt: 'now' },
  g1: { id: 'g1', kind: 'image', origin: { type: 'upload' }, mime: 'image/gif', width: 10, height: 10, bytes: 1, sha256: 'z', createdAt: 'now' },
};

function ctx(signal = new AbortController().signal): GenerateContext & { logs: string[]; refs: ProviderRef[] } {
  const logs: string[] = [];
  const refs: ProviderRef[] = [];
  return {
    signal,
    asset: async (id) => ({ bytes: PNG, mime: assets[id]!.mime, path: `/x/${id}` }),
    setProviderRef: async (ref) => {
      refs.push(ref);
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
    logs,
    refs,
  };
}

const ULTRA = 'fal/fal-ai/flux-pro/v1.1-ultra';
const SCHNELL = 'fal/fal-ai/flux/schnell';
const BANANA_EDIT = 'fal/fal-ai/nano-banana-2/edit';
const KONTEXT = 'fal/fal-ai/flux-pro/kontext/max';
const RECRAFT = 'fal/fal-ai/recraft/v3/text-to-image';
const QWEN = 'fal/fal-ai/qwen-image';

function req(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return { model: SCHNELL, prompt: 'a lighthouse', inputs: [], count: 1, common: {}, settings: {}, droppedKeys: [], registryVersion: 'test', ...overrides };
}

const provider = createFalProvider({ apiKey: 'fal-test', queueUrl: 'https://queue.test/', restUrl: 'https://rest.test', pollMs: 0, timeoutMs: 5000 });
const registry = new ModelRegistry([provider], 'test');
const def = (id: string) => FAL_MODELS.find((d) => `fal/${d.endpoint}` === id)!;

function resolve(row: Partial<Row>, column: Partial<Column> = {}, defaults = {}) {
  const r: Row = { id: 'r1', prompt: 'a cat', inputs: [], paused: false, position: 0, ...row };
  const c: Column = { id: 'c1', model: SCHNELL, count: 1, position: 0, ...column };
  return resolveCell({ defaults }, r, c, { registry, asset: (id) => assets[id] });
}

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init }, calls.length);
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const submitted = {
  request_id: 'req-1',
  status_url: 'https://queue.test/fal-ai/flux/schnell/requests/req-1/status',
  response_url: 'https://queue.test/fal-ai/flux/schnell/requests/req-1',
  cancel_url: 'https://queue.test/fal-ai/flux/schnell/requests/req-1/cancel',
};
const result = {
  images: [{ url: 'https://fal.media/files/a.jpg', content_type: 'image/jpeg', width: 1024, height: 768 }],
  seed: 42,
  has_nsfw_concepts: [false],
  prompt: 'a lighthouse',
  timings: { inference: 0.4 },
};

/** Routes a happy-path queue lifecycle; `statuses` is the sequence of status responses. */
function queueServer(statuses: unknown[] = [{ status: 'IN_QUEUE', queue_position: 1 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED', metrics: { inference_time: 0.4 } }]) {
  let s = 0;
  return stubFetch(({ url, init }) => {
    if (url.startsWith('https://rest.test/storage/upload/initiate')) return json({ upload_url: 'https://upload.test/put/' + JSON.parse(init.body as string).file_name, file_url: 'https://cdn.test/' + JSON.parse(init.body as string).file_name });
    if (url.startsWith('https://upload.test/')) return new Response('', { status: 200 });
    if (init.method === 'POST' && url.startsWith('https://queue.test/fal-ai/')) return json(submitted);
    if (url === submitted.status_url) return json(statuses[Math.min(s++, statuses.length - 1)]);
    if (url === submitted.response_url) return json(result);
    return new Response('nope', { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('fal provider: registry', () => {
  it('registers every model with fal/<endpoint> ids and per-endpoint capabilities', () => {
    expect(provider.models.map((m) => m.id)).toEqual(FAL_MODELS.map((d) => `fal/${d.endpoint}`));
    const ultra = registry.get(ULTRA)!;
    expect(ultra.capabilities.commonKeys).toEqual(['aspectRatio', 'seed', 'outputFormat']);
    expect(ultra.capabilities.aspectRatios).toContain('21:9');
    const schnell = registry.get(SCHNELL)!;
    expect(schnell.capabilities.commonKeys).toEqual(['aspectRatio', 'size', 'seed', 'outputFormat']);
    expect(schnell.capabilities.inputRoles).toEqual([]);
    const recraft = registry.get(RECRAFT)!;
    expect(recraft.capabilities.commonKeys).toEqual(['aspectRatio', 'size']);
    expect(recraft.capabilities.count).toBe(1);
    expect(registry.get(QWEN)!.capabilities.negativePrompt).toBe(true);
    expect(registry.defaultsFor(SCHNELL)).toEqual({ num_inference_steps: 4, guidance_scale: 3.5, acceleration: 'none', enable_safety_checker: true });
  });

  it('drops size on aspect-ratio endpoints and validates settings', () => {
    const r = resolve({ settings: { size: '1024x1024', aspectRatio: '1:1', seed: 7 } }, { model: ULTRA });
    expect(r.unsupported).toEqual([]);
    expect(r.request.droppedKeys).toEqual(['size']);
    expect(r.request.common).toEqual({ aspectRatio: '1:1', seed: 7 });
    expect(resolve({ settings: { seed: 1 } }, { model: RECRAFT }).request.droppedKeys).toEqual(['seed']);
    expect(resolve({}, { model: SCHNELL, settings: { num_inference_steps: 99 } }).unsupported[0]).toMatch(/num_inference_steps/);
    expect(resolve({ settings: { aspectRatio: '5:1' } }, { model: ULTRA }).unsupported[0]).toMatch(/aspectRatio 5:1 not supported/);
  });

  it('rejects masks, too many images, and non-image inputs', () => {
    expect(resolve({ inputs: [{ asset: 'a1', role: 'init' }] }, { model: KONTEXT }).unsupported).toEqual([]);
    expect(resolve({ inputs: [{ asset: 'a1', role: 'init' }, { asset: 'a2', role: 'reference' }] }, { model: KONTEXT }).unsupported[0]).toMatch(/exceed the model maximum of 1/);
    expect(resolve({ inputs: [{ asset: 'a1', role: 'init' }, { asset: 'a1', role: 'mask', maskFor: 0 }] }, { model: BANANA_EDIT }).unsupported[0]).toMatch(/mask/);
    expect(resolve({ inputs: [{ asset: 'g1', role: 'reference' }] }, { model: BANANA_EDIT }).unsupported[0]).toMatch(/image\/gif/);
    expect(resolve({ inputs: [{ asset: 'a1', role: 'reference' }] }, { model: SCHNELL }).unsupported[0]).toMatch(/text-only/);
  });
});

describe('fal provider: input mapping', () => {
  it('maps sizes to presets, custom dimensions, or aspect ratios', () => {
    const schnell = def(SCHNELL);
    expect(sizeFields(req(), schnell).fields).toEqual({ image_size: 'landscape_4_3' });
    expect(sizeFields(req({ common: { aspectRatio: '16:9' } }), schnell).fields).toEqual({ image_size: 'landscape_16_9' });
    expect(sizeFields(req({ common: { aspectRatio: '2:1' } }), schnell).fields).toEqual({ image_size: { width: 1456, height: 736 } });
    expect(sizeFields(req({ common: { size: '1200x800' } }), schnell).fields).toEqual({ image_size: { width: 1200, height: 800 } });
    expect(sizeFields(req({ common: { size: '100x100' } }), schnell).error).toMatch(/between 256 and 14142/);
    const pro2 = def('fal/fal-ai/flux-2-pro');
    expect(sizeFields(req({ common: { size: '1000x1000' } }), pro2).error).toMatch(/multiples of 16/);
    const ultra = def(ULTRA);
    expect(sizeFields(req({ common: { aspectRatio: '32:18' } }), ultra).fields).toEqual({ aspect_ratio: '16:9' });
    expect(sizeFields(req(), ultra).fields).toEqual({ aspect_ratio: '16:9' });
    expect(sizeFields(req(), def(KONTEXT)).fields).toEqual({});
  });

  it('builds the fal input body from common keys, settings, and inputs', () => {
    const body = buildInput(
      req({ count: 3, common: { seed: 9, outputFormat: 'png', aspectRatio: '1:1' }, settings: { num_inference_steps: 2, acceleration: 'high' } }),
      def(SCHNELL),
      [],
    );
    expect(body).toEqual({ prompt: 'a lighthouse', image_size: 'square_hd', num_inference_steps: 2, acceleration: 'high', num_images: 3, seed: 9, output_format: 'png' });

    const edit = buildInput(
      req({ model: BANANA_EDIT, inputs: [{ asset: 'a1', role: 'init' }, { asset: 'a2', role: 'reference' }], settings: { resolution: '2K' } }),
      def(BANANA_EDIT),
      ['https://cdn.test/a1.png', 'https://cdn.test/a2.jpg'],
    );
    expect(edit).toEqual({ prompt: 'a lighthouse', resolution: '2K', num_images: 1, image_urls: ['https://cdn.test/a1.png', 'https://cdn.test/a2.jpg'] });

    const single = buildInput(req({ model: KONTEXT, inputs: [{ asset: 'a1', role: 'init' }], common: { aspectRatio: '4:3' } }), def(KONTEXT), ['https://cdn.test/a1.png']);
    expect(single).toMatchObject({ aspect_ratio: '4:3', image_url: 'https://cdn.test/a1.png' });

    // No num_images / output_format / seed on endpoints without those fields; negative prompt only when supported.
    const recraft = buildInput(req({ model: RECRAFT, count: 1, negativePrompt: 'blurry', common: { seed: 1 }, settings: { style: 'vector_illustration' } }), def(RECRAFT), []);
    expect(recraft).toEqual({ prompt: 'a lighthouse', image_size: 'square_hd', style: 'vector_illustration' });
    const qwen = buildInput(req({ model: QWEN, negativePrompt: 'blurry' }), def(QWEN), []);
    expect(qwen.negative_prompt).toBe('blurry');
  });
});

describe('fal provider: lifecycle', () => {
  it('submits, commits the handle, polls to completion, and returns remote outputs', async () => {
    const calls = queueServer();
    const c = ctx();
    const out = await provider.generate(req({ common: { seed: 42 } }), c);

    expect(calls[0]!.url).toBe('https://queue.test/fal-ai/flux/schnell');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Key fal-test');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ prompt: 'a lighthouse', seed: 42 });
    expect(c.refs).toHaveLength(1);
    expect(c.refs[0]).toEqual({ version: 1, model: SCHNELL, data: { endpoint: 'fal-ai/flux/schnell', requestId: 'req-1', statusUrl: submitted.status_url, responseUrl: submitted.response_url, cancelUrl: submitted.cancel_url, count: 1 } });
    // submit, 3 status polls, 1 response fetch; the handle was committed before the first poll.
    expect(calls.map((x) => x.url)).toEqual(['https://queue.test/fal-ai/flux/schnell', submitted.status_url, submitted.status_url, submitted.status_url, submitted.response_url]);

    expect(out.outputs).toEqual([{ url: 'https://fal.media/files/a.jpg', mime: 'image/jpeg', meta: { width: 1024, height: 768, nsfw: false } }]);
    expect(out.cost).toBeCloseTo(0.003, 9);
    expect(out.providerMeta).toEqual({ endpoint: 'fal-ai/flux/schnell', requestId: 'req-1', seed: 42, prompt: 'a lighthouse', timings: { inference: 0.4 }, inferenceTime: 0.4 });
    expect(c.logs.some((l) => l.includes('IN_QUEUE (queue position 1)'))).toBe(true);
  });

  it('uploads input images to fal storage before submitting', async () => {
    const calls = queueServer();
    await provider.generate(req({ model: BANANA_EDIT, inputs: [{ asset: 'a1', role: 'init' }, { asset: 'a2', role: 'reference' }] }), ctx());
    const urls = calls.map((x) => x.url);
    expect(urls.slice(0, 4)).toEqual([
      'https://rest.test/storage/upload/initiate?storage_type=fal-cdn-v3',
      'https://upload.test/put/a1.png',
      'https://rest.test/storage/upload/initiate?storage_type=fal-cdn-v3',
      'https://upload.test/put/a2.jpg',
    ]);
    expect(calls[1]!.init.method).toBe('PUT');
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ content_type: 'image/jpeg', file_name: 'a2.jpg' });
    expect(JSON.parse(calls[4]!.init.body as string).image_urls).toEqual(['https://cdn.test/a1.png', 'https://cdn.test/a2.jpg']);
  });

  it('resumes from a providerRef without resubmitting', async () => {
    const calls = queueServer([{ status: 'COMPLETED' }]);
    const ref: ProviderRef = { version: 1, model: SCHNELL, data: { endpoint: 'fal-ai/flux/schnell', requestId: 'req-1', statusUrl: submitted.status_url, responseUrl: submitted.response_url, cancelUrl: submitted.cancel_url, count: 1 } };
    const out = await provider.resume!(ref, ctx());
    expect(calls.map((x) => x.url)).toEqual([submitted.status_url, submitted.response_url]);
    expect(out.outputs).toHaveLength(1);
  });

  it('classifies submission failures', async () => {
    const cases: Array<[Response | Error, Partial<ProviderError>]> = [
      [json({ detail: [{ loc: ['body', 'image_size'], msg: 'invalid size', type: 'value_error' }] }, 422), { kind: 'failed', retryable: false, code: 'value_error' }],
      [json({ detail: 'Unauthorized' }, 401), { kind: 'failed', retryable: false, code: 'auth' }],
      [json({ detail: 'too many', error_type: 'concurrent_requests_limit' }, 429), { kind: 'failed', retryable: true, code: 'concurrent_requests_limit' }],
      [json({ detail: 'boom' }, 503), { kind: 'failed', retryable: true, code: 'http_503' }],
      [new TypeError('fetch failed'), { kind: 'failed', retryable: true, code: 'network' }],
      [new Error('timeout after 5000ms'), { kind: 'ambiguous', retryable: false, code: 'submit_timeout' }],
    ];
    for (const [response, expected] of cases) {
      const calls = stubFetch(() => {
        if (response instanceof Error) throw response;
        return response.clone();
      });
      const c = ctx();
      const err = await provider.generate(req(), c).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject(expected);
      expect(calls).toHaveLength(1);
      expect(c.refs).toHaveLength(0);
      vi.unstubAllGlobals();
    }
    const err = await (async () => {
      stubFetch(() => json({ detail: [{ loc: ['body', 'image_size'], msg: 'invalid size', type: 'value_error' }] }, 422));
      return provider.generate(req(), ctx()).catch((e) => e);
    })();
    expect(err.message).toBe('fal: submit: HTTP 422: image_size: invalid size');
  });

  it('surfaces runner failures reported by the response endpoint', async () => {
    stubFetch(({ url, init }) => {
      if (init.method === 'POST') return json(submitted);
      if (url === submitted.status_url) return json({ status: 'COMPLETED' });
      return json({ detail: [{ loc: ['body'], msg: 'unsafe prompt', type: 'content_policy_violation' }] }, 422);
    });
    await expect(provider.generate(req(), ctx())).rejects.toMatchObject({ kind: 'failed', retryable: false, code: 'content_policy_violation' });

    vi.unstubAllGlobals();
    stubFetch(({ url, init }) => {
      if (init.method === 'POST') return json(submitted);
      if (url === submitted.status_url) return json({ status: 'COMPLETED', error: 'runner died', error_type: 'runner_disconnected' });
      return json(result);
    });
    await expect(provider.generate(req(), ctx())).rejects.toMatchObject({ kind: 'failed', retryable: true, code: 'runner_disconnected' });
  });

  it('marks a vanished request as ambiguous when polling stops working', async () => {
    stubFetch(({ init }) => {
      if (init.method === 'POST') return json(submitted);
      throw new TypeError('fetch failed');
    });
    await expect(provider.generate(req(), ctx())).rejects.toMatchObject({ kind: 'ambiguous', code: 'monitor_lost' });

    vi.unstubAllGlobals();
    const slow = createFalProvider({ apiKey: 'k', queueUrl: 'https://queue.test', pollMs: 0, maxWaitMs: 0, timeoutMs: 1000 });
    stubFetch(({ init }) => (init.method === 'POST' ? json(submitted) : json({ status: 'IN_PROGRESS' })));
    await expect(slow.generate(req(), ctx())).rejects.toMatchObject({ kind: 'ambiguous', code: 'monitor_timeout' });
  });

  it('stops polling when aborted and propagates the reason', async () => {
    const controller = new AbortController();
    stubFetch(({ init }) => {
      if (init.method === 'POST') return json(submitted);
      controller.abort(new Error('cancelled by test'));
      return json({ status: 'IN_PROGRESS' });
    });
    await expect(provider.generate(req(), ctx(controller.signal))).rejects.toThrow('cancelled by test');
  });

  it('cancels via the cancel_url and reports the outcome', async () => {
    const ref: ProviderRef = { version: 1, model: SCHNELL, data: { endpoint: 'fal-ai/flux/schnell', requestId: 'req-1', statusUrl: submitted.status_url, responseUrl: submitted.response_url, cancelUrl: submitted.cancel_url, count: 1 } };

    let calls = stubFetch(({ url, init }) => {
      if (init.method === 'PUT') return json({ status: 'CANCELLATION_REQUESTED' }, 202);
      if (url === submitted.status_url) return json({ status: 'NOT_FOUND' }, 404);
      return json({});
    });
    expect(await provider.cancel!(ref)).toBe('confirmed');
    expect(calls[0]!.url).toBe(submitted.cancel_url);
    vi.unstubAllGlobals();

    calls = stubFetch(({ init }) => (init.method === 'PUT' ? json({ status: 'CANCELLATION_REQUESTED' }, 202) : json({ status: 'IN_PROGRESS' })));
    expect(await provider.cancel!(ref)).toBe('pending');
    vi.unstubAllGlobals();

    stubFetch(() => json({ status: 'ALREADY_COMPLETED' }, 400));
    expect(await provider.cancel!(ref)).toBe('pending');
    vi.unstubAllGlobals();

    stubFetch(() => json({ status: 'NOT_FOUND' }, 404));
    expect(await provider.cancel!(ref)).toBe('confirmed');
  });
});
