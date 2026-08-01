import { describe, expect, it } from 'bun:test';
import {
  estimatedRebasedInputTokens,
  planResponsesOverflowRecovery,
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
});
