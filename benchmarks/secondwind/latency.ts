#!/usr/bin/env bun

import { Session } from 'secondwind';
import { SecondwindWorkerPool } from '../../src/daemon/secondwind-worker-pool.js';

interface RewriteStats {
  input_tokens?: number;
  output_tokens?: number;
  tokens_saved?: number;
}

interface Timings {
  medianMs: number;
  p95Ms: number;
}

interface BenchmarkRow {
  bodyMiB: number;
  rewrittenMiB: number;
  tokensSaved: number;
  native: Timings;
  persistentFirstMs: number;
  persistentResend: Timings;
  poolColdMs: number;
  poolWarm: Timings;
}

interface RewriteResult {
  body: Uint8Array;
  stats?: RewriteStats;
}

interface NativeBenchmarkResult {
  result: RewriteResult;
  timings: Timings;
}

interface PersistentBenchmarkResult {
  firstMs: number;
  resend: Timings;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const defaultSizesMiB = [0.25, 1, 3, 5, 8];
const defaultIterations = 5;

function numericArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${prefix}${raw}`);
  return value;
}

function sizeArguments(): number[] {
  const prefix = '--sizes=';
  const raw = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return defaultSizesMiB;
  const sizes = raw.split(',').map(Number);
  if (sizes.length === 0 || sizes.some(size => !Number.isFinite(size) || size <= 0)) {
    throw new Error(`Invalid ${prefix}${raw}`);
  }
  return sizes;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function timings(values: number[]): Timings {
  return {
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function round(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function createRequestBody(targetMiB: number): Uint8Array {
  const targetBytes = targetMiB * 1024 * 1024;
  const records: Array<Record<string, string | number>> = [];
  let body = new Uint8Array();
  let index = 0;

  while (body.byteLength < targetBytes) {
    for (let batchIndex = 0; batchIndex < 1_000; batchIndex += 1) {
      records.push({
        id: index,
        path: `src/module-${index % 200}/file-${index}.ts`,
        line: index % 500,
        status: index % 3 === 0 ? 'changed' : 'ok',
        detail: `diagnostic-${index}-${((index * 2_654_435_761) >>> 0).toString(16)}`,
      });
      index += 1;
    }
    body = encoder.encode(JSON.stringify({
      model: 'sol',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'benchmark-tool-result',
          content: JSON.stringify(records),
        }],
      }],
    }));
  }

  return body;
}

function rewriteWithSession(
  session: Session,
  body: Uint8Array,
): RewriteResult {
  // SAFETY: createRequestBody produces the request shape that secondwind Session.rewrite owns.
  const request = JSON.parse(decoder.decode(body)) as Parameters<Session['rewrite']>[0];
  const result = session.rewrite(request);
  return {
    body: encoder.encode(JSON.stringify(result.request)),
    stats: result.stats,
  };
}

function directRewrite(body: Uint8Array): RewriteResult {
  const session = new Session();
  try {
    return rewriteWithSession(session, body);
  } finally {
    session.close();
  }
}

function benchmarkNative(body: Uint8Array, iterations: number): NativeBenchmarkResult {
  const samples: number[] = [];
  let result: ReturnType<typeof directRewrite> | undefined;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    result = directRewrite(body);
    samples.push(performance.now() - startedAt);
  }
  if (!result) throw new Error('Native benchmark produced no result');
  return { result, timings: timings(samples) };
}

function benchmarkPersistent(body: Uint8Array, iterations: number): PersistentBenchmarkResult {
  const session = new Session();
  try {
    const startedFirstAt = performance.now();
    rewriteWithSession(session, body);
    const firstMs = performance.now() - startedFirstAt;
    const resendSamples: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      rewriteWithSession(session, body);
      resendSamples.push(performance.now() - startedAt);
    }
    return { firstMs, resend: timings(resendSamples) };
  } finally {
    session.close();
  }
}

async function benchmarkPool(body: Uint8Array, iterations: number): Promise<{
  coldMs: number;
  warm: Timings;
}> {
  const pool = new SecondwindWorkerPool({
    workerCount: 1,
    recycleAfterRssBytes: Number.MAX_SAFE_INTEGER,
    recycleAfterRequests: Number.MAX_SAFE_INTEGER,
  });
  try {
    const startedColdAt = performance.now();
    await pool.rewrite('benchmark-session', body);
    const coldMs = performance.now() - startedColdAt;
    const warmSamples: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      await pool.rewrite('benchmark-session', body);
      warmSamples.push(performance.now() - startedAt);
    }
    return { coldMs, warm: timings(warmSamples) };
  } finally {
    pool.close();
  }
}

async function benchmarkSize(sizeMiB: number, iterations: number): Promise<BenchmarkRow> {
  const body = createRequestBody(sizeMiB);
  const native = benchmarkNative(body, iterations);
  const persistent = benchmarkPersistent(body, iterations);
  const pool = await benchmarkPool(body, iterations);
  return {
    bodyMiB: round(body.byteLength / 1024 / 1024, 2),
    rewrittenMiB: round(native.result.body.byteLength / 1024 / 1024, 2),
    tokensSaved: native.result.stats?.tokens_saved ?? 0,
    native: {
      medianMs: round(native.timings.medianMs),
      p95Ms: round(native.timings.p95Ms),
    },
    persistentFirstMs: round(persistent.firstMs),
    persistentResend: {
      medianMs: round(persistent.resend.medianMs),
      p95Ms: round(persistent.resend.p95Ms),
    },
    poolColdMs: round(pool.coldMs),
    poolWarm: {
      medianMs: round(pool.warm.medianMs),
      p95Ms: round(pool.warm.p95Ms),
    },
  };
}

const iterations = Math.floor(numericArgument('iterations', defaultIterations));
const rows: BenchmarkRow[] = [];
for (const sizeMiB of sizeArguments()) rows.push(await benchmarkSize(sizeMiB, iterations));

console.log('| Body MiB | Rewritten MiB | Tokens saved | Fresh median | Persistent resend median | Pool cold | Pool warm median |');
console.log('|---:|---:|---:|---:|---:|---:|---:|');
for (const row of rows) {
  console.log(`| ${row.bodyMiB} | ${row.rewrittenMiB} | ${row.tokensSaved} | ${row.native.medianMs}ms | ${row.persistentResend.medianMs}ms | ${row.poolColdMs}ms | ${row.poolWarm.medianMs}ms |`);
}
