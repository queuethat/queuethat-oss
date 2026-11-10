import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Shell of the embeddable join page (`/w/:slug`, J7). It reports its own height to the page that
 * frames it, so `widget.js` can size the iframe. The message carries a number and nothing else,
 * which is why any target origin is acceptable.
 */
export function WidgetFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.parent === window) return;
    const report = () =>
      window.parent.postMessage(
        { type: 'qm-widget-height', height: Math.ceil(el.scrollHeight) },
        '*',
      );
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="layout-guest" data-layout="widget">
      <main>{children}</main>
    </div>
  );
}
