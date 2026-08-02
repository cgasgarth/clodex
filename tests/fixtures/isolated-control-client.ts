const socketPath = process.argv[2];
if (!socketPath) throw new Error('socket path is required');

await Bun.sleep(100);
const startedAt = performance.now();
const health = await fetch('http://clodex.local/v1/health', {
  unix: socketPath,
  signal: AbortSignal.timeout(750),
});
const attach = await fetch('http://clodex.local/v1/launches/attach', {
  unix: socketPath,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(750),
});
console.log(JSON.stringify({
  durationMs: performance.now() - startedAt,
  healthStatus: health.status,
  health: await health.json(),
  attachStatus: attach.status,
  attach: await attach.json(),
}));
