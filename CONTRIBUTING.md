# Contributing to clodex

Contributions are welcome — bug reports, fixes, and features all.

clodex bridges Claude Code to OpenAI models. A lot of its behavior encodes real production
failures that aren't obvious from reading the code, so this guide is mostly about the
context you can't infer from the diff. Please skim it before opening a PR; it should save
you rework.

## Before you start

**Small changes** — bug fixes, docs, tests, a focused improvement — just open a PR. No
ceremony needed.

**Larger changes** — anything touching a subsystem, spanning several files, or changing
behavior users depend on — please open an issue first. This isn't a gate, and you won't be
turned away for skipping it. It's to protect your time: clodex has invariants that look
arbitrary until you know the failure they came from, and it's much cheaper to sort that out
in an issue than after you've written the code.

## Scoping your PR

This is the guidance most worth following, because it's the one that's hard to see from
inside a single PR.

**One coherent change per PR — but keep a coherent change together.** If a fix requires
touching four files, that's one PR with four files, not four PRs. The unit is the change,
not the file.

**Don't split one subsystem across parallel PRs.** This is the big one. Several
independent PRs that each rework the same area will each look reasonable in isolation
and still collide badly in aggregate: whoever merges first wins, and everyone else
rebases into a conflict they couldn't have predicted. Worse, reviewing them separately
hides design disagreements — two PRs can extend the same type in two incompatible
directions and neither review will catch it, because the conflict doesn't exist in either
diff.

If you find yourself opening a third PR against the same subsystem, that's a signal the
work wanted to be one PR (or an issue first).

**Prefer a few well-scoped PRs over many micro-PRs.** Three or four substantial,
self-contained PRs are easier to review and land than six or more fine-grained ones
that share files. Splitting has real costs — reviewer context, merge conflicts,
integration risk — and they're paid per-PR.

**If your changes genuinely must stack, say so.** Note the dependency and intended merge
order in the PR description, and target each PR at the branch it builds on rather than
`main`. That makes the diffs readable and the order explicit.

## Quality bar

These are the standards that matter most here, in rough order of how often they're missed:

**Verify the code path you're changing is actually reachable.** Before fixing behavior,
confirm that the path can execute in a real configuration. clodex is a trimmed fork of a
broader project, and some code is vestigial — it supports providers and options that no
longer ship. A fix to an unreachable path passes review and CI while the real bug survives
untouched.

**Tests must be behavioral.** The test for a fix should fail if you revert the fix. Tests
that assert structure, restate the implementation, or exercise fixtures that can't occur
in practice give false confidence — they pass whether or not the bug is fixed. If you add
a lot of tests, make sure at least one of them actually pins the behavior you changed.

**Follow existing patterns rather than introducing parallel ones.** Where the codebase
already solves a problem — file locking, credential resolution, stale-state detection —
match the established approach. A new mechanism that's subtly weaker than the existing one
is harder to spot than an obvious bug.

**Don't leave no-op edits behind.** A conditional whose branches are identical, an option
that's parsed but never read, a helper that's implemented but never called — these read as
finished work and quietly aren't. If you started a change and decided against it, revert it
rather than leaving the scaffolding.

**Update every consumer.** When you change a representation — a type, a stored format, a
sentinel value — search the tree for existing readers of the old form. A missed consumer is
where the real bug hides, especially in auth code, where the failure mode is silent rather
than loud.

**Consider the upgrade path.** If a change affects data persisted in `~/.clodex` or the
system keychain, make sure an existing install still works after upgrading, or add a
migration.

## Development

```bash
bun ci
bun run build
bun run test
bun run typecheck
bun run dev
```

Development and the published CLI require **Bun 1.4.0 or newer**. CI uses Bun
1.4.0 and prints the exact revision used by each run.
`packageManager`, `engines.bun`, and `bun.lock` define the toolchain contract.
Dependencies are exact-pinned.
Do not add Node, npm, pnpm, Vitest, or tsup execution paths.

Before opening a PR, run:

```bash
bun run typecheck && bun run test && bun run build
```

CI runs `bun run check:ci` on every pull request and every push to `main`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) so history stays
easy to scan. Husky runs the full repository checks before each commit.

| Prefix | Use for |
| --- | --- |
| `feat:` | adds a feature |
| `fix:` | fixes behavior |
| `docs:` | documentation only |
| `test:` | tests only |
| `refactor:` | no behavior change |
| `build:` / `ci:` / `chore:` | maintenance |

Add `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer for an incompatible change.

A scope is encouraged where it's obvious — `fix(auth):`, `feat(wrapper):`.

## Manual testing

Much of clodex can't be covered by the automated suite because it involves the
real Claude Code binary and a real provider. The tests cover pure functions;
plain-Claude and real-provider behavior are verified by hand.

If your change touches a launch path, please say in the PR description what you exercised
manually. Useful commands:

```bash
clodex start                # start the shared daemon without the dashboard
claude                      # real Claude Code binary using user settings
clodex models --list        # print model names + aliases
clodex server               # foreground gateway
```

Use `CLODEX_HOME=$(mktemp -d)` to exercise the CLI against throwaway config instead of your
real `~/.clodex`.

## A few hard rules

- **Never commit `dist/`.** It's gitignored and rebuilt by CI.
- **Never publish locally.** Publication is a maintainer action.
- **Never hardcode a version string.** `package.json` is the single source of truth.
- **Never add `claude -p` end-to-end tests to the automated suite.** They're manual only.
- **Don't restructure `src/oauth/responses-websocket.ts`.** The OAuth WebSocket
  continuation logic took extensive real-world testing. Surgical changes only.
- **Preserve unrelated `~/.claude/settings.json` values.** Catalog commands may
  update only native `modelPicker.options`. Never mutate a legacy `~/.relay-ai`
  directory.

## Review

PRs are reviewed manually, and review may include running the change locally. Expect
questions about reachability, test coverage of the actual fix, and interaction with other
in-flight PRs — those are the three things that most often need another pass.

If a review asks for changes, that's normal and not a rejection. If you disagree with a
review comment, say so; the reasoning behind an invariant is sometimes wrong or no longer
applies, and that's worth knowing.

Thanks for contributing.
