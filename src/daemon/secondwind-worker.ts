import { Session } from 'secondwind';

type WorkerRequest = {
  type: 'rewrite';
  id: number;
  body: Uint8Array;
};

type WorkerCloseRequest = { type: 'close' };

type WorkerMessage = WorkerRequest | WorkerCloseRequest;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

process.on('message', (message: WorkerMessage) => {
  if (message.type === 'close') {
    process.disconnect?.();
    process.exit(0);
  }

  let session: Session | undefined;
  try {
    session = new Session();
    const request = JSON.parse(new TextDecoder().decode(message.body)) as Record<string, unknown>;
    const result = session.rewrite(request);
    const body = new TextEncoder().encode(JSON.stringify(result.request));
    send({
      type: 'result',
      id: message.id,
      body,
      stats: result.stats,
    });
  } catch (error) {
    send({
      type: 'result',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    session?.close();
  }
});

process.on('disconnect', () => process.exit(0));
