import { describe, expect, it } from 'bun:test';
import {
  ControlRequestDiagnostics,
  normalizeControlRoute,
} from '../src/daemon/control-diagnostics.js';
import type { DaemonDiagnostic } from '../src/daemon/collector.js';

describe('daemon control diagnostics', () => {
  it('normalizes dynamic and query values out of logged routes', () => {
    expect(normalizeControlRoute(
      'http://clodex.local/v1/accounts/private-account/select',
    )).toBe('/v1/accounts/:id/select');
    expect(normalizeControlRoute(
      'http://clodex.local/v1/metrics?accountId=private&end=secret&start=secret',
    )).toBe('/v1/metrics?accountId&end&start');
  });

  it('records a pending stall and eventual slow completion', async () => {
    const events: DaemonDiagnostic[] = [];
    const logs: string[] = [];
    const diagnostics = new ControlRequestDiagnostics({
      emit: event => events.push(event),
      log: message => logs.push(message),
      eventLoopSampleMs: 2,
      slowRequestMs: 5,
      stalledRequestMs: 10,
    });
    try {
      const response = await diagnostics.track(
        new Request('http://clodex.local/v1/status'),
        async () => {
          await Bun.sleep(20);
          return new Response('{}', { status: 200 });
        },
      );
      expect(response.status).toBe(200);
      expect(events.map(event => event.kind)).toEqual([
        'control_request_stalled',
        'control_request_slow',
      ]);
      expect(events[0]?.detail).toMatchObject({
        method: 'GET',
        route: '/v1/status',
        phase: 'pending',
        activeControlRequests: 1,
      });
      expect(events[1]?.detail).toMatchObject({
        route: '/v1/status',
        phase: 'completed',
        statusCode: 200,
      });
      expect(logs).toHaveLength(2);
    } finally {
      diagnostics.close();
    }
  });

  it('records thrown handlers without leaking the error message', async () => {
    const events: DaemonDiagnostic[] = [];
    const logs: string[] = [];
    const diagnostics = new ControlRequestDiagnostics({
      emit: event => events.push(event),
      log: message => logs.push(message),
      eventLoopSampleMs: 2,
      slowRequestMs: 100,
      stalledRequestMs: 100,
    });
    try {
      await expect(diagnostics.track(
        new Request('http://clodex.local/v1/accounts?token=private'),
        async () => { throw new TypeError('private failure text'); },
      )).rejects.toThrow('private failure text');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'control_request_failed',
        detail: {
          route: '/v1/accounts?token',
          phase: 'failed',
          errorType: 'TypeError',
        },
      });
      expect(JSON.stringify(events)).not.toContain('private failure text');
      expect(logs.join('\n')).not.toContain('private failure text');
    } finally {
      diagnostics.close();
    }
  });

  it('records event-loop stalls even when no control handler has started', async () => {
    const events: DaemonDiagnostic[] = [];
    const diagnostics = new ControlRequestDiagnostics({
      emit: event => events.push(event),
      log: () => {},
      eventLoopSampleMs: 2,
      eventLoopStallMs: 5,
      slowRequestMs: 100,
      stalledRequestMs: 100,
    });
    try {
      const stopAt = performance.now() + 15;
      while (performance.now() < stopAt) {
        // Deliberately block this isolated test's event loop.
      }
      await Bun.sleep(5);
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'daemon_event_loop_stall',
        detail: expect.objectContaining({
          activeControlRequests: 0,
          activeControlRoutes: [],
        }),
      }));
    } finally {
      diagnostics.close();
    }
  });
});
