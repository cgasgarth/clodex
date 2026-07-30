# Persistent Clodex for workflows and background agents

Use one supervised Clodex daemon for terminal sessions, Claude Code workflows,
subagents, agent teams, and background sessions. This keeps OpenAI WebSocket
continuation pools and compaction checkpoints in one process instead of
creating a proxy per Claude session.

## Architecture

```mermaid
flowchart LR
  TUI["clodex Ink dashboard"] -->|"Unix control socket"| D["Clodex daemon"]
  MAIN["Claude main session"] -->|"Anthropic-format endpoint + signed launch ticket"| D
  MAIN -->|"CLAUDE_CODE_PROCESS_WRAPPER"| CHILD["Workflows / subagents / background Claude"]
  CHILD -->|"inherits the same ticket"| D
  D -->|"optional off / shadow / on rewrite"| SW["Secondwind middleware"]
  SW --> D
  D --> WS["Shared OpenAI WebSocket pools"]
  D --> METRICS["Content-free metrics + diagnostics"]
```

- The Clodex daemon owns one Anthropic-format endpoint, OpenAI WebSocket pools,
  compaction checkpoints, session registry, metrics, diagnostics, and optional
  in-process Secondwind rewriting.
- The endpoint listens on restart-stable loopback port `17647`. Set
  `CLODEX_DAEMON_PORT` before installation to change it.
- Control operations use `~/.clodex/clodex.sock`, mode `0600`.
- `clodex-claude` obtains a signed launch ticket and sends it in
  `x-clodex-launch-ticket` beside a stable local API key. Claude-spawned
  children inherit that ticket, so a workflow stays on the same account as
  its parent without generating a new custom-key approval prompt.
- Account selection affects new launches only. There is no quota/auth/capacity
  failover.

## Setup on macOS

```bash
clodex providers auth openai   # first ChatGPT/Codex login
clodex daemon install          # install and start the LaunchAgent
clodex daemon status
```

Use `clodex-claude` for terminal launches:

```bash
clodex-claude
clodex-claude --resume <session>
clodex-claude --clodex-account person@example.com
```

`clodex claude …` is the higher-level equivalent: it starts the daemon when
needed, launches through the shared endpoint, and automatically points
Claude-spawned children at `clodex-claude`.

Set Claude Code's process wrapper to the absolute `clodex-claude` path so
workflows, subagents, and background sessions use the same daemon:

```bash
export CLAUDE_CODE_PROCESS_WRAPPER="/absolute/path/to/clodex-claude"
```

The wrapper must ultimately `exec` Claude. If a stable shell launcher is needed,
keep its final command in this form:

```sh
exec /absolute/path/to/bun /absolute/path/to/clodex/dist/claude-wrapper.js "$@"
```

Do not point `CLAUDE_CODE_PROCESS_WRAPPER` at a short-lived version-manager
shim. Verify the exact path from a minimal environment before relying on
background agents.

## TUI and service commands

Bare `clodex` starts the daemon when needed, then opens the Ink dashboard.
`clodex start` starts it without opening the dashboard, and `clodex stop`
stops it.

- `1`–`5`: switch Overview, Usage, Accounts, Diagnostics, and Secondwind views
- Usage: `Tab` changes range; `←`/`→` changes period
- Accounts: `↑`/`↓` chooses; `Enter` selects; `l` logs in; `x x` logs out
- Secondwind: `←`/`→` changes mode; `o`, `s`, and `n` select off, shadow, and on
- `r`: refresh
- `q`: quit the dashboard; the daemon keeps running

Service commands:

```bash
clodex daemon status
clodex daemon restart
clodex daemon logs
clodex daemon stop
clodex daemon uninstall
```

On non-macOS systems, run `clodex daemon run` under the user's service manager.

## Accounts

The first existing `openai-oauth` login is migrated into the account list.
Additional logins use independent OS-credential-store entries:

```bash
clodex accounts add
clodex accounts list
clodex accounts select person@example.com
clodex accounts remove person@example.com
```

The dashboard and CLI identify accounts only by their OpenAI sign-in email.
Clodex stores only account metadata in `~/.clodex/accounts.json`; OAuth secrets
remain in the configured credential store. A signed ticket pins each launch.
Removing or losing that credential makes the pinned session fail explicitly—it
does not use a different account.

## Metrics and privacy

`~/.clodex/daemon-metrics.sqlite` contains timestamps, model/provider ids,
hashed session ids, token counts, latency, and completion/error/cancellation
state. It never stores prompts, tool output, response text, OAuth tokens, or
launch tickets. The database is mode `0600` and retains 400 days. The TUI
offers day, week, and month token and API-equivalent cost views.

## Troubleshooting

- `clodex daemon status`: process, endpoint, WebSocket, and active-session state.
- `clodex daemon logs`: daemon stdout/stderr and inference log paths.
- `clodex-claude --check`: exits `0` when a discovered server is reachable.
- `CLODEX_REQUIRE_SERVER=1`: fail closed instead of launching unbridged Claude.
- Port occupied: set `CLODEX_DAEMON_PORT` to a free stable port, then reinstall
  the LaunchAgent.
- Wrapper fails only for spawned agents: use absolute wrapper and Bun paths; do
  not remove the launcher's final `exec`.
