# Native GPT compaction for VibeProxy

One native plugin; no extra process or CPA version constraint. It uses OpenAI's
in-band `compaction_trigger`, which works with the current ChatGPT credential.
The upstream standalone `/responses/compact` returned 404 in live checks.

- GPT `POST /v1/responses/compact` returns a native encrypted context through
  the working in-band path. Pass its entire `output` into the next request.
- Claude Code's automatic and manual `/compact` requests use the same native
  path when the selected model is GPT. Claude gets a short checkpoint marker;
  the next request restores the native context after CPA's own translation.
- Claude models keep CPA's built-in behavior. This plugin does not summarize
  their conversations.

Checkpoints live in `~/.cli-proxy-api/native-compaction/` as private JSON files.
They survive plugin reloads and proxy restarts. Each requires its original GPT
model and credential. Missing or incompatible checkpoints cause an explicit
error. Keep these files when resuming compacted Claude Code chats.

Build with `cargo build --release`. Install `target/release/libcpa_native_compaction.dylib`
as `~/.cli-proxy-api/plugins/darwin/arm64/cpa-native-compaction-v0.1.2.dylib`.
Enable in `config.yaml` and `merged-config.yaml`:

```yaml
cpa-native-compaction:
  enabled: true
  priority: 177
```

For rollback, set `enabled: false` in both files. Resume existing checkpoint
chats only with the plugin enabled; their markers are not text summaries.

Claude Code uses VibeProxy directly through `~/.claude/settings.json`:

```sh
claude --model gpt-6.1-sol
```

The settings contain `ANTHROPIC_BASE_URL=http://127.0.0.1:8318` and 900k
windows for Codex models. No gateway key is set, so the saved Claude.ai login
and cloud connectors stay active. Claude models keep
their default windows. Claude Code handles `/compact`
and automatic compaction. No Clodex daemon, HTTPS proxy, or startup hook is used.
VibeProxy selects its saved upstream credentials. See
`~/.claude/docs/vibeproxy.md` for client setup.
