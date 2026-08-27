import {describe, expect, it} from 'vitest';
import {validateLoopbackPreviewUrl} from '../src/browser.js';

describe('validateLoopbackPreviewUrl', () => {
  it('accepts authenticated loopback URLs', () => {
    expect(validateLoopbackPreviewUrl('http://127.0.0.1:4312/?token=abc').hostname).toBe('127.0.0.1');
    expect(validateLoopbackPreviewUrl('http://[::1]:4312/?token=abc').hostname).toBe('[::1]');
  });

  it('rejects non-loopback URLs', () => {
    expect(() => validateLoopbackPreviewUrl('https://127.0.0.1:4312/?token=abc')).toThrow(/http/);
    expect(() => validateLoopbackPreviewUrl('http://example.com:4312/?token=abc')).toThrow(/loopback/);
    expect(() => validateLoopbackPreviewUrl('http://localhost:4312/?token=abc')).toThrow(/loopback/);
    expect(() => validateLoopbackPreviewUrl('http://127.0.0.1:4312/')).toThrow(/token/);
  });
});
