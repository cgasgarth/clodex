# Secondwind codec-stress benchmark

This initial screen checks whether Secondwind reduces representative tool
outputs without changing Luna's answer. It is a targeted codec test, not a
general coding benchmark.

## Method

- Model: GPT-5.6 Luna, medium reasoning
- Conditions: Secondwind off and on
- Repetitions: three fresh, non-persistent Claude sessions per task and condition
- Execution: nine sessions ran concurrently in each condition
- Grading: deterministic hidden checks against the exact expected edit
- Route: the shared Clodex daemon; the run fails if optimized traffic is not
  materially rewritten

The fixtures stay outside the agent-visible workspace and emit adversarial
near-matches. Their outputs fit within Claude Code's visible tool-output limit,
so the intended Secondwind codecs—not Claude's truncation fallback—handle them.

## Results

| Benchmark | Codec | Correct off | Correct on | Median total input off | Median total input on | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Null, empty, and absent values | SWNEST | 3/3 | 3/3 | 139,243 | 118,025 | −15.2% |
| Parent-child dependency join | SWNORM | 3/3 | 3/3 | 163,358 | 118,390 | −27.5% |
| Grouped path restoration | SWGRP | 3/3 | 3/3 | 125,869 | 119,206 | −5.3% |

Secondwind observed 56 optimized request frames, rewrote 42 blocks, and removed
23,992 of 53,178 measured tool-output tokens (45.1%). No optimized request
failed open.

| Benchmark | Median turns off / on | Median duration off / on |
| --- | ---: | ---: |
| Null, empty, and absent values | 6 / 6 | 24.2s / 25.4s |
| Parent-child dependency join | 7 / 6 | 30.4s / 26.4s |
| Grouped path restoration | 6 / 6 | 26.5s / 31.1s |

Total-input and duration figures include normal agent variability, tool calls,
and prompt-cache behavior. Three repetitions are an initial regression screen,
not a claim that small performance differences are statistically stable.

The complete per-run measurements and grader results are in
[`results.json`](results.json). Raw Claude result envelopes are in [`raw/`](raw/).

## Reproduce

With the shared Clodex daemon running and an authenticated account selected:

```bash
bun scripts/benchmark-secondwind-codecs.ts
```

The runner restores Secondwind to `on` when it exits, including after failure.
