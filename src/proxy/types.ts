// Shared types for Anthropic ↔ upstream proxy translation.
import type { DiagnosticRecord, DiagnosticValue } from '../observability/trace-log.js';

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: DiagnosticRecord;
  /** When true, tool is discovered via tool search instead of loaded upfront. */
  defer_loading?: boolean;
  /** Anthropic tool-search tool types (e.g. tool_search_tool_regex_20251119). */
  type?: string;
  /** Server-side web-search controls. */
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: {
    type?: string;
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
}

export interface AnthropicRequestMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicRequestContentPart[];
}

type AnthropicRequestContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input?: DiagnosticRecord }
  | { type: 'tool_result'; tool_use_id: string; content: DiagnosticValue }
  | { type: 'tool_reference'; tool_name: string }
  | { type: 'image'; source: AnthropicImageSource };

type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };
