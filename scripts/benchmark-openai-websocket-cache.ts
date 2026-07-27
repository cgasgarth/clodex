import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_LITE_WS_URL,
  CODEX_RESPONSES_WEBSOCKETS_BETA,
} from '../src/constants.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import { loadRegistryProviders } from '../src/registry/index.js';

type Arm = 'control' | 'preconnect' | 'native-prewarm';
type Fixture = 'synthetic' | 'tools48';

interface Usage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

interface Sample extends Usage {
  arm: Arm;
  block: number;
  fixture: Fixture;
  phase: 'warmup' | 'generation';
  lane: number;
  latencyMs: number;
  wireBytes: number;
  responseId: string;
}

interface TerminalResponse {
  sample: Omit<Sample, 'arm' | 'block' | 'fixture' | 'phase' | 'lane'>;
  responseId: string;
}

interface CapabilityProbe {
  accepted: boolean;
  usage?: Usage;
  latencyMs?: number;
  error?: string;
}

if (process.env.CLODEX_LIVE_CACHE_BENCHMARK !== '1') {
  throw new Error('Set CLODEX_LIVE_CACHE_BENCHMARK=1 to authorize this live benchmark');
}

const blockCount = Number.parseInt(process.env.CLODEX_CACHE_BENCHMARK_BLOCKS ?? '8', 10);
const laneCount = Number.parseInt(process.env.CLODEX_CACHE_BENCHMARK_LANES ?? '4', 10);
const fixtures = (process.env.CLODEX_CACHE_BENCHMARK_FIXTURES ?? 'synthetic,tools48')
  .split(',')
  .map(value => value.trim())
  .filter((value): value is Fixture => value === 'synthetic' || value === 'tools48');
if (!Number.isInteger(blockCount) || blockCount < 1 || blockCount > 30) {
  throw new Error('CLODEX_CACHE_BENCHMARK_BLOCKS must be an integer from 1 to 30');
}
if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 16) {
  throw new Error('CLODEX_CACHE_BENCHMARK_LANES must be an integer from 1 to 16');
}
if (fixtures.length === 0) throw new Error('No valid benchmark fixtures selected');

const provider = (await loadRegistryProviders()).find(candidate => (
  candidate.authType === 'oauth'
  && candidate.models.some(model => model.upstreamModelId === 'gpt-5.6-sol')
));
if (!provider?.apiKey) throw new Error('No usable OpenAI OAuth provider was found');
const accountId = extractOpenAiAccountId({ access_token: provider.apiKey })?.trim()
  || provider.oauthAccountId?.trim();
const headers = {
  Authorization: `Bearer ${provider.apiKey}`,
  ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  originator: 'clodex-cache-benchmark',
  version: CODEX_RESPONSES_LITE_VERSION,
  'x-openai-internal-codex-responses-lite': 'true',
  'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKETS_BETA,
};

async function openSocket(): Promise<WebSocket> {
  const socket = new WebSocket(CODEX_RESPONSES_LITE_WS_URL, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function create(
  socket: WebSocket,
  payload: Record<string, unknown>,
): Promise<TerminalResponse> {
  const outgoing = JSON.stringify({ type: 'response.create', ...payload });
  const startedAt = performance.now();
  return await new Promise<TerminalResponse>((resolve, reject) => {
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : '';
      if (!['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(type)) {
        return;
      }
      cleanup();
      if (type !== 'response.completed') {
        reject(new Error(`Benchmark request failed: ${JSON.stringify(event)}`));
        return;
      }
      const response = event.response as Record<string, unknown>;
      const usage = (response.usage ?? {}) as Record<string, unknown>;
      const details = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
      const responseId = String(response.id ?? '');
      resolve({
        responseId,
        sample: {
          inputTokens: Number(usage.input_tokens ?? 0),
          cachedTokens: Number(details.cached_tokens ?? 0),
          cacheWriteTokens: Number(details.cache_write_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          latencyMs: performance.now() - startedAt,
          wireBytes: Buffer.byteLength(outgoing),
          responseId,
        },
      });
    };
    socket.on('error', onError);
    socket.on('message', onMessage);
    socket.send(outgoing);
  });
}

function tools48(): Array<Record<string, unknown>> {
  return Array.from({ length: 48 }, (_, index) => ({
    type: 'function',
    name: `fixture_tool_${index}`,
    description: `Stable production-shaped benchmark tool ${index}. ` + 'Deterministic schema. '.repeat(12),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(Array.from({ length: 8 }, (__, propertyIndex) => [
        `field_${propertyIndex}`,
        {
          type: 'string',
          description: `Stable field ${propertyIndex}. ` + 'Schema description. '.repeat(8),
        },
      ])),
      required: ['field_0'],
    },
  }));
}

const instructions = [
  'Stable synthetic prompt-cache benchmark prefix.',
  'Do not call tools. Reply only with OK.',
  'This repeated body models a large invariant Claude Code system prefix.',
].join(' ').repeat(700);

function payload(
  fixture: Fixture,
  promptCacheKey: string,
  lane: number,
): Record<string, unknown> {
  return {
    model: 'gpt-5.6-sol',
    instructions,
    tools: fixture === 'tools48' ? tools48() : [],
    parallel_tool_calls: false,
    reasoning: { effort: 'low', context: 'all_turns' },
    prompt_cache_key: promptCacheKey,
    store: false,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: `Divergent lane ${lane}. Reply only OK.` }],
    }],
  };
}

async function capabilityProbe(
  mutate: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<CapabilityProbe> {
  const socket = await openSocket();
  try {
    const request = mutate({
      ...payload('synthetic', `clodex-cache-capability-${randomUUID()}`, 0),
      generate: false,
    });
    const result = await create(socket, request);
    return {
      accepted: true,
      usage: {
        inputTokens: result.sample.inputTokens,
        cachedTokens: result.sample.cachedTokens,
        cacheWriteTokens: result.sample.cacheWriteTokens,
        outputTokens: result.sample.outputTokens,
      },
      latencyMs: result.sample.latencyMs,
    };
  } catch (error) {
    return {
      accepted: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  } finally {
    socket.close();
  }
}

function shuffled<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

async function runArm(arm: Arm, fixture: Fixture, block: number): Promise<Sample[]> {
  const sockets = await Promise.all(Array.from({ length: laneCount }, () => openSocket()));
  const key = `clodex-cache-benchmark-${randomUUID()}`;
  const samples: Sample[] = [];
  try {
    if (arm === 'preconnect') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (arm === 'native-prewarm') {
      const warmupPayload = { ...payload(fixture, key, 0), generate: false };
      const warmup = await create(sockets[0]!, warmupPayload);
      samples.push({
        ...warmup.sample,
        arm,
        block,
        fixture,
        phase: 'warmup',
        lane: 0,
      });
      const generationPayloads = Array.from({ length: laneCount }, (_, lane) => (
        lane === 0
          ? {
              ...payload(fixture, key, lane),
              previous_response_id: warmup.responseId,
              input: [],
            }
          : payload(fixture, key, lane)
      ));
      const generated = await Promise.all(generationPayloads.map((request, lane) => (
        create(sockets[lane]!, request)
      )));
      samples.push(...generated.map((result, lane) => ({
        ...result.sample,
        arm,
        block,
        fixture,
        phase: 'generation' as const,
        lane,
      })));
      return samples;
    }
    const generated = await Promise.all(Array.from({ length: laneCount }, (_, lane) => (
      create(sockets[lane]!, payload(fixture, key, lane))
    )));
    samples.push(...generated.map((result, lane) => ({
      ...result.sample,
      arm,
      block,
      fixture,
      phase: 'generation' as const,
      lane,
    })));
    return samples;
  } finally {
    sockets.forEach(socket => socket.close());
  }
}

function quantile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(probability * sorted.length))]!;
}

function summary(samples: Sample[]) {
  const inputTokens = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
  const cachedTokens = samples.reduce((sum, sample) => sum + sample.cachedTokens, 0);
  const cacheWriteTokens = samples.reduce((sum, sample) => sum + sample.cacheWriteTokens, 0);
  return {
    requests: samples.length,
    generations: samples.filter(sample => sample.phase === 'generation').length,
    warmups: samples.filter(sample => sample.phase === 'warmup').length,
    cacheHitRequests: samples.filter(sample => sample.cachedTokens > 0).length,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    plainUncachedTokens: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    nonReadTokens: Math.max(0, inputTokens - cachedTokens),
    cachedTokenRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    totalWireBytes: samples.reduce((sum, sample) => sum + sample.wireBytes, 0),
    p50LatencyMs: quantile(samples.map(sample => sample.latencyMs), 0.5),
    p95LatencyMs: quantile(samples.map(sample => sample.latencyMs), 0.95),
  };
}

function comparison(samples: Sample[], fixture: Fixture, arm: Exclude<Arm, 'control'>) {
  const totals = Array.from({ length: blockCount }, (_, block) => {
    const totalFor = (selectedArm: Arm) => samples
      .filter(sample => (
        sample.fixture === fixture
        && sample.block === block
        && sample.arm === selectedArm
      ))
      .reduce((sum, sample) => sum + sample.inputTokens - sample.cachedTokens, 0);
    return { control: totalFor('control'), candidate: totalFor(arm) };
  });
  const reduction = (selected: typeof totals) => {
    const control = selected.reduce((sum, block) => sum + block.control, 0);
    const candidate = selected.reduce((sum, block) => sum + block.candidate, 0);
    return control > 0 ? 1 - candidate / control : 0;
  };
  let randomState = 0x5eed1234;
  const randomIndex = () => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((randomState / 0x1_0000_0000) * totals.length);
  };
  const bootstrap = Array.from({ length: 10_000 }, () => (
    reduction(Array.from({ length: totals.length }, () => totals[randomIndex()]!))
  )).sort((left, right) => left - right);
  const controlLatency = samples
    .filter(sample => sample.fixture === fixture && sample.arm === 'control')
    .map(sample => sample.latencyMs);
  const candidateLatency = samples
    .filter(sample => sample.fixture === fixture && sample.arm === arm)
    .map(sample => sample.latencyMs);
  const controlP95 = quantile(controlLatency, 0.95);
  const candidateP95 = quantile(candidateLatency, 0.95);
  const observedReduction = reduction(totals);
  const ci95: [number, number] = [bootstrap[249]!, bootstrap[9_749]!];
  const p95LatencyRegression = controlP95 > 0 ? candidateP95 / controlP95 - 1 : 0;
  return {
    fixture,
    candidate: arm,
    observedNonReadReduction: observedReduction,
    bootstrapCi95: ci95,
    p95LatencyRegression,
    passesTokenGate: ci95[0] >= 0.1,
    passesLatencyGate: p95LatencyRegression <= 0.03,
    passesCandidateGate: ci95[0] >= 0.1 && p95LatencyRegression <= 0.03,
  };
}

const allSamples: Sample[] = [];
const arms: Arm[] = ['control', 'preconnect', 'native-prewarm'];
const capabilityProbes = {
  generateFalse: await capabilityProbe(request => request),
  promptCacheOptions: await capabilityProbe(request => ({
    ...request,
    prompt_cache_options: { mode: 'implicit', ttl: '30m' },
  })),
  explicitBreakpoint: await capabilityProbe(request => {
    const input = structuredClone(request.input) as Array<Record<string, unknown>>;
    const content = input[0]?.content as Array<Record<string, unknown>>;
    content[0] = {
      ...content[0],
      prompt_cache_breakpoint: { mode: 'explicit' },
    };
    return {
      ...request,
      input,
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    };
  }),
};
for (const fixture of fixtures) {
  for (let block = 0; block < blockCount; block += 1) {
    for (const arm of shuffled(arms)) {
      process.stderr.write(`fixture=${fixture} block=${block + 1}/${blockCount} arm=${arm}\n`);
      allSamples.push(...await runArm(arm, fixture, block));
    }
  }
}

const summaries = Object.fromEntries(fixtures.flatMap(fixture => arms.map(arm => {
  const selected = allSamples.filter(sample => sample.fixture === fixture && sample.arm === arm);
  return [`${fixture}:${arm}`, summary(selected)];
})));
const comparisons = fixtures.flatMap(fixture => [
  comparison(allSamples, fixture, 'preconnect'),
  comparison(allSamples, fixture, 'native-prewarm'),
]);
process.stdout.write(`${JSON.stringify({
  config: { blockCount, laneCount, fixtures },
  capabilityProbes,
  summaries,
  comparisons,
  samples: allSamples,
}, null, 2)}\n`);
