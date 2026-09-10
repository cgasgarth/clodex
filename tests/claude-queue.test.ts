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
  const row = (content: string) => JSON.stringify({type:'queue-operation',operation:'enqueue',sessionId,content,timestamp:new Date().toISOString()})+'\n';
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

it('ignores older enqueues written late but delivers a new identical message', async () => {
  const root = await mkdtemp(join(tmpdir(),'clodex-queue-test-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const project = join(root,'project');
  await mkdir(project);
  const path = join(project,`${sessionId}.jsonl`);
  await Bun.write(path,'');
  const received: QueuedSessionInput[] = [];
  const old = new Date(Date.now()-1000).toISOString();
  const row = (timestamp: string) => JSON.stringify({type:'queue-operation',operation:'enqueue',sessionId,
    content:'Continue the task.',timestamp})+'\n';
  const stop = await watchClaudeQueue(sessionId,input=>received.push(input),root);
  try {
    await appendFile(path,row(old));
    await stop.flush();
    expect(received).toHaveLength(0);
    await appendFile(path,row(new Date().toISOString()));
    await stop.flush();
    expect(received.map(input=>input.text)).toEqual(['Continue the task.']);
  } finally { stop.close(); await rm(root,{recursive:true,force:true}); }
});
