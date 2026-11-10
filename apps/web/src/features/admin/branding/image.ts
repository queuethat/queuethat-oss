/** Largest side of an uploaded brand image, in pixels. */
export const MAX_SIDE = 1024;
/** The bucket's limit is 2 MB; aim below it. */
export const MAX_BYTES = 1_800_000;
/** What the picker accepts. SVG is refused: it can carry script. */
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Size that fits `width` x `height` inside `max` on its longer side, never enlarging. */
export function fitWithin(width: number, height: number, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** True when the file's declared type is one the bucket accepts. */
export function isAcceptedImage(file: Pick<File, 'type'>): boolean {
  return ACCEPTED_TYPES.includes(file.type);
}

export interface EncodedImage {
  blob: Blob;
  extension: 'webp' | 'jpg' | 'png';
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Redraws the image on a canvas and encodes it as WebP at most `maxSide` (default `MAX_SIDE`) px wide, which drops
 * metadata and anything that was not pixels. Quality steps down until it fits `MAX_BYTES`.
 * Browsers that cannot encode WebP (Safari) get JPEG, which the bucket also accepts.
 */
export async function reencode(file: File, maxSide = MAX_SIDE): Promise<EncodedImage> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const [type, extension] of [
    ['image/webp', 'webp'],
    ['image/jpeg', 'jpg'],
  ] as const) {
    for (const quality of [0.9, 0.8, 0.65, 0.5, 0.35]) {
      const blob = await toBlob(canvas, type, quality);
      if (blob?.type !== type) break; // this engine cannot encode the type
      if (blob.size <= MAX_BYTES) return { blob, extension };
    }
  }
  throw new Error('image_too_large');
}
