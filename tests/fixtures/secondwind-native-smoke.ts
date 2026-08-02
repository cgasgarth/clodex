import { SecondwindService } from '../../src/daemon/secondwind.js';

const records = Array.from({ length: 400 }, (_, index) => ({
  id: index,
  path: `file-${index}.txt`,
  state: index % 2 ? 'open' : 'closed',
  owner: `team-${index % 5}`,
}));
const request = {
  model: 'sol',
  messages: [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: JSON.stringify(records),
    }],
  }],
};
const body = Buffer.from(JSON.stringify(request));
const service = new SecondwindService({ initialMode: 'on' });
const rewritten = await service.rewrite({
  body,
  request,
  sessionId: 'native-smoke',
  modelId: 'gpt-5.6-sol',
});
const repeated = await service.rewrite({
  body,
  request,
  sessionId: 'native-smoke',
  modelId: 'gpt-5.6-sol',
});

console.log(JSON.stringify({
  originalBytes: body.length,
  rewrittenBytes: rewritten.length,
  repeatedBytes: repeated.length,
  repeatStable: rewritten.equals(repeated),
  snapshot: service.snapshot(),
}));
service.close();
