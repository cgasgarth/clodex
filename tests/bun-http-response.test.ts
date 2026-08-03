import { describe, expect, it } from 'bun:test';
import { BunHttpResponse } from '../src/bun-http-response.js';

describe('BunHttpResponse', () => {
  it('drops writes already in flight after the downstream body is cancelled', async () => {
    const response = new BunHttpResponse();
    let cancellations = 0;
    response.setClientCancelHandler(() => { cancellations += 1; });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = (await response.response).body;
    expect(body).not.toBeNull();

    await body!.cancel();
    const writeError = await new Promise<Error | null | undefined>(resolve => {
      response.write('event: late\n\n', error => resolve(error));
    });
    const endError = await new Promise<Error | null | undefined>(resolve => {
      response.end(error => resolve(error));
    });

    expect(cancellations).toBe(1);
    expect(writeError).toBeNull();
    expect(endError).toBeNull();
  });
});
