import { describe, expect, it } from 'bun:test';
import {
  composeOpenAiOAuthInstructions,
  OPENAI_OAUTH_EVENT_BOUNDARY,
} from '../src/openai-oauth-instructions.js';

describe('composeOpenAiOAuthInstructions', () => {
  it('preserves Claude-owned segments exactly and exposes their provenance', () => {
    const claudeSystem = 'You are Claude Code.\n\n  Preserve this spacing.  ';
    const transient = '<system-reminder>exact reminder</system-reminder>\n';
    const composition = composeOpenAiOAuthInstructions({
      claudeSystem,
      claudeTransientSystem: transient,
    });

    expect(composition.segments).toEqual([
      { source: 'claude-system', text: claudeSystem },
      { source: 'clodex-event-boundary', text: OPENAI_OAUTH_EVENT_BOUNDARY },
      { source: 'claude-transient-system', text: transient },
    ]);
    expect(composition.instructions).toBe(
      `${claudeSystem}\n${OPENAI_OAUTH_EVENT_BOUNDARY}\n${transient}`,
    );
  });

  it('uses the existing fallback without the removed behavioral policy', () => {
    const composition = composeOpenAiOAuthInstructions({});

    expect(composition.segments[0]).toEqual({
      source: 'clodex-fallback',
      text: 'You are a coding assistant.',
    });
    expect(composition.instructions.match(/<task-notification>/g)).toHaveLength(1);
    expect(composition.instructions).not.toContain('update your plan immediately');
    expect(composition.instructions).not.toContain('inspect <output-file>');
    expect(OPENAI_OAUTH_EVENT_BOUNDARY.length).toBeLessThanOrEqual(160);
  });
});
