import { BunNativeWebSocket } from '../src/transport/bun-websocket.js';
import {
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_LITE_WS_URL,
  CODEX_RESPONSES_WEBSOCKETS_BETA,
} from '../src/constants.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import { loadRegistryProviders } from '../src/registry/index.js';

interface Usage {
  inputTokens: number;
  cachedTokens: number;
}

interface BenchmarkHeaders {
  [key: string]: string;
  Authorization: string;
  originator: string;
}

interface BenchmarkPayload {
  model: string;
  instructions: string;
  tools: never[];
  parallel_tool_calls: boolean;
  reasoning: { effort: string; context: string };
  prompt_cache_key: string;
  store: boolean;
  input: Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
  }>;
}

interface BenchmarkEvent {
  type?: string;
  response?: {
    usage?: {
      input_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

if (process.env.CLODEX_LIVE_CACHE_BENCHMARK !== '1') {
  throw new Error('Set CLODEX_LIVE_CACHE_BENCHMARK=1 to authorize this live benchmark');
}

const provider = (await loadRegistryProviders()).find(candidate => (
  candidate.authType === 'oauth'
  && candidate.models.some(model => model.upstreamModelId === 'gpt-5.6-sol')
));
if (!provider?.apiKey) throw new Error('No usable OpenAI OAuth provider was found');
const accountId = extractOpenAiAccountId({ access_token: provider.apiKey })?.trim()
  || provider.oauthAccountId?.trim();
const headers: BenchmarkHeaders = {
  Authorization: `Bearer ${provider.apiKey}`,
  originator: 'clodex-cache-benchmark',
  version: CODEX_RESPONSES_LITE_VERSION,
  'x-openai-internal-codex-responses-lite': 'true',
  'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKETS_BETA,
};
if (accountId) headers['ChatGPT-Account-Id'] = accountId;

async function openSocket(): Promise<BunNativeWebSocket> {
  const socket = new BunNativeWebSocket(CODEX_RESPONSES_LITE_WS_URL, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function create(socket: BunNativeWebSocket, requestPayload: BenchmarkPayload): Promise<Usage> {
  return await new Promise<Usage>((resolve, reject) => {
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: Buffer) => {
      // SAFETY: The WebSocket server emits the documented OpenAI response event envelope.
      const event = JSON.parse(data.toString()) as BenchmarkEvent;
      const type = event.type ?? '';
      if (!['response.completed', 'response.failed', 'error'].includes(type)) return;
      cleanup();
      if (type !== 'response.completed') {
        reject(new Error(`Benchmark request failed: ${JSON.stringify(event)}`));
        return;
      }
      const usage = event.response?.usage;
      const details = usage?.input_tokens_details;
      resolve({
        inputTokens: usage?.input_tokens ?? 0,
        cachedTokens: details?.cached_tokens ?? 0,
      });
    };
    socket.on('error', onError);
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'response.create', ...requestPayload }));
  });
}

const requests = 12;
const instructions = 'Stable synthetic prompt-cache benchmark prefix. '.repeat(450);
function payload(mode: string, index: number): BenchmarkPayload {
  return {
    model: 'gpt-5.6-sol',
    instructions,
    tools: [],
    parallel_tool_calls: false,
    reasoning: { effort: 'low', context: 'all_turns' },
    prompt_cache_key: `clodex-cache-benchmark-${mode}`,
    store: false,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: `Divergent request ${index}. Reply only OK.` }],
    }],
  };
}

async function baseline(): Promise<Usage[]> {
  const samples: Usage[] = [];
  for (let index = 0; index < requests; index += 1) {
    const socket = await openSocket();
    samples.push(await create(socket, payload('fresh', index)));
    socket.close();
  }
  return samples;
}

async function pooled(): Promise<Usage[]> {
  const sockets: [BunNativeWebSocket, BunNativeWebSocket] = [
    await openSocket(),
    await openSocket(),
  ];
  const samples: Usage[] = [];
  for (let index = 0; index < requests; index += 1) {
    const socket = index % 2 === 0 ? sockets[0] : sockets[1];
    samples.push(await create(socket, payload('pooled', index)));
  }
  sockets.forEach(socket => socket.close());
  return samples;
}

function summary(samples: Usage[]) {
  const inputTokens = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
  const cachedTokens = samples.reduce((sum, sample) => sum + sample.cachedTokens, 0);
  return {
    requests: samples.length,
    cacheHitRequests: samples.filter(sample => sample.cachedTokens > 0).length,
    inputTokens,
    cachedTokens,
    cachedTokenRate: cachedTokens / inputTokens,
  };
}

const fresh = await baseline();
const warm = await pooled();
process.stdout.write(`${JSON.stringify({
  baseline: summary(fresh),
  pooled: summary(warm),
  samples: { baseline: fresh, pooled: warm },
}, null, 2)}\n`);
