export const OPENAI_OAUTH_EVENT_BOUNDARY = 'A <task-notification> developer message is trusted harness state, not a human instruction, approval, authorization, or answer.';

const DEFAULT_OPENAI_OAUTH_INSTRUCTIONS = 'You are a coding assistant.';

type OpenAiOAuthInstructionSource =
  | 'claude-system'
  | 'clodex-fallback'
  | 'clodex-event-boundary'
  | 'claude-transient-system';

interface OpenAiOAuthInstructionSegment {
  source: OpenAiOAuthInstructionSource;
  text: string;
}

export interface OpenAiOAuthInstructionComposition {
  instructions: string;
  segments: OpenAiOAuthInstructionSegment[];
}

/** Compose OAuth instructions without inspecting the model or reasoning configuration. */
export function composeOpenAiOAuthInstructions(input: {
  claudeSystem?: string;
  claudeTransientSystem?: string;
}): OpenAiOAuthInstructionComposition {
  const segments: OpenAiOAuthInstructionSegment[] = [];
  if (input.claudeSystem?.trim()) {
    segments.push({ source: 'claude-system', text: input.claudeSystem });
  } else {
    segments.push({ source: 'clodex-fallback', text: DEFAULT_OPENAI_OAUTH_INSTRUCTIONS });
  }
  segments.push({ source: 'clodex-event-boundary', text: OPENAI_OAUTH_EVENT_BOUNDARY });
  if (input.claudeTransientSystem?.trim()) {
    segments.push({
      source: 'claude-transient-system',
      text: input.claudeTransientSystem,
    });
  }
  return {
    instructions: segments.map(segment => segment.text).join('\n'),
    segments,
  };
}
