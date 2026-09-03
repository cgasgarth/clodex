# Clodex

[![npm version](https://img.shields.io/npm/v/%40cgasgarth%2Fclodex.svg)](https://www.npmjs.com/package/@cgasgarth/clodex)

Clodex runs OpenAI Codex and Grok 4.6 models in the unmodified Claude Code
client. One local daemon provides the Anthropic-compatible endpoint, model
routing, OpenAI WebSocket continuation, caching, native Codex compaction,
accounts, metrics, and diagnostics.

Claude Code keeps its normal terminal UI, tools, skills, hooks, MCPs, sessions,
subagents, workflows, and agent teams. Clodex does not patch the Claude binary
or pin a Claude Code version.

## Install

Clodex targets Bun 1.4.0.

```bash
bun add --global @cgasgarth/clodex
clodex providers auth openai
# Optional SuperGrok subscription:
# clodex providers auth xai
clodex models
clodex models --alias sol=clodex:openai-oauth:gpt-5.6-sol
clodex models --alias luna=clodex:openai-oauth:gpt-5.6-luna
clodex models --alias terra=clodex:openai-oauth:gpt-5.6-terra
```

For a local checkout, use `bun run install:global`. It installs the exact
checkout and verifies the installed runtime artifacts.

## Configure Claude Code once

Plain `claude` must start the real Anthropic Claude Code binary. Do not add a
shell alias or startup wrapper. Put the Clodex endpoint, model picker, child
process wrapper, and start hook in `~/.claude/settings.json`.

Create `~/.claude/hooks/ensure-clodex`:

```zsh
#!/bin/zsh
set -u

if clodex daemon status >/dev/null 2>&1; then
  exit 0
fi

clodex start >/dev/null
```

Make the hook executable:

```bash
chmod 700 ~/.claude/hooks/ensure-clodex
```

Merge these values into `~/.claude/settings.json`. Replace `/Users/you` with
your absolute home path. Keep other settings and hooks that you already use.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:17647/anthropic",
    "ANTHROPIC_API_KEY": "clodex",
    "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "DISABLE_AUTO_COMPACT": "1",
    "CLAUDE_CODE_PROCESS_WRAPPER": "/Users/you/.bun/bin/clodex-claude",
    "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT": "0",
    "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "900000",
    "CLODEX_REQUIRE_SERVER": "1",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "model": "sol",
  "modelPicker": {
    "options": [
      {
        "model": "sol[1m]",
        "label": "sol",
        "description": "GPT-5.6 Sol"
      },
      {
        "model": "luna[1m]",
        "label": "luna",
        "description": "GPT-5.6 Luna"
      },
      {
        "model": "terra[1m]",
        "label": "terra",
        "description": "GPT-5.6 Terra"
      }
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/you/.claude/hooks/ensure-clodex",
            "timeout": 10,
            "statusMessage": "Checking Clodex daemon"
          }
        ]
      }
    ]
  }
}
```

Claude Code requires a non-empty credential before it sends requests, so
`ANTHROPIC_API_KEY` is a fixed, non-secret client placeholder. The daemon
accepts requests only on its loopback endpoint and does not validate or require
that value. Do not configure `apiKeyHelper`.

Claude Code requires one approval before it uses the placeholder in interactive
sessions. Run `/config` once and set `Use custom API key: clodex` to `true`.
This choice persists for later terminal sessions.

The `SessionStart` hook checks health and starts Clodex only when needed. No
hook stops Clodex. The internal
`clodex-claude` process wrapper is only for Claude-spawned child processes; it
is not the terminal startup command.

Clodex sets `DISABLE_AUTO_COMPACT=1` and removes
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`. ChatGPT/Codex OAuth sessions use only native
Responses compaction, which runs before the model context limit and keeps opaque
reasoning state in the OpenAI response chain. This prevents Claude's portable
summary compactor from replacing or duplicating native compacted state.

Claude Code falls back to 200,000 tokens for unknown third-party model ids.
Clodex therefore gives every enabled model above 200,000 tokens a `[1m]` client
identity and sets the shared Claude-facing window to 1M. This also keeps direct
commands such as `/model sol` from falling back to 200K when Claude saves the
literal alias. Providers without native Clodex compaction no longer have a
Claude auto-compaction fallback and can return a context-limit error when their
own window is exhausted.

After this setup, use only:

```bash
claude        # real Claude Code binary with Clodex models
clodex        # start if needed and open the TUI dashboard
clodex start  # start without opening the dashboard
```

`clodex models` updates Claude's native `modelPicker.options`, shared context
identity, and native-only compaction settings after catalog changes. `/model`
selects the configured aliases in Claude Code.

## Native Codex compaction

Native Codex compaction is on by default for ChatGPT/Codex OAuth models. It
compacts the OpenAI response chain with an in-band `compaction_trigger` or
`POST /responses/compact`, and it keeps recovery checkpoints only in the
running Clodex process.

The default trigger is 350,000 input tokens, capped at 90% of the model's
advertised context window. There is no Clodex compaction environment flag or
threshold override.

Open bare `clodex`, switch to the Secondwind view, and press `c` to toggle
native compaction. A confirmed change persists in `~/.clodex/config.json` and
restarts the daemon so every WebSocket transport uses one policy. An unchanged
setting is a no-op. See the
[native compaction guide](docs/native-codex-compaction.md) for recovery and
context lifecycle details.

## Dashboard and daemon

Bare `clodex` opens five TUI views: Overview, Usage, Accounts, Diagnostics, and
Secondwind. Quitting the dashboard does not stop the daemon.

```bash
clodex
clodex start
clodex stop
clodex daemon status
clodex daemon restart
clodex daemon logs
clodex daemon install
clodex daemon uninstall
```

The Usage view reports input, cache reads, cache writes, output, cache share,
request status, and API-equivalent cost. The Accounts view shows subscription
limits and manual account selection. The Diagnostics view selects error-only or
full lifecycle logs. The Secondwind view controls tool-output optimization and
native Codex compaction.

The daemon listens on loopback port `17647` by default and uses an owner-only
Unix control socket. Metrics are retained for 400 days in owner-only SQLite and
do not contain prompts, tool output, response text, credentials, or launch
tickets.

## Accounts and providers

Clodex supports OpenAI API keys, ChatGPT/Codex OAuth, and SuperGrok OAuth.

```bash
clodex providers auth openai
clodex providers auth xai
clodex providers list
clodex accounts add openai
clodex accounts add xai
clodex accounts list
clodex accounts select person@example.com
clodex accounts usage
```

OAuth credentials remain in the OS credential store. On macOS, all accounts
share one Clodex Keychain item so the runtime needs one Keychain access
decision. Up to five accounts per subscription provider can be stored.
Selection is manual; Clodex does not fail over after quota, capacity, or
authentication errors.

## Models

Favorites and aliases are stored in `~/.clodex/config.json` and feed routing,
Claude's native `/model` picker, and subagent model selection.

```bash
clodex models
clodex models --list
clodex models --alias sol=clodex:openai-oauth:gpt-5.6-sol
clodex models --unalias sol
```

## Context, caching, and continuation

Clodex keeps cacheable prefixes stable across main sessions, workflows, and
subagents. OpenAI OAuth uses persistent Responses WebSockets with
`previous_response_id` continuation. State is isolated by account, model,
effort, Claude session, and agent lineage.

[Secondwind](https://github.com/orchetron/secondwind) can run `off`, `shadow`,
or `on`. It keeps unchanged request bytes when there is no rewrite and fails
open if optimization fails. Its selected daemon mode persists.

See [background agents](docs/background-agents.md) for child-process routing and
[native compaction](docs/native-codex-compaction.md) for checkpoint, overflow,
and recovery behavior.

## Standalone server

`clodex server` is for other Anthropic-format clients. It is separate from the
plain Claude Code setup above.

```bash
clodex server --endpoint --quick --providers favorites
clodex server --proxy
```

Endpoint mode exposes a local gateway. Proxy mode selectively reroutes saved
OpenAI and Grok models while an existing Claude client keeps its Anthropic
login. Run `clodex server --help` for listen, password, discovery, and provider
options.

## Configuration

- Clodex state lives under `~/.clodex`; `CLODEX_HOME` can move the complete
  Clodex home.
- `CLODEX_CREDENTIAL_HELPER` can select an absolute external credential helper;
  see [credential helpers](docs/credential-helpers.md).
- `CLODEX_DAEMON_PORT` can change the stable loopback daemon port before the
  service is installed. Keep `ANTHROPIC_BASE_URL` in Claude settings aligned.
- `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` apply to Clodex outbound traffic.

## Known limits

- Claude Code applies its own pricing table, so cost shown inside Claude Code is
  not authoritative for OpenAI or Grok models.
- Claude reads the context window at session start; a live `/model` switch does
  not change its displayed context limit.
- An oversized legacy transcript without a matching native checkpoint may need
  a new session from a portable handoff.
