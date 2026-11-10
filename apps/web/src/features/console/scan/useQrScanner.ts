import { useEffect, useRef, useState } from 'react';

export type CameraProblem = 'denied' | 'none' | 'failed';

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

/**
 * Opens the rear camera into `video` while `active` and calls `onText` with each QR it reads
 * (the same text again only after it left view, so one scan is one call). Uses the browser's
 * BarcodeDetector where there is one and otherwise decodes frames with jsQR, loaded only then.
 * The camera is released when `active` turns false or the component unmounts.
 */
export function useQrScanner(active: boolean, onText: (text: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const handler = useRef(onText);
  useEffect(() => {
    handler.current = onText;
  });

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const el = video.current;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        setProblem(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'denied'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'none'
              : 'failed',
        );
        return;
      }
      setProblem(null);
      if (stopped || !el) return stream.getTracks().forEach((t) => t.stop());
      el.srcObject = stream;
      await el.play().catch(() => undefined);

      const Native = (window as unknown as { BarcodeDetector?: new (o: object) => Detector })
        .BarcodeDetector;
      const native = Native ? new Native({ formats: ['qr_code'] }) : null;
      const jsQR = native ? null : (await import('jsqr')).default;
      const canvas = document.createElement('canvas');
      let last = '';
      let busy = false;
      timer = setInterval(() => {
        if (busy || stopped || el.videoWidth === 0) return;
        busy = true;
        void (async () => {
          let text = '';
          if (native) {
            text = (await native.detect(el).catch(() => []))[0]?.rawValue ?? '';
          } else if (jsQR) {
            canvas.width = el.videoWidth;
            canvas.height = el.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx?.drawImage(el, 0, 0);
            const image = ctx?.getImageData(0, 0, canvas.width, canvas.height);
            text = image ? (jsQR(image.data, image.width, image.height)?.data ?? '') : '';
          }
          busy = false;
          if (text !== last) {
            last = text;
            if (text && !stopped) handler.current(text);
          }
        })();
      }, 250);
    }
    void start();

    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (el) el.srcObject = null;
    };
  }, [active]);

  return { video, problem };
}
