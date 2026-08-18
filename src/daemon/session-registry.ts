export interface DaemonSessionSnapshot {
  sessionHash: string;
  modelId: string;
  provider: string;
  lastActivityAt: string;
  activeRequests: number;
  completedRequests: number;
  cancelledRequests: number;
  failedRequests: number;
}

interface MutableSession extends DaemonSessionSnapshot {
  requestIds: Set<string>;
}

export class DaemonSessionRegistry {
  private readonly sessions = new Map<string, MutableSession>();

  requestStarted(
    sessionHash: string | undefined,
    requestId: string | undefined,
    modelId: string,
    provider: string,
    now = new Date(),
  ): void {
    if (!sessionHash) return;
    const session = this.sessions.get(sessionHash) ?? {
      sessionHash,
      modelId,
      provider,
      lastActivityAt: now.toISOString(),
      activeRequests: 0,
      completedRequests: 0,
      cancelledRequests: 0,
      failedRequests: 0,
      requestIds: new Set<string>(),
    };
    session.modelId = modelId;
    session.provider = provider;
    session.lastActivityAt = now.toISOString();
    if (requestId && !session.requestIds.has(requestId)) {
      session.requestIds.add(requestId);
      session.activeRequests += 1;
    }
    this.sessions.set(sessionHash, session);
  }

  requestFinished(
    sessionHash: string | undefined,
    requestId: string | undefined,
    outcome: 'completed' | 'cancelled' | 'failed',
    now = new Date(),
  ): void {
    if (!sessionHash) return;
    const session = this.sessions.get(sessionHash);
    if (!session) return;
    session.lastActivityAt = now.toISOString();
    if (!requestId || session.requestIds.delete(requestId)) {
      session.activeRequests = Math.max(0, session.activeRequests - 1);
    }
    if (outcome === 'failed') session.failedRequests += 1;
    else if (outcome === 'cancelled') session.cancelledRequests += 1;
    else session.completedRequests += 1;
  }

  snapshot(now = Date.now()): DaemonSessionSnapshot[] {
    const staleBefore = now - 24 * 60 * 60_000;
    for (const [key, session] of this.sessions) {
      if (session.activeRequests === 0 && Date.parse(session.lastActivityAt) < staleBefore) {
        this.sessions.delete(key);
      }
    }
    return [...this.sessions.values()]
      .toSorted((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
      .map(({ requestIds: _requestIds, ...session }) => Object.assign({}, session));
  }
}
