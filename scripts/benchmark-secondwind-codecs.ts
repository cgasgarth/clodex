#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { daemonControlRequest } from '../src/daemon/control-client.js';

type Condition = 'off' | 'on';

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeResult {
  type?: string;
  is_error?: boolean;
  duration_api_ms?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
  terminal_reason?: string;
  result?: string;
  usage?: ClaudeUsage;
}

interface SecondwindMetrics {
  requests: number;
  blocksRewritten: number;
  inputTokensConsidered: number;
  tokensReduced: number;
  estimatedSavingsUsd: number;
}

interface SecondwindSnapshot {
  mode: Condition;
  applied: SecondwindMetrics;
  errors: number;
}

interface Task {
  id: string;
  name: string;
  codec: string;
  prompt: string;
  setup(directory: string): void;
  grade(directory: string): { passed: boolean; detail: string };
}

interface RunResult {
  taskId: string;
  task: string;
  codec: string;
  condition: Condition;
  repetition: number;
  passed: boolean;
  gradeDetail: string;
  exitCode: number;
  isError: boolean;
  terminalReason?: string;
  sessionId?: string;
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  logicalInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  durationMs: number;
  resultText?: string;
  stderr?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clodexBin = process.env.CLODEX_BENCHMARK_BIN
  ?? join(process.env.HOME ?? '', '.bun', 'bin', 'clodex');
const repetitions = 3;
const timeoutMs = 30 * 60_000;
const outputRoot = resolve(
  process.env.CLODEX_BENCHMARK_OUTPUT
    ?? join(repositoryRoot, 'benchmarks', 'secondwind', 'results', 'luna-medium-2026-07-30'),
);

function writeJson<Value>(path: string, value: Value): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeWorkspacePackage(directory: string): void {
  writeJson(join(directory, 'package.json'), {
    name: 'clodex-secondwind-benchmark',
    private: true,
    scripts: { test: 'bun test tests/smoke.test.ts' },
  });
  mkdirSync(join(directory, 'tests'), { recursive: true });
}

function setupDeployments(directory: string): void {
  writeWorkspacePackage(directory);
  mkdirSync(join(directory, 'config'), { recursive: true });
  writeJson(join(directory, 'config', 'rollback.json'), { deploymentId: null });
  writeFileSync(join(directory, 'tests', 'smoke.test.ts'), [
    "import { expect, test } from 'bun:test';",
    "import rollback from '../config/rollback.json';",
    "test('rollback config remains valid', () => {",
    "  expect(rollback.deploymentId === null || typeof rollback.deploymentId === 'string').toBe(true);",
    '});',
    '',
  ].join('\n'));
}

function setupPackages(directory: string): void {
  writeWorkspacePackage(directory);
  mkdirSync(join(directory, 'config'), { recursive: true });
  writeJson(join(directory, 'config', 'isolated-packages.json'), []);
  writeFileSync(join(directory, 'tests', 'smoke.test.ts'), [
    "import { expect, test } from 'bun:test';",
    "import packages from '../config/isolated-packages.json';",
    "test('isolated package config remains a string array', () => {",
    '  expect(Array.isArray(packages)).toBe(true);',
    "  expect(packages.every(value => typeof value === 'string')).toBe(true);",
    '});',
    '',
  ].join('\n'));
}

const serializerPaths = [
  'src/service/accounts/legacy/serializer.ts',
  'src/services/account/legacy/serializer.ts',
  'src/services/accounts/current/serializer.ts',
  'src/services/accounts/legacy/serializer.ts',
  'src/services/accounts-v2/legacy/serializer.ts',
];

function setupFiles(directory: string): void {
  writeWorkspacePackage(directory);
  for (const path of serializerPaths) {
    const absolute = join(directory, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, [
      `export const SOURCE = '${path}';`,
      'export const MAX_RECORDS = 128;',
      '',
    ].join('\n'));
  }
  for (const path of [
    'src/service/accounts/protocol/protocol-v2.json',
    'src/services/account/protocol/protocol-v2.json',
    'src/services/accounts/protocol/protocol-v3.json',
    'src/services/accounts-v2/protocol/protocol-v1.json',
  ]) {
    writeJson(join(directory, path), { protocol: path });
  }
  writeFileSync(join(directory, 'tests', 'smoke.test.ts'), [
    "import { expect, test } from 'bun:test';",
    "import { readdirSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "function walk(root: string): string[] {",
    '  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {',
    '    const path = join(root, entry.name);',
    '    return entry.isDirectory() ? walk(path) : [path];',
    '  });',
    '}',
    "test('serializer limits remain supported', () => {",
    "  const files = walk('src').filter(path => path.endsWith('serializer.ts'));",
    "  const values = files.map(path => Number(readFileSync(path, 'utf8').match(/MAX_RECORDS = (\\d+)/)?.[1]));",
    '  expect(values.every(value => value === 128 || value === 256)).toBe(true);',
    '  expect(values.filter(value => value === 256).length).toBeLessThanOrEqual(1);',
    '});',
    '',
  ].join('\n'));
}

const tasks: Task[] = [
  {
    id: 'null-empty-absent',
    name: 'Null, empty, and absent values',
    codec: 'SWNEST',
    prompt: [
      'Run `./benchctl deployments`.',
      'Update `config/rollback.json` with the deployment ID for the unique record where',
      '`rollbackAt` is explicitly null, `warnings` is an empty array, `owner.email` is absent,',
      'and status is `blocked`. Do not select empty strings, null warnings, or absent rollbackAt.',
      'Do not inspect the benchmark executable. Preserve the file structure and run `bun test`.',
    ].join(' '),
    setup: setupDeployments,
    grade(directory) {
      const value = JSON.parse(readFileSync(join(directory, 'config', 'rollback.json'), 'utf8'));
      const passed = value.deploymentId === 'dep-rollback-null-417';
      return { passed, detail: `deploymentId=${JSON.stringify(value.deploymentId)}` };
    },
  },
  {
    id: 'parent-child-join',
    name: 'Parent-child dependency join',
    codec: 'SWNORM',
    prompt: [
      'Run `./benchctl packages`.',
      'Find the unique package that directly depends on serde 1.0.219 with feature derive,',
      'directly depends on tokio with rt-multi-thread, and does not directly depend on',
      'tracing-subscriber. Add only that package ID to `config/isolated-packages.json`.',
      'Do not inspect the benchmark executable. Run `bun test`.',
    ].join(' '),
    setup: setupPackages,
    grade(directory) {
      const value = JSON.parse(readFileSync(
        join(directory, 'config', 'isolated-packages.json'),
        'utf8',
      ));
      const passed = JSON.stringify(value) === JSON.stringify(['pkg-isolated-0219']);
      return { passed, detail: `isolatedPackages=${JSON.stringify(value)}` };
    },
  },
  {
    id: 'grouped-path',
    name: 'Grouped path restoration',
    codec: 'SWGRP',
    prompt: [
      'Run `./benchctl files`.',
      'Find the only `serializer.ts` under a `legacy` directory whose sibling directory',
      'contains `protocol-v3.json`. Change MAX_RECORDS in that serializer from 128 to 256.',
      'Do not modify any other serializer. Do not inspect the benchmark executable.',
      'Run `bun test`.',
    ].join(' '),
    setup: setupFiles,
    grade(directory) {
      const changed = serializerPaths.filter(path =>
        readFileSync(join(directory, path), 'utf8').includes('MAX_RECORDS = 256'));
      const passed = JSON.stringify(changed)
        === JSON.stringify(['src/services/accounts/legacy/serializer.ts']);
      return { passed, detail: `changed=${JSON.stringify(changed)}` };
    },
  },
];

function parseClaudeResult(stdout: string): ClaudeResult | undefined {
  for (const line of stdout.trim().split('\n').toReversed()) {
    try {
      // SAFETY: Claude's JSON result envelope is checked by its `type` discriminator below.
      const parsed = JSON.parse(line) as ClaudeResult;
      if (parsed.type === 'result') return parsed;
    } catch {
      // Ignore non-JSON launcher output.
    }
  }
  return undefined;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : '';
}

async function runOne(
  task: Task,
  condition: Condition,
  repetition: number,
  benchctl: string,
  workspaceRoot: string,
): Promise<RunResult> {
  const runId = `${condition}-${task.id}-${repetition}`;
  const directory = join(workspaceRoot, runId);
  mkdirSync(directory, { recursive: true });
  task.setup(directory);
  copyFileSync(benchctl, join(directory, 'benchctl'));
  chmodSync(join(directory, 'benchctl'), 0o755);

  const sessionId = randomUUID();
  const process = Bun.spawn([
    clodexBin,
    'claude',
    '--',
    '--model',
    'luna',
    '--print',
    '--effort',
    'medium',
    '--safe-mode',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--session-id',
    sessionId,
    '--name',
    `swbench-${runId}`,
    task.prompt,
  ], {
    cwd: directory,
    env: { ...processEnv(), CLODEX_BENCHMARK_RUN: runId },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => process.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(process.stdout),
    readStream(process.stderr),
    process.exited,
  ]);
  clearTimeout(timer);

  writeFileSync(join(outputRoot, 'raw', `${runId}.stdout.txt`), stdout);
  writeFileSync(join(outputRoot, 'raw', `${runId}.stderr.txt`), stderr);
  const parsed = parseClaudeResult(stdout);
  const grade = task.grade(directory);
  const usage = parsed?.usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    taskId: task.id,
    task: task.name,
    codec: task.codec,
    condition,
    repetition,
    passed: grade.passed && exitCode === 0 && parsed?.is_error !== true,
    gradeDetail: grade.detail,
    exitCode,
    isError: parsed?.is_error ?? exitCode !== 0,
    terminalReason: parsed?.terminal_reason,
    sessionId: parsed?.session_id ?? sessionId,
    turns: parsed?.num_turns ?? 0,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    logicalInputTokens: inputTokens + cachedInputTokens + cacheWriteTokens,
    uncachedInputTokens: inputTokens,
    outputTokens: usage.output_tokens ?? 0,
    durationMs: parsed?.duration_ms ?? parsed?.duration_api_ms ?? 0,
    resultText: parsed?.result,
    stderr: stderr.trim() || undefined,
  };
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined),
  );
}

function metricDelta(after: SecondwindMetrics, before: SecondwindMetrics): SecondwindMetrics {
  return {
    requests: after.requests - before.requests,
    blocksRewritten: after.blocksRewritten - before.blocksRewritten,
    inputTokensConsidered: after.inputTokensConsidered - before.inputTokensConsidered,
    tokensReduced: after.tokensReduced - before.tokensReduced,
    estimatedSavingsUsd: after.estimatedSavingsUsd - before.estimatedSavingsUsd,
  };
}

async function setMode(mode: Condition): Promise<SecondwindSnapshot> {
  return daemonControlRequest<SecondwindSnapshot>('/v1/secondwind/mode', {
    method: 'POST',
    body: { mode },
  });
}

async function runCondition(
  condition: Condition,
  benchctl: string,
  workspaceRoot: string,
): Promise<{ runs: RunResult[]; secondwind: SecondwindMetrics }> {
  const before = await setMode(condition);
  const jobs = tasks.flatMap(task =>
    Array.from({ length: repetitions }, (_, index) =>
      runOne(task, condition, index + 1, benchctl, workspaceRoot)));
  const runs = await Promise.all(jobs);
  const after = await daemonControlRequest<SecondwindSnapshot>('/v1/secondwind');
  return { runs, secondwind: metricDelta(after.applied, before.applied) };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function summarize(runs: RunResult[]) {
  return tasks.map(task => {
    const taskRuns = runs.filter(run => run.taskId === task.id);
    const control = taskRuns.filter(run => run.condition === 'off');
    const optimized = taskRuns.filter(run => run.condition === 'on');
    const controlInput = median(control.map(run => run.logicalInputTokens));
    const optimizedInput = median(optimized.map(run => run.logicalInputTokens));
    return {
      taskId: task.id,
      task: task.name,
      codec: task.codec,
      controlPassed: control.filter(run => run.passed).length,
      optimizedPassed: optimized.filter(run => run.passed).length,
      repetitions,
      controlMedianLogicalInput: controlInput,
      optimizedMedianLogicalInput: optimizedInput,
      realizedInputSavingsPercent: controlInput > 0
        ? ((controlInput - optimizedInput) / controlInput) * 100
        : 0,
      controlMedianUncachedInput: median(control.map(run => run.uncachedInputTokens)),
      optimizedMedianUncachedInput: median(optimized.map(run => run.uncachedInputTokens)),
      controlMedianOutput: median(control.map(run => run.outputTokens)),
      optimizedMedianOutput: median(optimized.map(run => run.outputTokens)),
      controlMedianTurns: median(control.map(run => run.turns)),
      optimizedMedianTurns: median(optimized.map(run => run.turns)),
      controlMedianDurationMs: median(control.map(run => run.durationMs)),
      optimizedMedianDurationMs: median(optimized.map(run => run.durationMs)),
    };
  });
}

async function main(): Promise<void> {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, 'raw'), { recursive: true });
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clodex-secondwind-benchmark-'));
  const benchctl = join(workspaceRoot, 'benchctl');
  const compiled = Bun.spawnSync([
    process.execPath,
    'build',
    '--compile',
    join(repositoryRoot, 'scripts', 'secondwind-benchmark-fixture.ts'),
    '--outfile',
    benchctl,
  ], { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' });
  if (compiled.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(compiled.stderr));
  }

  let control: Awaited<ReturnType<typeof runCondition>> | undefined;
  let optimized: Awaited<ReturnType<typeof runCondition>> | undefined;
  try {
    control = await runCondition('off', benchctl, workspaceRoot);
    optimized = await runCondition('on', benchctl, workspaceRoot);
    if (
      optimized.secondwind.requests === 0
      || optimized.secondwind.blocksRewritten < tasks.length * repetitions
      || optimized.secondwind.tokensReduced < 1_000
    ) {
      throw new Error(
        'Secondwind did not materially rewrite every optimized fixture through the shared daemon.',
      );
    }
  } finally {
    await setMode('on');
  }

  const runs = [...control.runs, ...optimized.runs];
  const report = {
    generatedAt: new Date().toISOString(),
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    repetitions,
    execution: 'Nine fresh sessions ran concurrently per condition; control ran before Secondwind.',
    secondwind: optimized.secondwind,
    summary: summarize(runs),
    runs,
  };
  writeJson(join(outputRoot, 'results.json'), report);
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    secondwind: report.secondwind,
    summary: report.summary,
  }, null, 2));
  rmSync(workspaceRoot, { recursive: true, force: true });
}

await main();
