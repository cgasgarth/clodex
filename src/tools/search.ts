// Tool-search helpers for Anthropic ↔ upstream proxy translation.
//
// Claude Code defers MCP tools (defer_loading: true) and discovers them via
// tool_reference blocks. Upstream models (Gemini, OpenAI) only receive tools
// that are immediately available: non-deferred, tool-search, and any tool
// already referenced in the conversation.

import { isObject, isString } from '../runtime/type-guards.js';
import type { AnthropicRequestMessage, AnthropicToolDefinition } from '../proxy/types.js';
import { diagnosticRecord } from '../observability/trace-log.js';

const TOOL_SEARCH_TYPE_PREFIX = 'tool_search_tool';

interface ToolSearchPayload {
  value: unknown;
}

export function isToolSearchTool(tool: AnthropicToolDefinition): boolean {
  if (isString(tool.type) && tool.type.startsWith(TOOL_SEARCH_TYPE_PREFIX)) return true;
  const name = tool.name;
  return name.includes('tool_search') || name === 'ToolSearch';
}

/** Collect tool names referenced anywhere in the message history. */
export function extractReferencedToolNames(messages: AnthropicRequestMessage[] | undefined): Set<string> {
  const names = new Set<string>();

  const addToolSearchReferences = (content: ToolSearchPayload['value']): void => {
    if (!content || !isObject(content)) return;
    const refs = diagnosticRecord(content).tool_references;
    if (!Array.isArray(refs)) return;
    for (const ref of refs) {
      if (!ref || !isObject(ref)) continue;
      const toolName = diagnosticRecord(ref).tool_name;
      if (isString(toolName)) names.add(toolName);
    }
  };

  const visitContent = (content: ToolSearchPayload['value']): void => {
    if (isString(content)) return;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!block || !isObject(block)) continue;
      const part = diagnosticRecord(block);

      if (part.type === 'tool_reference' && isString(part.tool_name)) {
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
