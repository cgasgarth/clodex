import { Session } from 'secondwind';

type WorkerRequest = {
  type: 'rewrite';
  id: number;
  body: ArrayBuffer;
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  let session: Session | undefined;
  try {
    session = new Session();
    const request = JSON.parse(new TextDecoder().decode(message.body)) as Record<string, unknown>;
    const result = session.rewrite(request);
    const body = new TextEncoder().encode(JSON.stringify(result.request)).buffer;
    self.postMessage({
      type: 'result',
      id: message.id,
      body,
      stats: result.stats,
    }, { transfer: [body] });
  } catch (error) {
    self.postMessage({
      type: 'result',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    session?.close();
  }
};
