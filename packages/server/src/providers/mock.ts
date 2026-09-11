import sharp from 'sharp';
import { z } from 'zod';
import {
  ProviderError,
  parseAspectRatio,
  parseSize,
  type Asset,
  type CancelOutcome,
  type GenerateContext,
  type GenerateResult,
  type InlineOutput,
  type JsonObject,
  type ModelSpec,
  type Provider,
  type ProviderRef,
  type ResolvedRequest,
} from '@imaginator/core';

// ---------------------------------------------------------------------------
// Test controls
// ---------------------------------------------------------------------------

export type MockPhase = 'start' | 'running' | 'complete';

export interface MockCall {
  type: 'generate' | 'resume' | 'cancel';
  model: string;
  prompt: string;
  attemptSeq: number;
}

export interface HeldCall {
  key: number;
  phase: MockPhase;
  model: string;
  prompt: string;
  type: 'generate' | 'resume';
}

interface HoldRule {
  id: number;
  phase: MockPhase;
  match: (info: { model: string; prompt: string; type: 'generate' | 'resume' }) => boolean;
}

interface FailRule {
  kind: 'failed' | 'ambiguous' | 'unsupported';
  retryable: boolean;
  message: string;
  match: (info: { model: string; prompt: string }) => boolean;
  remaining: number;
  /** When set, the failure happens after `setProviderRef` (only for models with a handle). */
  afterRef?: boolean;
}

class MockControl {
  /** When true: no random failures, no default delays. Tests set this. */
  deterministic = false;
  cancelOutcome: CancelOutcome = 'confirmed';
  calls: MockCall[] = [];
  private holds: HoldRule[] = [];
  private fails: FailRule[] = [];
  private held = new Map<number, { info: HeldCall; resolve: () => void; reject: (e: unknown) => void }>();
  private heldWaiters: Array<() => void> = [];
  private nextKey = 1;
  private nextRule = 1;
  private callSeq = 0;

  reset(): void {
    this.deterministic = false;
    this.cancelOutcome = 'confirmed';
    this.calls = [];
    this.holds = [];
    this.fails = [];
    for (const h of this.held.values()) h.resolve();
    this.held.clear();
    this.heldWaiters = [];
  }

  /** Hold every matching call at `phase` until released. Returns an unhold function. */
  hold(phase: MockPhase, match: string | HoldRule['match'] = () => true): () => void {
    const id = this.nextRule++;
    const fn = typeof match === 'string' ? (i: { prompt: string }) => i.prompt.includes(match) : match;
    this.holds.push({ id, phase, match: fn });
    return () => {
      this.holds = this.holds.filter((h) => h.id !== id);
    };
  }

  heldCalls(): HeldCall[] {
    return [...this.held.values()].map((h) => h.info);
  }

  /** Release held calls whose prompt includes `match` (or all with '*'). Returns how many were released. */
  release(match: string | ((info: HeldCall) => boolean) = '*'): number {
    const fn = typeof match === 'string' ? (i: HeldCall) => match === '*' || i.prompt.includes(match) : match;
    let n = 0;
    for (const [key, h] of [...this.held]) {
      if (fn(h.info)) {
        this.held.delete(key);
        h.resolve();
        n++;
      }
    }
    return n;
  }

  /** Resolve once at least `count` calls are held (matching `match`). */
  waitForHeld(count = 1, match: string | ((info: HeldCall) => boolean) = '*', timeoutMs = 10_000): Promise<HeldCall[]> {
    const fn = typeof match === 'string' ? (i: HeldCall) => match === '*' || i.prompt.includes(match) : match;
    return new Promise((resolve, reject) => {
      const check = () => {
        const matching = this.heldCalls().filter(fn);
        if (matching.length >= count) {
          clearTimeout(timer);
          this.heldWaiters = this.heldWaiters.filter((w) => w !== check);
          resolve(matching);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        this.heldWaiters = this.heldWaiters.filter((w) => w !== check);
        reject(new Error(`timed out waiting for ${count} held mock call(s); held: ${JSON.stringify(this.heldCalls())}`));
      }, timeoutMs);
      if (!check()) this.heldWaiters.push(check);
    });
  }

  /** Make the next `times` matching generate calls fail. */
  failNext(opts: {
    kind?: 'failed' | 'ambiguous' | 'unsupported';
    retryable?: boolean;
    message?: string;
    match?: string | FailRule['match'];
    times?: number;
    afterRef?: boolean;
  } = {}): void {
    const m = opts.match;
    const fn = m === undefined ? () => true : typeof m === 'string' ? (i: { prompt: string }) => i.prompt.includes(m) : m;
    this.fails.push({
      kind: opts.kind ?? 'failed',
      retryable: opts.retryable ?? false,
      message: opts.message ?? `mock failure (${opts.kind ?? 'failed'})`,
      match: fn,
      remaining: opts.times ?? 1,
      afterRef: opts.afterRef,
    });
  }

  // -- used by the provider --

  record(call: Omit<MockCall, 'attemptSeq'>): void {
    this.calls.push({ ...call, attemptSeq: ++this.callSeq });
  }

  async checkpoint(phase: MockPhase, info: { model: string; prompt: string; type: 'generate' | 'resume' }, signal: AbortSignal): Promise<void> {
    if (!this.holds.some((h) => h.phase === phase && h.match(info))) return;
    const key = this.nextKey++;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.held.delete(key);
        reject(signal.reason ?? new Error('aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.held.set(key, {
        info: { key, phase, ...info },
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      });
      for (const w of [...this.heldWaiters]) w();
    });
  }

  takeFailure(info: { model: string; prompt: string }, afterRef: boolean): FailRule | undefined {
    const rule = this.fails.find((f) => f.remaining > 0 && !!f.afterRef === afterRef && f.match(info));
    if (!rule) return undefined;
    rule.remaining--;
    if (rule.remaining === 0) this.fails = this.fails.filter((f) => f !== rule);
    return rule;
  }
}

export const mockControl = new MockControl();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] += '…';
  return lines.length ? lines : ['(empty prompt)'];
}

function dimensionsFor(req: ResolvedRequest, useSize: boolean): { width: number; height: number } {
  if (useSize) {
    const s = req.common.size ? parseSize(req.common.size) : undefined;
    return s ?? { width: 512, height: 512 };
  }
  const ar = req.common.aspectRatio ? parseAspectRatio(req.common.aspectRatio) : undefined;
  if (!ar) return { width: 512, height: 512 };
  const [w, h] = ar;
  const base = 512;
  return w >= h ? { width: base, height: Math.max(16, Math.round((base * h) / w)) } : { width: Math.max(16, Math.round((base * w) / h)), height: base };
}

function svgOverlay(req: ResolvedRequest, modelName: string, index: number, width: number, height: number, hue: number, background: boolean): string {
  const fontSize = Math.max(12, Math.round(width / 22));
  const lines = wrap(req.prompt, Math.max(10, Math.floor(width / (fontSize * 0.55))), 6);
  const meta = [modelName, req.common.seed !== undefined ? `seed ${req.common.seed}` : undefined, req.count > 1 ? `#${index + 1}/${req.count}` : undefined]
    .filter(Boolean)
    .join(' · ');
  const bg = background ? `<rect width="100%" height="100%" fill="hsl(${hue},60%,42%)"/>` : '';
  const text = lines
    .map((l, i) => `<text x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.18 + i * fontSize * 1.3)}" font-size="${fontSize}" fill="white" font-family="Helvetica, Arial, sans-serif">${escapeXml(l)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bg}${text}<text x="${Math.round(width * 0.06)}" y="${height - Math.round(fontSize * 0.8)}" font-size="${Math.round(fontSize * 0.75)}" fill="rgba(255,255,255,0.85)" font-family="Helvetica, Arial, sans-serif">${escapeXml(meta)}</text></svg>`;
}

function hueFor(req: ResolvedRequest, index: number): number {
  const settingHue = typeof req.settings.hue === 'number' ? req.settings.hue : undefined;
  if (settingHue !== undefined) return (settingHue + index * 37) % 360;
  const seed = req.common.seed;
  const base = seed !== undefined ? seed : hashString(req.prompt + '|' + req.model);
  return (base + index * 37) % 360;
}

async function encode(image: sharp.Sharp, format: string | undefined): Promise<InlineOutput> {
  switch (format) {
    case 'jpeg':
      return { bytes: new Uint8Array(await image.jpeg({ quality: 85 }).toBuffer()), mime: 'image/jpeg' };
    case 'webp':
      return { bytes: new Uint8Array(await image.webp({ quality: 85 }).toBuffer()), mime: 'image/webp' };
    default:
      return { bytes: new Uint8Array(await image.png().toBuffer()), mime: 'image/png' };
  }
}

async function render(req: ResolvedRequest, modelName: string, useSize: boolean, ctx: GenerateContext): Promise<InlineOutput[]> {
  const { width, height } = dimensionsFor(req, useSize);
  const outputs: InlineOutput[] = [];
  const init = req.inputs.find((i) => i.role === 'init');
  for (let i = 0; i < req.count; i++) {
    const hue = hueFor(req, i);
    let image: sharp.Sharp;
    if (init) {
      const src = await ctx.asset(init.asset);
      const tinted = await sharp(Buffer.from(src.bytes)).resize(width, height, { fit: 'cover' }).tint(hslToRgb(hue)).toBuffer();
      image = sharp(tinted).composite([{ input: Buffer.from(svgOverlay(req, modelName, i, width, height, hue, false)) }]);
    } else {
      image = sharp(Buffer.from(svgOverlay(req, modelName, i, width, height, hue, true)));
    }
    outputs.push(await encode(image, req.common.outputFormat));
  }
  return outputs;
}

function hslToRgb(h: number): { r: number; g: number; b: number } {
  const s = 0.6, l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const mockSettings = z.object({
  hue: z.number().min(0).max(360).optional().describe('Background hue; default derived from prompt/seed'),
  delayMs: z.number().int().min(0).optional().describe('Simulated provider latency'),
});

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function validateImages(inputs: Asset[]): string[] {
  const errors: string[] = [];
  for (const a of inputs) {
    if (a.kind !== 'image' || !IMAGE_MIMES.includes(a.mime)) errors.push(`input ${a.id} is ${a.mime}; mock accepts png/jpeg/webp/gif`);
    if (a.bytes > 20 * 1024 * 1024) errors.push(`input ${a.id} exceeds 20MB`);
  }
  return errors;
}

const MOCK_PRICING = '$0.001 per image (pretend; nothing is charged)';

function textOnly(id: string, name: string, extra: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id,
    name,
    kind: 'image',
    capabilities: { inputRoles: [], maxInputImages: 0, negativePrompt: false, commonKeys: ['aspectRatio', 'seed', 'outputFormat'], count: 4, outputFormats: ['png', 'jpeg', 'webp'] },
    validateRequest: () => [],
    settings: mockSettings,
    pricing: MOCK_PRICING,
    ...extra,
  };
}

const fast = textOnly('mock/fast', 'Mock Fast', { description: 'Renders the prompt on a colored card after ~300ms.' });
const slow: ModelSpec = {
  ...textOnly('mock/slow', 'Mock Slow', { description: 'Like fast, but 2-4s with a resumable job handle. Honors size, not aspectRatio.' }),
  capabilities: { inputRoles: [], maxInputImages: 0, negativePrompt: false, commonKeys: ['size', 'seed', 'outputFormat'], count: 4, sizes: ['512x512', '1024x1024', '1024x768'], outputFormats: ['png', 'jpeg', 'webp'] },
  concurrency: 4,
};
const flaky = textOnly('mock/flaky', 'Mock Flaky', { description: 'Fails ~30% of the time with retryable errors; occasionally ambiguous.' });
const textOnlyOne: ModelSpec = {
  ...textOnly('mock/text-only', 'Mock Text Only', { description: 'One output per request, no options beyond seed.' }),
  capabilities: { inputRoles: [], maxInputImages: 0, negativePrompt: false, commonKeys: ['seed'], count: 1 },
};
const img2img: ModelSpec = {
  id: 'mock/img2img',
  name: 'Mock Img2Img',
  kind: 'image',
  description: 'Tints the init image and overlays the prompt. Accepts init, mask, reference.',
  pricing: MOCK_PRICING,
  capabilities: { inputRoles: ['init', 'mask', 'reference'], maxInputImages: 3, negativePrompt: true, commonKeys: ['aspectRatio', 'seed', 'outputFormat'], count: 4, outputFormats: ['png', 'jpeg', 'webp'] },
  settings: mockSettings,
  validateRequest(req, inputs) {
    const errors = validateImages(inputs);
    const inits = req.inputs.filter((i) => i.role === 'init');
    const masks = req.inputs.filter((i) => i.role === 'mask');
    if (inits.length > 1) errors.push('at most one init image');
    if (masks.length > 1) errors.push('at most one mask');
    if (masks.length > 0 && inits.length === 0) errors.push('a mask requires an init image');
    for (const m of masks) {
      const target = inputs[m.maskFor!];
      const mask = inputs[req.inputs.indexOf(m)];
      if (target && mask && (target.width !== mask.width || target.height !== mask.height)) {
        errors.push(`mask ${mask.id} (${mask.width}x${mask.height}) must match its init image ${target.id} (${target.width}x${target.height})`);
      }
    }
    return errors;
  },
};

/** An editing model like Kontext: takes an init image, no negative prompt. */
const edit: ModelSpec = {
  ...img2img,
  id: 'mock/edit',
  name: 'Mock Edit',
  description: 'Like img2img but without negative prompt support: a stand-in for instruction-driven editors.',
  capabilities: { ...img2img.capabilities, inputRoles: ['init', 'reference'], minInputImages: 1, negativePrompt: false },
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface MockJob {
  id: string;
  request: ResolvedRequest;
  cancelled: boolean;
}

/** In-memory job table for mock/slow, keyed by providerRef job id. Survives app restarts within one process. */
const jobs = new Map<string, MockJob>();
let jobSeq = 0;

function delayFor(req: ResolvedRequest, defaultMs: number): number {
  const d = req.settings.delayMs;
  if (typeof d === 'number') return d;
  return mockControl.deterministic ? 0 : defaultMs;
}

function throwRule(rule: { kind: 'failed' | 'ambiguous' | 'unsupported'; retryable: boolean; message: string }): never {
  throw new ProviderError(rule.message, { kind: rule.kind, retryable: rule.retryable, code: `mock_${rule.kind}` });
}

async function finish(req: ResolvedRequest, spec: ModelSpec, useSize: boolean, ctx: GenerateContext, type: 'generate' | 'resume'): Promise<GenerateResult> {
  await mockControl.checkpoint('complete', { model: req.model, prompt: req.prompt, type }, ctx.signal);
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
  const outputs = await render(req, spec.name, useSize, ctx);
  return { outputs, cost: 0.001 * req.count, providerMeta: { mock: true, model: req.model, rendered: outputs.length } };
}

export const mockProvider: Provider = {
  id: 'mock',
  name: 'Mock',
  concurrency: 8,
  models: [fast, slow, flaky, img2img, edit, textOnlyOne],

  async generate(req, ctx) {
    const spec = this.models.find((m) => m.id === req.model);
    if (!spec) throw new ProviderError(`unknown mock model ${req.model}`, { kind: 'unsupported' });
    const info = { model: req.model, prompt: req.prompt };
    mockControl.record({ type: 'generate', ...info });
    await mockControl.checkpoint('start', { ...info, type: 'generate' }, ctx.signal);

    const pre = mockControl.takeFailure(info, false);
    if (pre) throwRule(pre);
    if (spec.id === 'mock/flaky' && !mockControl.deterministic) {
      const r = Math.random();
      if (r < 0.05) throw new ProviderError('mock: submission timed out; unknown whether accepted', { kind: 'ambiguous' });
      if (r < 0.3) throw new ProviderError('mock: transient 503', { retryable: true, code: 'http_503' });
    }

    if (spec.id === 'mock/slow') {
      const id = `job-${++jobSeq}-${Date.now().toString(36)}`;
      jobs.set(id, { id, request: req, cancelled: false });
      const ref: ProviderRef = { version: 1, model: req.model, data: { jobId: id, request: req as unknown as JsonObject } };
      await ctx.setProviderRef(ref);
      return monitor(id, req, spec, ctx, 'generate');
    }

    await ctx.sleep(delayFor(req, spec.id === 'mock/fast' ? 300 : 500));
    return finish(req, spec, false, ctx, 'generate');
  },

  async resume(ref, ctx) {
    const job = jobs.get(String(ref.data.jobId));
    const req = job?.request ?? (ref.data.request as unknown as ResolvedRequest);
    if (!req) throw new ProviderError('mock: cannot resume, no request in providerRef', { kind: 'failed' });
    const spec = this.models.find((m) => m.id === req.model) ?? slow;
    mockControl.record({ type: 'resume', model: req.model, prompt: req.prompt });
    if (!job) jobs.set(String(ref.data.jobId), { id: String(ref.data.jobId), request: req, cancelled: false });
    return monitor(String(ref.data.jobId), req, spec, ctx, 'resume');
  },

  async cancel(ref) {
    const job = jobs.get(String(ref.data.jobId));
    mockControl.record({ type: 'cancel', model: ref.model, prompt: job?.request.prompt ?? '' });
    const outcome = mockControl.cancelOutcome;
    if (outcome === 'confirmed' && job) job.cancelled = true;
    return outcome;
  },
};

async function monitor(jobId: string, req: ResolvedRequest, spec: ModelSpec, ctx: GenerateContext, type: 'generate' | 'resume'): Promise<GenerateResult> {
  const info = { model: req.model, prompt: req.prompt };
  await mockControl.checkpoint('running', { ...info, type }, ctx.signal);
  const post = mockControl.takeFailure(info, true);
  if (post) throwRule(post);
  const total = delayFor(req, 2000 + Math.random() * 2000);
  const step = Math.min(250, Math.max(1, total));
  let waited = 0;
  while (waited < total) {
    await ctx.sleep(step);
    waited += step;
    if (jobs.get(jobId)?.cancelled) throw new ProviderError('mock: job was cancelled', { kind: 'failed', retryable: false, code: 'cancelled' });
  }
  const result = await finish(req, spec, true, ctx, type);
  jobs.delete(jobId);
  return result;
}

export const mockModels = { fast, slow, flaky, img2img, edit, textOnly: textOnlyOne };
