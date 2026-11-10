// Edge Runtime entry point for the self-host stack: routes /{function}/... to the worker that
// serves supabase/functions/{function}. The gateway has already checked the API key (or the route
// is open on purpose, see volumes/api/kong.yml), so this does no JWT check of its own.
interface UserWorker {
  fetch(req: Request): Promise<Response>;
}
declare const EdgeRuntime: {
  userWorkers: { create(options: Record<string, unknown>): Promise<UserWorker> };
};

const NAME = /^[a-z][a-z0-9-]*$/;

Deno.serve(async (req: Request) => {
  const name = new URL(req.url).pathname.split('/')[1] ?? '';
  if (!NAME.test(name)) return Response.json({ code: 'not_found' }, { status: 404 });
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `/home/deno/functions/${name}`,
      memoryLimitMb: 150,
      workerTimeoutMs: 60_000,
      noModuleCache: false,
      importMapPath: null,
      envVars: Object.entries(Deno.env.toObject()),
    });
    return await worker.fetch(req);
  } catch (e) {
    console.error(`function ${name} failed to start`, e);
    const missing = e instanceof Deno.errors.InvalidWorkerCreation;
    return Response.json(
      { code: missing ? 'not_found' : 'function_error' },
      { status: missing ? 404 : 500 },
    );
  }
});
