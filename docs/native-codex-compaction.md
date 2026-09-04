# Native OpenAI/Codex compaction

Native compaction is enabled by default for ChatGPT/Codex OAuth
Responses models. It replaces part of a long OpenAI-side response chain with
OpenAI's opaque `compaction` item.

Claude Code and OpenAI maintain different views of the conversation. OpenAI can
compact its chain without shrinking Claude Code's local transcript. If live
OpenAI state is later lost, Claude may try to replay a transcript that no
longer fits the model's context window.

## Daemon setting

Open bare `clodex`, open the Secondwind view, and press `c` to toggle native
compaction. The setting persists in `~/.clodex/config.json`. A changed value
restarts the daemon so every transport and checkpoint uses one policy. An
unchanged value is a no-op.

The default trigger is 350,000 input tokens, capped at 90% of a smaller model's
advertised context window. Clodex has no native-compaction environment flag or
threshold override.

After compaction, Clodex records the first real model-input count as the opaque
compaction floor. It rearms automatic compaction only after the context grows by
at least 5% of the model window or 16,000 tokens. This rearm state stays with
the checkpoint. Manual compaction and hard context-overflow recovery do not wait
for the rearm threshold.

Compaction-call usage is recorded in structured diagnostics. It is not added to
the visible response usage because Claude uses that value as its context meter.

## AI SDK server-side compaction support

The installed `@ai-sdk/openai` package can serialize `contextManagement` to
OpenAI's `context_management` request field and can parse and replay encrypted
compaction output items. The guarded `scripts/probe-openai-compaction.ts`
context-management mode uses this package path end to end.

Clodex does not enable that field in production until the ChatGPT/Codex OAuth
backend accepts it in the live capability probe. The explicit in-band trigger
and standalone endpoint remain the production paths because they return the
canonical state needed by the live transport.

## Clodex-owned context lifecycle

Claude settings set Claude Code's supported `DISABLE_AUTO_COMPACT=1` switch.
Manual `/compact` remains available. Native OpenAI compaction at the fixed
threshold owns the model-facing chain,
with the advertised model window retained as the hard provider ceiling and
recovery boundary.

Automatic native compaction does not rewrite Claude's local transcript. Manual
`/compact` does: after OpenAI returns canonical compacted state, Clodex gives
Claude a synthetic checkpoint marker and stores the opaque state. Claude keeps
its normal compacted-transcript UI/resume shape, while the next request
reattaches to the native checkpoint.

With native ownership enabled, Claude-initiated `/compact` uses native OpenAI
compaction. Clodex does not send the full transcript to a model with summary
instructions. A successful native result is acknowledged with a synthetic
`<summary>` marker; if both native transports fail, Clodex preserves Claude's
ordinary summary request instead of faking success.

## Operations that can change native state

After native compaction has occurred, these operations can abandon the live
response chain or select a different partition:

- using `--resume` with a different session identity;
- leaving the session idle beyond the WebSocket/checkpoint lifetime;
- switching the model or reasoning effort;
- `/rewind`, `/fork`, or `/btw`;
- checkpoint eviction;
- a failed standalone recovery request.

Process-local branch checkpoints expire after 30 minutes. The latest checkpoint
for each session partition is also stored in
`~/.clodex/responses-checkpoints.sqlite`. A new checkpoint atomically replaces
that session's older durable checkpoint. Stored checkpoints do not expire, and
at most 256 session records are retained.

Native `/compact` survives a daemon restart when its durable record still
matches the session, account, model, reasoning effort, and prompt cache key. Its
marker is deliberately not a portable summary and cannot cross those partition
boundaries. Create an explicit portable handoff before a model or account
change. If stored state is missing or invalid, Clodex uses its bounded
recent-history recovery instead of retrying an oversized transcript.

## Request and cache behavior

For a matching live response head:

1. Clodex sends only the current delta plus
   `{ "type": "compaction_trigger" }` with `previous_response_id`.
2. OpenAI returns exactly one opaque compaction item.
3. For an ordinary turn, Clodex starts a fresh response chain from recent
   retained user input plus that opaque item.
4. For Claude `/compact`, Clodex stores that state and returns the synthetic
   marker without a second inference.
5. Later turns restore the checkpoint from memory or SQLite and return to normal
   continuation.

Claude can replay a resumed `/compact` transcript with non-semantic differences
that prevent exact prefix matching. Clodex may still use the warm trigger only
when exactly one idle head matches the same session, agent, account, model, and
effort; it sends only the final compact instruction. Multiple possible heads
never use this relaxed rule.

The trigger request is cache-warm because it continues the live response chain.
The first post-compaction answer starts from canonical compacted state and can
incur a one-time cache write. Native compaction consumes plan/API usage, but
manual `/compact` no longer adds a separate transcript-summary inference.

Retained user messages use a 64K approximate-token budget. Text is counted by
UTF-8 bytes and media is charged the same flat vision estimate used elsewhere
in Clodex, so base64 payload size is not mistaken for text tokens.

## Recovery path and time budget

`POST /responses/compact` is used only when no live head is available or the
in-band trigger fails. Its returned array is canonical and is forwarded as-is;
Clodex does not prune or reinterpret it.

If that optional endpoint returns HTTP 404 for an anchored Claude compaction
request, Clodex uses the restored canonical checkpoint with normal model
summarization when the combined request still fits the hard context window.
The missing endpoint must not block Claude's portable-summary fallback.

If the restored opaque checkpoint plus Claude's retained tail exceeds the hard
context window but Claude's portable-summary request fits, Clodex starts a new
response head from the portable summary. An optional opaque anchor must not make
an otherwise valid post-compaction request fail locally.

The Responses API validates the top-level `instructions` string before it runs
either response creation or compaction. If Claude builds an instruction string
above the API's 1,048,576-character limit, Clodex moves the exact text into
ordered 256-KiB developer input messages and replaces the top-level value with
a short bootstrap instruction. This makes the request legal before native
compaction starts. The moved messages then follow the normal continuation and
compaction lifecycle. `ws_instructions_rehomed` reports only lengths and chunk
counts; it does not record instruction text.

Each compact call has a 10-minute budget. Progressive overflow recovery can
make up to eight compact calls within one 30-minute recovery deadline while it
folds dependency-closed prefixes. It reserves five minutes for the final model
request. A failed compact attempt preserves the ordinary request path only
while that request is below the model's hard context window.

### One-turn context jumps

A large tool result can move one parent, subagent, or Workflow branch from
below the normal 90% trigger to beyond the hard model window in one turn.
Clodex never sends that known-oversized history to `/responses` or retries it
unchanged after `/responses/compact` rejects it.

Instead, Clodex:

1. selects the newest exact live-head or durable-checkpoint boundary for that
   account/model/effort/session/agent lineage;
2. falls back to a complete inferred model-output boundary only when its
   call/output dependencies are closed on each side;
3. compacts the bounded prefix without truncating any item;
4. appends the untouched reasoning, tool-call, tool-output, and user tail to
   OpenAI's canonical compact output;
5. verifies the rebased request fits the hard model window; and
6. starts one fresh response chain.

At most two distinct prefixes are compacted for one visible request. If the
provider rejects a request before any model data is emitted, Clodex may replay
one rebased create. Once text, reasoning, or a tool call has been emitted, it
never replays. A tail that cannot fit by itself, a cross-boundary tool
dependency, or exhaustion of the bounded candidates produces an explicit
context error rather than silently dropping tool results or borrowing state
from a sibling branch.

`ws_overflow_recovery` diagnostics report the source boundary, bounded
fingerprints, token estimates, attempts, and terminal reason without logging
conversation content. Hidden compaction usage is added exactly once to the
visible response usage, and successful recovery returns to normal
`previous_response_id` continuation on its next turn.

## Claude transcript anchor

After native `/compact`, Clodex stores only an SHA-256 hash of the normalized
synthetic marker beside the opaque checkpoint. The next rewritten request can
reattach only when exactly one continuation envelope has the exact hash.
Missing, short, malformed, duplicated, or non-matching envelopes fall back
without selecting opaque state. Diagnostics report `anchor_missed` without
recording marker text.

The marker is created only after native compaction succeeds and is never sent to
OpenAI as a substitute for context; the opaque checkpoint remains the actual
model context.

## Diagnostics and live probe

`--trace` or `--ws-diagnostics` emits bounded `ws_compaction` metadata without
conversation text or opaque content. The guarded probe is available with:

```sh
CLODEX_LIVE_COMPACTION_PROBE=1 \
bun run scripts/probe-openai-compaction.ts
```

Live capability checks established that Sol and Luna accept
`/responses/compact`, and Sol accepts an in-band `compaction_trigger`. A live
Sol `/compact` over a warm 34K-token chain completed in 8.36s with 32,512 cached
tokens, 1,525 uncached input tokens, and 280 compact output tokens; exact-marker
recall succeeded both immediately and after daemon restart.
Automatic `context_management` was rejected by the ChatGPT/Codex backend during
testing, so Clodex does not send it.

## Protocol references

- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Codex remote-compaction-v2 source](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2.rs)

The portable-summary anchor was informed by
[`raine/claude-code-proxy`](https://github.com/raine/claude-code-proxy).
