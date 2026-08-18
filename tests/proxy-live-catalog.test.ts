import { describe, expect, it } from 'bun:test';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy/index.js';

function route(modelId: string): ProxyRoute {
  return {
    aliasId: modelId,
    realModelId: modelId,
    displayName: modelId,
    upstreamUrl: 'https://example.test',
    apiKey: 'token',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai',
  };
}

describe('live proxy catalog replacement', () => {
  it('updates model discovery and routing lookup without restarting the server', async () => {
    const sol = route('sol');
    const luna = route('luna');
    const handle = await startProxyCatalog([sol], sol.aliasId);
    try {
      const modelsBefore = await fetch(`http://127.0.0.1:${handle.port}/v1/models`);
      expect(await modelsBefore.text()).toContain('"sol"');

      handle.replaceCatalog([luna], luna.aliasId);

      const modelsAfter = await fetch(`http://127.0.0.1:${handle.port}/v1/models`);
      expect(await modelsAfter.text()).toContain('"luna"');
      expect((await fetch(
        `http://127.0.0.1:${handle.port}/v1/models/sol`,
      )).status).toBe(404);
      expect((await fetch(
        `http://127.0.0.1:${handle.port}/v1/models/luna`,
      )).status).toBe(200);

      handle.replaceCatalog([luna], luna.aliasId, [{
        name: 'sol',
        unavailableReason: 'target disabled',
      }]);
      const disabledAlias = await fetch(
        `http://127.0.0.1:${handle.port}/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': handle.token,
          },
          body: JSON.stringify({
            model: 'sol',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
      );
      expect(disabledAlias.status).toBe(400);
      expect(await disabledAlias.text()).toContain('target disabled');
    } finally {
      await handle.close();
    }
  });
});
