import { Session } from 'secondwind';

type WorkerRequest = {
  type: 'rewrite';
  id: number;
  sessionKey?: string;
  body: Uint8Array;
};

type WorkerCloseRequest = { type: 'close' };

type WorkerMessage = WorkerRequest | WorkerCloseRequest;

const sessions = new Map<string, Session>();

function send(message: Parameters<NonNullable<typeof process.send>>[0]): void {
  process.send?.(message);
}

function closeSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

process.on('message', (message: WorkerMessage) => {
  if (message.type === 'close') {
    closeSessions();
    process.disconnect?.();
    process.exit(0);
  }

  let session = message.sessionKey ? sessions.get(message.sessionKey) : undefined;
  const sessionReused = message.sessionKey ? session !== undefined : undefined;
  try {
    if (!session) {
      session = new Session();
      if (message.sessionKey) sessions.set(message.sessionKey, session);
    }
    // SAFETY: The parent sends a serialized request accepted by Session.rewrite.
    const request = JSON.parse(
      new TextDecoder().decode(message.body),
    ) as Parameters<Session['rewrite']>[0];
    const result = session.rewrite(request);
    const body = new TextEncoder().encode(JSON.stringify(result.request));
    send({
      type: 'result',
      id: message.id,
      body,
      stats: result.stats,
      sessionReused,
      sessionCount: sessions.size,
      rssBytes: process.memoryUsage().rss,
    });
  } catch (error) {
    if (message.sessionKey) {
      session?.close();
      sessions.delete(message.sessionKey);
    }
    send({
      type: 'result',
      id: message.id,
      sessionReused,
      sessionCount: sessions.size,
      rssBytes: process.memoryUsage().rss,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!message.sessionKey) session?.close();
  }
});

process.on('disconnect', () => {
  closeSessions();
  process.exit(0);
});
