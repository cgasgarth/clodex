type WorkerRequest = {
  type: 'rewrite';
  id: number;
  body: Uint8Array;
};

type WorkerCloseRequest = { type: 'close' };
type WorkerMessage = WorkerRequest | WorkerCloseRequest;

const workerId = crypto.randomUUID();

process.on('message', (message: WorkerMessage) => {
  if (message.type === 'close') {
    process.disconnect?.();
    process.exit(0);
  }
  const request = JSON.parse(new TextDecoder().decode(message.body)) as {
    delayMs?: number;
    exitCode?: number;
  };
  if (request.exitCode !== undefined) process.exit(request.exitCode);
  const delayMs = Math.max(0, request.delayMs ?? 0);
  const deadline = performance.now() + delayMs;
  while (performance.now() < deadline) {
    // Deliberately model Secondwind's synchronous native rewrite call.
  }
  const body = new TextEncoder().encode(JSON.stringify({ ...request, workerId }));
  process.send?.({ type: 'result', id: message.id, body });
});

process.on('disconnect', () => process.exit(0));
