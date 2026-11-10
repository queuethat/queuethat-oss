import { describe, expect, it } from 'vitest';
import { widgetPreviewUrl, widgetSnippet } from './snippet.ts';

describe('widget snippet', () => {
  it('points the script at the public URL and names the location', () => {
    expect(widgetSnippet('demo-barber', 'https://queue.example.com')).toBe(
      '<script src="https://queue.example.com/widget.js" data-location="demo-barber" async></script>',
    );
  });

  it('previews the /w page', () => {
    expect(widgetPreviewUrl('demo-barber', 'https://queue.example.com')).toBe(
      'https://queue.example.com/w/demo-barber',
    );
  });
});
