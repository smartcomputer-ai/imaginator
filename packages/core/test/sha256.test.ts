import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256.js';

describe('sha256', () => {
  it('matches node:crypto on known and random inputs', () => {
    const inputs: (string | Uint8Array)[] = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✨'];
    for (let i = 0; i < 20; i++) inputs.push(new Uint8Array(randomBytes(Math.floor(Math.random() * 300))));
    for (const input of inputs) {
      const expected = createHash('sha256').update(input).digest('hex');
      expect(sha256Hex(input)).toBe(expected);
    }
  });
  it('abc', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
