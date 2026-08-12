---
name: install-clodex
description: Install or update Claude Code and Clodex from this repository, configure provider sign-in and favorite models when requested, patch Claude Code for Clodex models, and verify the installation. Use for requests such as /install-clodex, install Clodex, update Clodex, install the compatible Claude version, repair a local Clodex installation, or set up Claude Code to use Clodex. Never start, stop, install, uninstall, or restart the Clodex daemon unless the user explicitly asks for that daemon action.
---

# Install Clodex

Install the repository checkout and its exact supported Claude Code version. Preserve user credentials, favorites, aliases, settings, logs, and daemon state.

## Safety boundary

- Do not run `clodex daemon start`, `stop`, `restart`, `install`, or `uninstall`.
- Do not run `clodex start`, `clodex stop`, `launchctl`, or another service-management command.
- Change daemon state only when the user explicitly requests that exact action.
- Installing new Clodex files does not authorize a daemon restart. Tell the user that a running daemon keeps its loaded version until a later user-requested restart or normal process restart.
- Do not remove credentials, provider records, favorites, aliases, backups, or `~/.clodex` data.
- Do not use `claude update`; it can install a version that the current patcher does not support.

## Install workflow

1. Read the repository-root `AGENTS.md` and `CLAUDE.md` completely.
2. Confirm the checkout is the intended Clodex repository. Inspect `git status` and preserve unrelated changes.
3. Read `packageManager` from `package.json` and `SUPPORTED_CLAUDE_CODE_VERSION` from `src/patcher.ts`. Treat both as authoritative.
4. Inspect, without changing state:
   - `bun --version`
   - `claude --version`, when present
   - `clodex --version`, when present
   - `clodex daemon status`, only as a read-only status check
5. Install dependencies with `bun install --frozen-lockfile`.
6. Run `bun run check:ci`. Stop and report any failure before installing global files.
7. Install this checkout with `bun run install:global`. Do not substitute a registry package when the user asks to install this repository checkout.
8. If Claude Code is absent or has a different version, install the exact version from `SUPPORTED_CLAUDE_CODE_VERSION` with Anthropic's native installer:
   - macOS, Linux, or WSL: `curl -fsSL https://claude.ai/install.sh | bash -s VERSION`
   - Windows PowerShell: `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) VERSION`
   Replace `VERSION` with the exact repository-supported value. Do not install `latest` or `stable` in its place.
9. Verify that `claude --version` and the patcher's supported version match exactly. Stop before patching if they differ.

## Provider and model setup

Do these steps only when the user requests setup or the installation has no usable provider/model configuration.

1. Show current state with `clodex providers list` and `clodex models --list`.
2. Ask the user which supported authentication flow to use when it is not already clear:
   - `clodex providers auth openai` for ChatGPT/Codex subscription OAuth.
   - `clodex providers auth xai` for SuperGrok subscription OAuth.
   - `clodex providers add` for an OpenAI API key.
3. For device login, keep the command running, give the user the exact trusted URL and complete code, and wait for approval.
4. Use `clodex models` to add requested favorites. Add aliases only when requested.
5. Never print or store access tokens outside the credential store.

## Patch and verify

1. Require at least one saved favorite before patching.
2. Run `clodex patch`. The patcher must use its pristine backup and exact-version checks; never edit the Claude binary directly.
3. Verify:
   - `clodex --version`
   - `claude --version`
   - `clodex providers list`
   - `clodex models --list`
   - a second `clodex patch` reports the current patch or a safe no-op
4. Do not launch Claude or send a paid model request unless the user asks for a live smoke test.
5. Report installed versions, configured provider/model names, patch status, validation results, and unchanged daemon status.
