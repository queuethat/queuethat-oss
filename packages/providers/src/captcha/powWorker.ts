// Web Worker entry: `new Worker(new URL('.../powWorker.ts', import.meta.url), { type: 'module' })`.
// Keeps the hash loop off the main thread so the join form stays responsive while it solves.
import { solvePow } from './powSolver.ts';

interface Request {
  challenge: string;
  difficulty: number;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { challenge, difficulty } = event.data;
  const post = (message: unknown) => (self as unknown as Worker).postMessage(message);
  try {
    const token = await solvePow(challenge, difficulty, {
      onProgress: (fraction) => post({ type: 'progress', fraction }),
    });
    post({ type: 'done', token });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : 'failed' });
  }
};
