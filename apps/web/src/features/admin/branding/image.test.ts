import { describe, expect, it } from 'vitest';
import { fitWithin, isAcceptedImage } from './image.ts';

describe('brand images', () => {
  it('shrinks to 1024 on the longer side and keeps the ratio', () => {
    expect(fitWithin(4000, 2000)).toEqual({ width: 1024, height: 512 });
    expect(fitWithin(500, 3000)).toEqual({ width: 171, height: 1024 });
  });
  it('never enlarges', () => {
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
  });
  it('accepts png, jpeg and webp only', () => {
    expect(isAcceptedImage({ type: 'image/webp' })).toBe(true);
    expect(isAcceptedImage({ type: 'image/svg+xml' })).toBe(false);
    expect(isAcceptedImage({ type: '' })).toBe(false);
  });
});
