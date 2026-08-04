type WorkerRequest = {
  type: 'rewrite';
  id: number;
  sessionKey?: string;
  body: Uint8Array;
};

type WorkerCloseRequest = { type: 'close' };
type WorkerMessage = WorkerRequest | WorkerCloseRequest;

const workerId = crypto.randomUUID();
const sessions = new Set<string>();

process.on('message', (message: WorkerMessage) => {
  if (message.type === 'close') {
    process.disconnect?.();
    process.exit(0);
  }
  const request = JSON.parse(new TextDecoder().decode(message.body)) as {
    delayMs?: number;
    exitCode?: number;
    rssBytes?: number;
  };
  if (request.exitCode !== undefined) process.exit(request.exitCode);
  const delayMs = Math.max(0, request.delayMs ?? 0);
  const deadline = performance.now() + delayMs;
  while (performance.now() < deadline) {
    // Deliberately model Secondwind's synchronous native rewrite call.
  }
  const sessionReused = message.sessionKey ? sessions.has(message.sessionKey) : undefined;
  if (message.sessionKey) sessions.add(message.sessionKey);
  const body = new TextEncoder().encode(JSON.stringify({ ...request, workerId }));
  process.send?.({
    type: 'result',
    id: message.id,
    body,
    sessionReused,
    sessionCount: sessions.size,
    rssBytes: request.rssBytes ?? process.memoryUsage().rss,
  });
});

process.on('disconnect', () => process.exit(0));
