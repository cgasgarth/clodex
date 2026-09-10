import { expect, it } from 'bun:test';
import { appendFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchClaudeQueue } from '../src/runtime/claude-queue.js';
import type { QueuedSessionInput } from '../src/oauth/responses-websocket/steering.js';
import { waitForCondition } from './test-helpers.js';

it('reads newly enqueued text and task events once, including split UTF-8 records', async () => {
  const root = await mkdtemp(join(tmpdir(),'clodex-queue-test-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const project = join(root,'project');
  await mkdir(project);
  const path = join(project,`${sessionId}.jsonl`);
  const row = (content: string) => JSON.stringify({type:'queue-operation',operation:'enqueue',sessionId,content})+'\n';
  await Bun.write(path,row('Earlier input'));
  const received: QueuedSessionInput[] = [];
  const stop = await watchClaudeQueue(sessionId,input => received.push(input),root);
  try {
    const human = Buffer.from(row('Use café and 日本語.'));
    const split = human.indexOf(Buffer.from('é'))+1;
    await appendFile(path,human.subarray(0,split));
    await appendFile(path,human.subarray(split));
    const task='<task-notification>\n<status>completed</status>\n<result>done</result>\n</task-notification>';
    await appendFile(path,row(task));
    await appendFile(path,JSON.stringify({type:'queue-operation',operation:'remove',sessionId,content:task})+'\n');
    await waitForCondition(() => expect(received).toHaveLength(2));
    expect(received.map(({kind,text})=>({kind,text}))).toEqual([
      {kind:'human',text:'Use café and 日本語.'},{kind:'task',text:task},
    ]);
    expect(received[0]?.id).not.toBe(received[1]?.id);
  } finally { stop.close(); await rm(root,{recursive:true,force:true}); }
});
