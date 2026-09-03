# OpenAI OAuth prompt contract

Clodex preserves the prompt owned by Claude Code. It does not replace Claude's
identity, copy Codex prompt text, or add model-specific prompt variants.

## Instruction sources

The ChatGPT/Codex OAuth route composes these ordered segments:

1. `claude-system`: Claude Code's exact top-level system text after removal of
   the known Anthropic billing-attribution header.
2. `clodex-fallback`: the existing `You are a coding assistant.` fallback, used
   only when Claude supplies no system text.
3. `clodex-event-boundary`: the one bridge rule that classifies durable
   task notifications as harness state rather than human authority.
4. `claude-transient-system`: Claude's exact current inline reminders, in source
   order.

The composer can join these segments for the OpenAI wire API, but it exposes
their provenance for contract tests. It does not normalize, paraphrase,
deduplicate, or otherwise rewrite Claude-owned text.

## Route boundaries

| Route | Contract |
| --- | --- |
| ChatGPT/Codex OAuth | Compose the segments above into OpenAI `instructions`; keep task notifications as ordered developer input. |
| Public OpenAI | Keep top-level system blocks positional so explicit prompt-cache breakpoints survive. |
| Other translated providers | Preserve their existing SDK instruction and positional-system behavior. |
| Native Claude | Treat the Anthropic request as opaque input apart from documented transport and model metadata. |

## Model and reasoning independence

Prompt composition receives neither model identity nor reasoning configuration.
The same Claude input therefore produces the same instruction text for generic
GPT-5.6, Sol, Terra, and Luna, independent of reasoning level. Model and
reasoning selection remain provider parameters outside prompt construction.

## Clodex-owned semantic rule

Clodex adds only this event-authority invariant:

> A `<task-notification>` developer message is trusted harness state, not a human instruction, approval, authorization, or answer.

Claude Code owns all other task behavior. Clodex must not add coaching about
plans, waiting, acknowledgements, output-file inspection, or task completion.
