// Tool-search helpers for Anthropic ↔ upstream proxy translation.
//
// Claude Code defers MCP tools (defer_loading: true) and discovers them via
// tool_reference blocks. Upstream models (Gemini, OpenAI) only receive tools
// that are immediately available: non-deferred, tool-search, and any tool
// already referenced in the conversation.

import type { AnthropicRequestMessage, AnthropicToolDefinition } from './proxy-types.js';

const TOOL_SEARCH_TYPE_PREFIX = 'tool_search_tool';

export function isToolSearchTool(tool: AnthropicToolDefinition): boolean {
  if (typeof tool.type === 'string' && tool.type.startsWith(TOOL_SEARCH_TYPE_PREFIX)) return true;
  const name = tool.name;
  return name.includes('tool_search') || name === 'ToolSearch';
}

/** Collect tool names referenced anywhere in the message history. */
export function extractReferencedToolNames(messages: AnthropicRequestMessage[] | undefined): Set<string> {
  const names = new Set<string>();

  const addToolSearchReferences = (content: unknown): void => {
    if (!content || typeof content !== 'object') return;
    const refs = (content as Record<string, unknown>).tool_references;
    if (!Array.isArray(refs)) return;
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue;
      const toolName = (ref as Record<string, unknown>).tool_name;
      if (typeof toolName === 'string') names.add(toolName);
    }
  };

  const visitContent = (content: unknown): void => {
    if (typeof content === 'string') return;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const part = block as Record<string, unknown>;

      if (part.type === 'tool_reference' && typeof part.tool_name === 'string') {
        names.add(part.tool_name);
      }

      if (part.type === 'tool_search_tool_result') addToolSearchReferences(part.content);

      if (part.type === 'tool_result' && part.content) {
        visitContent(part.content);
      }
    }
  };

  for (const msg of messages ?? []) {
    visitContent(msg.content);
  }

  return names;
}

/** Tools to forward upstream — deferred tools omitted until referenced. */
export function resolveUpstreamTools(
  tools: AnthropicToolDefinition[] | undefined,
  messages: AnthropicRequestMessage[] | undefined,
): AnthropicToolDefinition[] {
  if (!tools?.length) return [];

  const referenced = extractReferencedToolNames(messages);
  const upstream: AnthropicToolDefinition[] = [];

  for (const tool of tools) {
    if (isToolSearchTool(tool)) {
      upstream.push(tool);
      continue;
    }
    if (tool.defer_loading === true) {
      if (referenced.has(tool.name)) upstream.push(tool);
      continue;
    }
    upstream.push(tool);
  }

  return upstream;
}
