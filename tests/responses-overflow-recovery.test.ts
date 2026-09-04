import { describe, expect, it } from 'bun:test';
import {
  estimatedRebasedInputTokens,
  planResponsesOverflowRecovery,
  recentDependencySafeWindow,
  ResponsesOverflowRecoverySession,
  runProgressiveOverflowRecovery,
} from '../src/oauth/responses-overflow-recovery.js';

const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const assistant = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
const call = (id: string) => ({
  type: 'function_call',
  call_id: id,
  name: 'Bash',
  arguments: '{}',
});
const output = (id: string, value = 'ok') => ({
  type: 'function_call_output',
  call_id: id,
  output: value,
});

describe('Responses oversized-context recovery planner', () => {
  it('selects a recent dependency-safe window within the stored input size', () => {
    const fullInput = [
      user('old'.repeat(400)),
      assistant('old answer'.repeat(200)),
      user('recent'.repeat(120)),
      call('recent'),
      output('recent', 'result'.repeat(120)),
      user('latest'.repeat(120)),
    ];
    const window = recentDependencySafeWindow(fullInput, 1_000, 10_000);

    expect(window).toBeDefined();
    expect(window!.estimatedInputTokens).toBeLessThanOrEqual(1_000);
    expect(window!.input[0]).toEqual(fullInput[2]);
    expect(window!.input).toContainEqual(call('recent'));
    expect(window!.input).toContainEqual(output('recent', 'result'.repeat(120)));
    expect(window!.droppedItems).toBe(2);
  });

  it('prefers an exact live boundary and keeps the latest call/output tail intact', () => {
    const prefix = [user('start'), assistant('inspect'), call('old'), output('old')];
    const tail = [
      { type: 'reasoning', encrypted_content: 'opaque' },
      call('current'),
      output('current', 'x'.repeat(40_000)),
    ];
    const fullInput = [...prefix, ...tail];
    const plan = planResponsesOverflowRecovery({
      fullInput,
      sources: [{
        kind: 'live_head',
        prefix,
        tail,
        prefixInputTokens: 90_000,
      }],
      compactThreshold: 115_200,
      contextWindow: 128_000,
      maxCandidates: 2,
    });

    expect(plan.candidates[0]).toMatchObject({
      source: 'live_head',
      prefix,
      tail,
      estimatedPrefixTokens: 90_000,
    });
    expect(plan.candidates[0]?.tail).toEqual(tail);
  });

  it('rejects a cut that separates a tool output from its producer', () => {
    const prefix = [user('start'), call('crossed')];
    const tail = [output('crossed', 'large result')];
    const plan = planResponsesOverflowRecovery({
      fullInput: [...prefix, ...tail],
      sources: [{
        kind: 'live_head',
        prefix,
        tail,
        prefixInputTokens: 90_000,
      }],
      compactThreshold: 115_200,
      contextWindow: 128_000,
      maxCandidates: 1,
    });

    expect(plan.candidates.some(candidate => candidate.source === 'live_head')).toBe(false);
    expect(plan.rejected).toContainEqual({
      source: 'live_head',
      reason: 'tool_dependency_crosses_cut',
    });
    expect(plan.candidates[0]).toMatchObject({
      source: 'inferred',
      prefix: [prefix[0]],
      tail: [prefix[1], tail[0]],
    });
  });

  it('infers a complete earlier model-output boundary when no native head survives', () => {
    const fullInput = [
      user('start'),
      assistant('first'),
      user('continue'),
      { type: 'reasoning', encrypted_content: 'latest' },
      call('latest'),
      output('latest', 'result'),
    ];
    const plan = planResponsesOverflowRecovery({
      fullInput,
      compactThreshold: 115_200,
      contextWindow: 128_000,
      maxCandidates: 2,
    });

    expect(plan.candidates[0]).toMatchObject({
      source: 'inferred',
      prefix: fullInput.slice(0, 3),
      tail: fullInput.slice(3),
    });
  });

  it('fails closed when the untouched tail alone cannot fit', () => {
    const prefix = [user('start')];
    const tail = [assistant('x'.repeat(600_000))];
    const plan = planResponsesOverflowRecovery({
      fullInput: [...prefix, ...tail],
      sources: [{
        kind: 'checkpoint',
        prefix,
        tail,
        prefixInputTokens: 1_000,
      }],
      compactThreshold: 115_200,
      contextWindow: 128_000,
      maxCandidates: 1,
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.rejected).toContainEqual({
      source: 'checkpoint',
      reason: 'tail_exceeds_context_window',
    });
  });

  it('plans thousands of inferred boundaries without quadratic transcript scans', () => {
    const fullInput = Array.from({ length: 7_500 }, (_, index) => (
      index % 2 === 0
        ? user(`user-${index}-${'u'.repeat(200)}`)
        : assistant(`assistant-${index}-${'a'.repeat(200)}`)
    ));
    const startedAt = performance.now();
    const plan = planResponsesOverflowRecovery({
      fullInput,
      compactThreshold: 265_000,
      contextWindow: 1_000_000,
      estimatedInputTokens: 3_250_000,
      maxCandidates: 2,
    });

    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(plan.rejected.length).toBeLessThanOrEqual(16);
    expect(plan.rejectedCount).toBeGreaterThan(plan.rejected.length);
  });

  it('accounts for compact output and untouched tail before replay', () => {
    const compacted = [{ type: 'compaction', encrypted_content: 'opaque' }];
    const tail = [assistant('result')];
    expect(estimatedRebasedInputTokens(
      compacted,
      tail,
      [user('full')],
      undefined,
      5_000,
    )).toBeGreaterThan(5_000);
  });

  it('plans every compaction stage from the prior canonical rebase', async () => {
    const fullInput = Array.from({ length: 12 }, (_, index) => (
      index % 2 === 0 ? user('u'.repeat(1_000)) : assistant('a'.repeat(1_000))
    ));
    const compactedPrefixes: unknown[][] = [];
    const result = await runProgressiveOverflowRecovery({
      fullInput,
      compactThreshold: 1_200,
      contextWindow: 10_000,
      estimatedInputTokens: 3_200,
      compactCandidate: async candidate => {
        compactedPrefixes.push(candidate.prefix);
        const canonical = [{ type: 'compaction', encrypted_content: `stage-${compactedPrefixes.length}` }];
        const input = [...canonical, ...candidate.tail];
        return {
          input,
          estimatedInputTokens: Math.max(1_000, 3_200 - compactedPrefixes.length * 1_100),
        };
      },
    });

    expect(result).toMatchObject({ recovered: true, reason: 'target_reached', stages: 2 });
    expect(compactedPrefixes).toHaveLength(2);
    expect(compactedPrefixes[1]?.[0]).toEqual({
      type: 'compaction',
      encrypted_content: 'stage-1',
    });
  });

  it('fails closed when a compaction stage does not reduce the estimated window', async () => {
    const fullInput = [user('start'), assistant('middle'), user('latest')];
    const result = await runProgressiveOverflowRecovery({
      fullInput,
      sources: [{
        kind: 'checkpoint',
        prefix: [fullInput[0]],
        tail: fullInput.slice(1),
        prefixInputTokens: 50,
      }],
      compactThreshold: 100,
      contextWindow: 1_000,
      estimatedInputTokens: 500,
      compactCandidate: async candidate => ({
        input: [{ type: 'compaction', encrypted_content: 'no-progress' }, ...candidate.tail],
        estimatedInputTokens: 500,
      }),
    });

    expect(result).toMatchObject({
      recovered: false,
      reason: 'non_monotonic_progress',
      stages: 1,
    });
  });

  it('fails closed when an accepted fold remains above target and no safe prefix remains', async () => {
    const fullInput = [user('start'), assistant('middle'), user('latest')];
    let calls = 0;
    const result = await runProgressiveOverflowRecovery({
      fullInput,
      sources: [{
        kind: 'checkpoint',
        prefix: fullInput.slice(0, 2),
        tail: fullInput.slice(2),
        prefixInputTokens: 50,
      }],
      compactThreshold: 100,
      contextWindow: 1_000,
      estimatedInputTokens: 500,
      compactCandidate: async () => {
        calls += 1;
        return {
          input: [{ type: 'compaction', encrypted_content: 'only-fold' }],
          estimatedInputTokens: 400,
        };
      },
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      recovered: false,
      reason: 'no_dependency_safe_prefix',
      estimatedInputTokens: 400,
    });
  });

  it('accepts the eighth and final stage when it reaches the target', async () => {
    const fullInput = Array.from({ length: 20 }, (_, index) => (
      index % 2 === 0
        ? user(`user-${index}-${'u'.repeat(400)}`)
        : assistant(`assistant-${index}-${'a'.repeat(400)}`)
    ));
    let calls = 0;
    const result = await runProgressiveOverflowRecovery({
      fullInput,
      compactThreshold: 1_000,
      contextWindow: 10_000,
      maxCandidatesPerStage: 20,
      compactCandidate: async candidate => {
        calls += 1;
        return {
          // Keep the structural fixture stable so this unit test isolates the
          // loop boundary rather than candidate-shape convergence.
          input: [...candidate.prefix, ...candidate.tail],
          estimatedInputTokens: 1_800 - calls * 100,
        };
      },
    });

    expect(calls).toBe(8);
    expect(result).toMatchObject({
      recovered: true,
      reason: 'target_reached',
      stages: 8,
      estimatedInputTokens: 1_000,
    });
  });

  it('uses a dependency-safe prefix after the compact endpoint rejects a below-threshold estimate', async () => {
    const fullInput = [user('start'), assistant('middle'), user('latest')];
    const compactBodies: unknown[][] = [];
    const session = new ResponsesOverflowRecoverySession({
      requestUrl: 'https://example.test/responses',
      headers: {},
      payload: { model: 'gpt-5.6-sol', input: fullInput },
      compactThreshold: 1_000,
      contextWindow: 2_000,
      // SAFETY: The test fixture defines the asserted runtime shape.
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        // SAFETY: The test fixture defines the asserted runtime shape.
        const body = JSON.parse(String(init?.body)) as { input: unknown[] };
        compactBodies.push(body.input);
        return new Response(JSON.stringify({
          output: [{ type: 'compaction', encrypted_content: 'prefix-only' }],
          usage: { input_tokens: 80, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });

    const result = await session.recover({
      reason: 'compact_context_rejection',
      input: fullInput,
      estimatedInputTokens: 100,
      forceInitialCompaction: true,
    });

    expect(result.recovered).toBe(true);
    expect(compactBodies).toHaveLength(1);
    expect(compactBodies[0]).not.toEqual(fullInput);
    expect(compactBodies[0]).toEqual(fullInput.slice(0, 1));
  });

  it('enforces one compact-call cap and deadline across a recovery session', () => {
    let now = 1_000;
    const session = new ResponsesOverflowRecoverySession({
      requestUrl: 'https://example.test/responses',
      headers: {},
      payload: { model: 'gpt-5.6-sol', input: [] },
      compactThreshold: 1_000,
      contextWindow: 2_000,
      maxCompactCalls: 2,
      deadlineMs: 100,
      compactTimeoutMs: 1_000,
      now: () => now,
    });

    expect(session.claimCompactionCall()).toEqual({ ok: true, attempt: 1, timeoutMs: 100 });
    now += 101;
    expect(session.claimCompactionCall()).toEqual({ ok: false, reason: 'deadline' });
    expect(session.attemptCount).toBe(1);
  });

  it('reserves recovery time for the final model create', () => {
    let now = 1_000;
    const session = new ResponsesOverflowRecoverySession({
      requestUrl: 'https://example.test/responses',
      headers: {},
      payload: { model: 'gpt-5.6-sol', input: [] },
      compactThreshold: 1_000,
      contextWindow: 2_000,
      deadlineMs: 1_000,
      finalCreateReserveMs: 200,
      now: () => now,
    });

    expect(session.admitFinalCreate()).toEqual({ ok: true, remainingMs: 1_000 });
    now += 801;
    expect(session.admitFinalCreate()).toEqual({
      ok: false,
      reason: 'final_create_reserve',
      remainingMs: 199,
    });
  });

  for (const failure of [
    { name: 'auth', status: 401, body: { error: { type: 'authentication_error', code: 'invalid_api_key' } } },
    { name: 'capacity', status: 429, body: { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' }, usage: { input_tokens: 17, output_tokens: 2 } } },
    { name: 'server', status: 503, body: { error: { type: 'server_error', code: 'internal_server_error' } } },
    { name: 'other 4xx', status: 422, body: { error: { type: 'invalid_request_error', code: 'invalid_input' } } },
    { name: 'invalid output', status: 200, body: {} },
  ] as const) {
    it(`does not try alternate prefixes after a ${failure.name} compact failure`, async () => {
      let calls = 0;
      const session = new ResponsesOverflowRecoverySession({
        requestUrl: 'https://example.test/responses',
        headers: {},
        payload: { model: 'gpt-5.6-sol', input: [] },
        compactThreshold: 1_000,
        contextWindow: 2_000,
        // SAFETY: The test fixture defines the asserted runtime shape.
        fetch: (async () => {
          calls += 1;
          return new Response(JSON.stringify(failure.body), {
            status: failure.status,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      });

      await expect(session.recover({
        reason: 'response_context_rejection',
        input: [user('first'), assistant('second'), user('third')],
        estimatedInputTokens: 500,
        forceInitialCompaction: true,
      })).rejects.toMatchObject({
        failureClass: failure.name === 'auth'
          ? 'auth'
          : failure.name === 'capacity'
            ? 'rate_limit_or_capacity'
            : failure.name === 'server'
              ? 'server'
              : failure.name === 'other 4xx' ? 'other_4xx' : 'invalid_response',
      });
      expect(calls).toBe(1);
      if (failure.name === 'capacity') {
        expect(session.usage).toMatchObject({ inputTokens: 17, outputTokens: 2 });
      }
    });
  }

  it('does not try alternate prefixes after a compact transport failure', async () => {
    let calls = 0;
    const session = new ResponsesOverflowRecoverySession({
      requestUrl: 'https://example.test/responses',
      headers: {},
      payload: { model: 'gpt-5.6-sol', input: [] },
      compactThreshold: 1_000,
      contextWindow: 2_000,
      // SAFETY: The test fixture defines the asserted runtime shape.
      fetch: (async () => {
        calls += 1;
        throw new Error('socket closed');
      }) as typeof fetch,
    });

    await expect(session.recover({
      reason: 'response_context_rejection',
      input: [user('first'), assistant('second'), user('third')],
      estimatedInputTokens: 500,
      forceInitialCompaction: true,
    })).rejects.toMatchObject({ failureClass: 'timeout_or_transport' });
    expect(calls).toBe(1);
  });
});
