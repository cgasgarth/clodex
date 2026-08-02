type WorkerRequest = {
  type: 'rewrite';
  id: number;
  body: ArrayBuffer;
};

const workerId = crypto.randomUUID();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const request = JSON.parse(new TextDecoder().decode(message.body)) as {
    delayMs?: number;
  };
  const delayMs = Math.max(0, request.delayMs ?? 0);
  const deadline = performance.now() + delayMs;
  while (performance.now() < deadline) {
    // Deliberately model Secondwind's synchronous native rewrite call.
  }
  const body = new TextEncoder().encode(JSON.stringify({
    ...request,
    workerId,
  })).buffer;
  self.postMessage({ type: 'result', id: message.id, body }, { transfer: [body] });
};
