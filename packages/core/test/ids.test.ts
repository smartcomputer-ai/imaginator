import { describe, expect, it } from 'vitest';
import { ID_ALPHABET, modelIdSchema, parseCellAddress, parseGenerationRef, randomId, slugify, cellAddressSchema } from '../src/ids.js';

describe('ids', () => {
  it('random ids use the restricted alphabet', () => {
    for (let i = 0; i < 100; i++) {
      const id = randomId();
      expect(id).toHaveLength(6);
      for (const ch of id) expect(ID_ALPHABET).toContain(ch);
    }
    expect(ID_ALPHABET).not.toMatch(/[01oli]/);
  });
  it('parses addresses', () => {
    expect(parseCellAddress('neon-cats/r3/flux-pro')).toEqual({ collection: 'neon-cats', row: 'r3', column: 'flux-pro' });
    expect(() => parseCellAddress('neon-cats/r3')).toThrow();
    expect(() => parseCellAddress('neon-cats/r3/flux-pro#2')).toThrow();
    expect(parseGenerationRef('q7m2kd')).toEqual({ id: 'q7m2kd' });
    expect(parseGenerationRef('neon-cats/r3/flux-pro#2')).toEqual({ collection: 'neon-cats', row: 'r3', column: 'flux-pro', version: 2 });
    expect(parseGenerationRef('neon-cats/r3/flux-pro')).toEqual({ collection: 'neon-cats', row: 'r3', column: 'flux-pro' });
    expect(cellAddressSchema.safeParse('a/b/c').success).toBe(false);
    expect(cellAddressSchema.parse('a/r1/c')).toEqual({ collection: 'a', row: 'r1', column: 'c' });
  });
  it('slugify', () => {
    expect(slugify('Neon Cats!')).toBe('neon-cats');
    expect(slugify('GPT Image 1')).toBe('gpt-image-1');
  });

  it('accepts provider/model ids whose model part is a nested path', () => {
    for (const ok of ['openai/gpt-image-1', 'fal/fal-ai/flux-pro/v1.1', 'fal/fal-ai/bytedance/seedream/v4.5/text-to-image', 'mock/fast']) {
      expect(modelIdSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['flux', 'fal/', 'fal//x', 'fal/x/', 'Fal/x', 'fal/x y', '/x']) {
      expect(modelIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
