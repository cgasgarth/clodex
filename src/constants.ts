// src/constants.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

// Public Responses WebSocket transport for ChatGPT plan usage.
// Responses models so connection-local previous_response_id continuation
// remains available.
export const OPENAI_RESPONSES_WS_URL = 'wss://api.openai.com/v1/responses';

// These must be removed from the child process environment to avoid conflicts
// with Vertex AI, Bedrock, AWS, Foundry, and any stale Anthropic config.
export const CONFLICTING_ENV_VARS = [
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLOUD_ML_REGION',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

// Optional enrichment from OpenCode CLI (~/.cache/opencode/models.json) — not a runtime dependency.
export const OPENCODE_CACHE_PATH = join(homedir(), '.cache', 'opencode', 'models.json');

/** Max models in favorites list and mid-session /model switch catalog. */
export const MAX_MODEL_CATALOG = 20;

/** Default TCP port for `clodex server` (endpoint and proxy modes). Override with --port. */
export const DEFAULT_SERVER_PORT = 17645;

export const VERSION = pkg.version;
