import { afterEach, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createResponsesWebSocketFetch, resetResponsesWebSocketConnectionsForTests,
  withResponsesWebSocketDiagnosticContext } from '../src/oauth/responses-websocket.js';
import { ResponseSteeringSession, type QueuedSessionInput } from '../src/oauth/responses-websocket/steering.js';
import type { JsonObject } from '../src/oauth/responses-websocket/types.js';
import { addSteeredUsage } from '../src/oauth/responses-websocket/protocol.js';

const sockets: Socket[] = [];
class Socket extends EventEmitter {
  sent: JsonObject[] = [];
  closeCount = 0;
  constructor() { super(); sockets.push(this); }
  send(data: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(data)); callback?.(); }
  close() { this.closeCount += 1; }
  pause() { return true; }
  resume() { return true; }
  event(value: JsonObject) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
afterEach(() => { resetResponsesWebSocketConnectionsForTests(); sockets.length = 0; });

it('adds usage from each steered response without dropping cached or reasoning tokens', () => {
  expect(addSteeredUsage({input_tokens:12,output_tokens:3,total_tokens:15,
    input_tokens_details:{cached_tokens:8},output_tokens_details:{reasoning_tokens:2}},
  {input_tokens:10,output_tokens:4,total_tokens:14,
    input_tokens_details:{cached_tokens:5},output_tokens_details:{reasoning_tokens:3}})).toEqual({
      input_tokens:22,output_tokens:7,total_tokens:29,
      input_tokens_details:{cached_tokens:13},output_tokens_details:{reasoning_tokens:5},
    });
});

it('does not subscribe to local transcripts for an ordinary API request', async () => {
  let subscribed=false;
  const fetch=createResponsesWebSocketFetch('wss://test.invalid',undefined,{webSocketConstructor:Socket,
    subscribeQueuedInput:async()=>{subscribed=true;return{flush:async()=>{},close:()=>{}};}});
  const response=await withResponsesWebSocketDiagnosticContext({claudeSessionId:'00000000-0000-4000-8000-000000000001'},
    ()=>fetch('https://test.invalid',{method:'POST',body:JSON.stringify(payload)}));
  const socket=sockets[0]!;socket.emit('open');
  complete(socket,'resp_1','Done.');
  await response.text();
  expect(subscribed).toBe(false);
});
const payload = { model: 'gpt-6-astra', prompt_cache_key: 'steering-test', tools: [{type:'function',name:'Read',parameters:{type:'object'}}],
  input: [{role:'user',content:'work'}] };

function complete(socket: Socket, id: string, text: string, phase = 'final_answer') {
  const item = { type: 'message', id: `msg_${id}`, role: 'assistant', phase, content: [{type:'output_text',text}] };
  socket.event({type:'response.output_item.added',output_index:0,item});
  socket.event({type:'response.output_text.delta',item_id:`msg_${id}`,output_index:0,content_index:0,delta:text});
  socket.event({type:'response.output_item.done',output_index:0,item});
  socket.event({type:'response.completed',response:{id,status:'completed',output:[item]}});
}

it.each(['response.completed', 'response.incomplete'])('keeps the response open after %s until the steered successor finishes', async terminal => {
  let receive: ((input: QueuedSessionInput) => void) | undefined;
  let cleaned = false;
  const fetch = createResponsesWebSocketFetch('wss://test.invalid/responses', undefined, {
    webSocketConstructor: Socket,
    subscribeQueuedInput: async (_id, callback) => { receive = callback; return {flush:async()=>{},close:()=>{cleaned=true;}}; },
  });
  const response = await withResponsesWebSocketDiagnosticContext({allowLocalClaudeQueue:true,claudeSessionId:'00000000-0000-4000-8000-000000000001'},
    () => fetch('https://test.invalid', {method:'POST',body:JSON.stringify(payload)}));
  const socket = sockets[0]!;
  socket.emit('open');
  socket.event({type:'response.created',response:{id:'resp_1'}});
  receive?.({id:'event_1',kind:'human',text:'Use the revised target.'});
  expect(socket.sent[1]).toMatchObject({type:'response.steer',previous_response_id:'resp_1',input:[{role:'user',content:'Use the revised target.'}]});
  socket.event({type:'response.steer.accepted',steer:{id:'steer_1',previous_response_id:'resp_1'}});
  socket.event({type:terminal,response:{id:'resp_1',output:[],incomplete_details: terminal==='response.incomplete'?{reason:'steered'}:null}});
  expect(cleaned).toBe(false);
  expect(socket.closeCount).toBe(0);
  socket.event({type:'response.created',response:{id:'resp_2'}});
  complete(socket,'resp_2','Revised target applied.');
  const body = await response.text();
  expect(body).toContain('Revised target applied.');
  expect(body.match(/"type":"response.completed"/g)).toHaveLength(1);
  expect(body).not.toContain('"reason":"steered"');
  expect(cleaned).toBe(true);
  expect(socket.closeCount).toBe(0);
  const echo = {role:'user',content:'<system-reminder>\nThe user sent a new message while you were working:\nUse the revised target.\n\nThis is how Claude Code surfaces messages the user sends mid-turn. Address the message above as you continue this turn.\n</system-reminder>'};
  const echoed = await fetch('https://test.invalid',{method:'POST',body:JSON.stringify({...payload,input:[...payload.input,
    {role:'assistant',content:[{type:'output_text',text:'Revised target applied.'}]},echo]})});
  expect(sockets).toHaveLength(1);
  expect(socket.sent.at(-1)).toMatchObject({type:'response.create',previous_response_id:'resp_2',input:[]});
  socket.event({type:'response.created',response:{id:'resp_3'}});
  complete(socket,'resp_3','Done.');
  await echoed.text();
});

it('keeps accepted input until tool results arrive and does not send it twice', () => {
  const session = new ResponseSteeringSession();
  const sent: unknown[] = [];
  session.attach(payload.input, event => sent.push(event));
  session.created('resp_1');
  session.submit({id:'event_1',kind:'human',text:'Use the revised target.'});
  session.handle({type:'response.steer.accepted',steer:{id:'steer_1',previous_response_id:'resp_1'}});
  session.handle({type:'response.steer.pending',steer:{id:'steer_1',previous_response_id:'resp_1'},required_input:[{type:'function_call_output',call_id:'call_1'}]});
  session.pause();
  expect(session.awaitingSuccessor).toBe(true);
  const committed = session.created('resp_2');
  expect(committed).toEqual([{role:'user',content:'Use the revised target.'}]);
  expect(sent).toHaveLength(1);
  expect(session.awaitingSuccessor).toBe(false);
});

it('preserves a failed steer for normal Claude delivery', () => {
  const session = new ResponseSteeringSession();
  session.attach(payload.input, () => {});
  session.created('resp_1');
  session.submit({id:'event_1',kind:'human',text:'Use the revised target.'});
  session.handle({type:'response.steer.failed',steer:{id:'steer_1',previous_response_id:'resp_1'},error:{code:'steering_not_supported'}});
  const input = [...payload.input,{role:'user',content:'<system-reminder>\nThe user sent a new message while you were working:\nUse the revised target.\n\nThis is how Claude Code surfaces messages the user sends mid-turn. Address the message above as you continue this turn.\n</system-reminder>'}];
  expect(session.reconcile(input)).toEqual(input);
  expect(session.awaitingSuccessor).toBe(false);
});

it.each(['response.completed', 'response.incomplete'])(
'releases %s and delivers the queued task after successor creation fails', async terminal => {
  let receive: ((input: QueuedSessionInput) => void) | undefined;
  let cleaned = false;
  const fetch = createResponsesWebSocketFetch('wss://test.invalid', undefined, {
    webSocketConstructor: Socket,
    subscribeQueuedInput: async (_id, callback) => {
      receive = callback;
      return {flush:async()=>{},close:()=>{cleaned=true;}};
    },
  });
  const first = await withResponsesWebSocketDiagnosticContext(localContext,
    () => fetch('https://test.invalid',{method:'POST',body:JSON.stringify(payload)}));
  const socket = sockets[0]!;
  socket.emit('open');
  socket.event({type:'response.created',response:{id:'resp_1'}});
  const task = '<task-notification>\n<status>failed</status>\n<summary>Background command failed with exit code 1</summary>\n</task-notification>';
  receive?.({id:'task',kind:'task',text:task});
  socket.event({type:'response.steer.accepted',steer:{id:'steer_1',previous_response_id:'resp_1'}});
  socket.event({type:terminal,response:{id:'resp_1',output:[],
    incomplete_details:terminal==='response.incomplete'?{reason:'steered'}:null}});
  await Bun.sleep(0);
  expect(cleaned).toBe(false);
  socket.event({type:'response.steer.failed',steer:{id:'steer_1',previous_response_id:'resp_1'},
    error:{code:'successor_creation_failed'}});
  expect(await first.text()).toContain(`"type":"${terminal}"`);
  expect(cleaned).toBe(true);
  const echo = {role:'user',content:task};
  const second = await fetch('https://test.invalid', {method:'POST',body:JSON.stringify({...payload,input:[...payload.input,echo]})});
  const next = sockets.at(-1)!;
  if (next !== socket) next.emit('open');
  expect(next.sent.at(-1)?.input).toContainEqual(echo);
  next.event({type:'response.created',response:{id:'resp_2'}});
  complete(next,'resp_2','Background command failed with exit code 1.');
  expect(await second.text()).toContain('Background command failed with exit code 1.');
});

it('removes only the committed echo after its original request prefix', () => {
  const envelope = '<system-reminder>\nThe user sent a new message while you were working:\nUse the revised target.\n\nThis is how Claude Code surfaces messages the user sends mid-turn. Address the message above as you continue this turn.\n</system-reminder>';
  const earlier = {role:'user',content:envelope};
  const session = new ResponseSteeringSession();
  session.attach([earlier,...payload.input], () => {});
  session.created('resp_1');
  session.submit({id:'event_1',kind:'human',text:'Use the revised target.'});
  session.handle({type:'response.steer.accepted',steer:{id:'steer_1',previous_response_id:'resp_1'}});
  session.created('resp_2');
  expect(session.reconcile([earlier,...payload.input,{role:'user',content:envelope}])).toEqual([earlier,...payload.input]);
});

it('replays native reasoning, assistant phase, and hosted search after a lost response chain', async () => {
  const fetch = createResponsesWebSocketFetch('wss://test.invalid/responses', undefined, {webSocketConstructor:Socket});
  const first = await fetch('https://test.invalid',{method:'POST',body:JSON.stringify(payload)});
  const socket = sockets[0]!;
  socket.emit('open');
  const search = {type:'web_search_call',id:'ws_1',status:'completed',action:{type:'search',queries:['test'],sources:[{type:'url',url:'https://example.com'}]}};
  const reasoning = {type:'reasoning',id:'rs_1',encrypted_content:'opaque',summary:[]};
  const message = {type:'message',id:'msg_1',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'I found the source.',annotations:[{type:'url_citation',url:'https://example.com',title:'Source',start_index:0,end_index:19}]}]};
  socket.event({type:'response.completed',response:{id:'resp_1',output:[search,reasoning,message]}});
  await first.text();
  const next = {role:'user',content:'Continue.'};
  const second = await fetch('https://test.invalid',{method:'POST',body:JSON.stringify({...payload,input:[...payload.input,
    {type:'reasoning',encrypted_content:'opaque',summary:[]},
    {role:'assistant',content:[{type:'output_text',text:'I found the source.'}]},next]})});
  socket.event({type:'error',error:{code:'previous_response_not_found'}});
  const replacement = sockets.at(-1)!;
  replacement.emit('open');
  expect(replacement.sent[0]?.input).toEqual([...payload.input,search,reasoning,message,next]);
  replacement.event({type:'response.created',response:{id:'resp_2'}});
  complete(replacement,'resp_2','Done.');
  await second.text();
});

it('continues accepted steering through a client tool boundary without resending the update', async () => {
  let receive: ((input: QueuedSessionInput) => void) | undefined;
  const fetch = createResponsesWebSocketFetch('wss://test.invalid/responses',undefined,{
    webSocketConstructor:Socket,subscribeQueuedInput:async(_id,callback)=>{receive=callback;return{flush:async()=>{},close:()=>{}};},
  });
  const run = (input: object[]) => withResponsesWebSocketDiagnosticContext({allowLocalClaudeQueue:true,claudeSessionId:'00000000-0000-4000-8000-000000000001'},
    ()=>fetch('https://test.invalid',{method:'POST',body:JSON.stringify({...payload,input})}));
  const first = await run(payload.input);
  const socket = sockets[0]!;socket.emit('open');
  socket.event({type:'response.created',response:{id:'resp_1'}});
  receive?.({id:'event_1',kind:'human',text:'Use the new target.'});
  socket.event({type:'response.steer.accepted',steer:{id:'steer_1',previous_response_id:'resp_1'}});
  const call = {type:'function_call',call_id:'call_1',name:'Read',arguments:'{"path":"example.txt"}'};
  socket.event({type:'response.output_item.done',output_index:0,item:call});
  socket.event({type:'response.completed',response:{id:'resp_1',output:[call]}});
  await first.text();
  socket.event({type:'response.steer.pending',steer:{id:'steer_1',previous_response_id:'resp_1'},required_input:[{type:'function_call_output',call_id:'call_1'}]});
  expect(socket.closeCount).toBe(0);
  const output = {type:'function_call_output',call_id:'call_1',output:'file contents'};
  const echo = {role:'user',content:'<system-reminder>\nThe user sent a new message while you were working:\nUse the new target.\n\nThis is how Claude Code surfaces messages the user sends mid-turn. Address the message above as you continue this turn.\n</system-reminder>'};
  const second = await run([...payload.input,call,output,echo]);
  expect(socket.sent.at(-1)).toMatchObject({type:'response.create',previous_response_id:'resp_1',input:[output]});
  expect(socket.sent.filter(frame=>frame.type==='response.steer')).toHaveLength(1);
  socket.event({type:'response.created',response:{id:'resp_2'}});
  complete(socket,'resp_2','Updated plan.');
  expect(await second.text()).toContain('Updated plan.');
  const next = {role:'user',content:'Continue.'};
  const third = await run([...payload.input,call,output,echo,
    {role:'assistant',content:[{type:'output_text',text:'Updated plan.'}]},next]);
  socket.event({type:'error',error:{code:'previous_response_not_found'}});
  const replacement=sockets.at(-1)!;
  replacement.emit('open');
  expect(replacement.sent[0]?.input).toEqual([...payload.input,call,
    {role:'user',content:'Use the new target.'},output,
    {type:'message',id:'msg_resp_2',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Updated plan.'}]},next]);
  replacement.event({type:'response.created',response:{id:'resp_3'}});
  complete(replacement,'resp_3','Done.');
  await third.text();
});

it.each(['background command','workflow','subagent'])('keeps a %s completion marked as automated input', source => {
  const session=new ResponseSteeringSession();
  const sent: JsonObject[]=[];
  session.attach(payload.input,event=>sent.push(JSON.parse(JSON.stringify(event))));
  session.created('resp_1');
  session.submit({id:source,kind:'task',text:`<task-notification>\n<status>completed</status>\n<summary>${source} completed</summary>\n</task-notification>`});
  expect(sent[0]).toMatchObject({type:'response.steer',input:[{role:'user',content:expect.stringContaining('[SYSTEM NOTIFICATION - NOT USER INPUT]')}]});
});

it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex'])(
'delivers queued input before closing a local %s turn', async model => {
  let receive: ((input: QueuedSessionInput) => void) | undefined;
  let closed = false;
  const fetch = createResponsesWebSocketFetch('wss://test.invalid', undefined, {
    webSocketConstructor: Socket,
    subscribeQueuedInput: async (_id, callback) => {
      receive = callback;
      return { flush: async () => {}, close: () => { closed = true; } };
    },
  });
  const response = await withResponsesWebSocketDiagnosticContext({allowLocalClaudeQueue:true,claudeSessionId:'00000000-0000-4000-8000-000000000001'},
    () => fetch('https://test.invalid', {method:'POST',body:JSON.stringify({...payload,model})}));
  const socket = sockets[0]!;
  socket.emit('open');
  socket.event({type:'response.created',response:{id:'resp_1'}});
  receive?.({id:'human',kind:'human',text:'Use the new target.'});
  for (const source of ['background command', 'workflow', 'subagent']) {
    receive?.({id:source,kind:'task',text:`<task-notification>\n<status>completed</status>\n<summary>${source} completed</summary>\n</task-notification>`});
  }
  expect(socket.sent).toHaveLength(1);
  complete(socket, 'resp_1', 'Original answer.');
  await Bun.sleep(0);
  expect(closed).toBe(false);
  expect(socket.closeCount).toBe(0);
  expect(socket.sent.at(-1)).toMatchObject({type:'response.create',model,previous_response_id:'resp_1',input:[
    {role:'user',content:'Use the new target.'},
    ...['background command','workflow','subagent'].map(source => ({role:'user',content:expect.stringContaining(`<summary>${source} completed</summary>`)})),
  ]});
  socket.event({type:'response.created',response:{id:'resp_2'}});
  complete(socket, 'resp_2', 'Updated target and task results applied.');
  const body = await response.text();
  expect(body).toContain('Updated target and task results applied.');
  expect(body.match(/"type":"response.completed"/g)).toHaveLength(1);
  expect(closed).toBe(true);
  expect(socket.closeCount).toBe(0);
});

const humanEcho = (text: string) => ({role:'user',content:`<system-reminder>\nThe user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn. Address the message above as you continue this turn.\n</system-reminder>`});
const solPayload = {...payload,model:'gpt-5.6-sol'};
const localContext = {allowLocalClaudeQueue:true,claudeSessionId:'00000000-0000-4000-8000-000000000001'};
const assistant = (text: string) => ({role:'assistant',content:[{type:'output_text',text}]});

it.each(['wrapped', 'plain', 'missing'])('waits for Sol client tool results, with Claude echo=%s', async echoKind => {
  const withEcho = echoKind !== 'missing';
  let receive: ((input: QueuedSessionInput) => void) | undefined;
  const fetch = createResponsesWebSocketFetch('wss://test.invalid', undefined, {
    webSocketConstructor: Socket,
    subscribeQueuedInput: async (_id, callback) => {
      receive = callback;
      return {flush:async()=>{},close:()=>{}};
    },
  });
  const run = (input: object[]) => withResponsesWebSocketDiagnosticContext(localContext,
    () => fetch('https://test.invalid', {method:'POST',body:JSON.stringify({...solPayload,input})}));
  const first = await run(payload.input);
  const socket = sockets[0]!;
  socket.emit('open');
  socket.event({type:'response.created',response:{id:'resp_1'}});
  receive?.({id:'human',kind:'human',text:'Use the new target.'});
  const call = {type:'function_call',call_id:'call_1',name:'Read',arguments:'{"path":"example.txt"}'};
  socket.event({type:'response.output_item.done',output_index:0,item:call});
  socket.event({type:'response.completed',response:{id:'resp_1',output:[call]}});
  await first.text();
  expect(socket.sent).toHaveLength(1);
  const output = {type:'function_call_output',call_id:'call_1',output:'file contents'};
  expect(socket.closeCount).toBe(0);
  const echo = echoKind === 'plain' ? {role:'user',content:'Use the new target.'} : humanEcho('Use the new target.');
  const second = await run([...payload.input,call,output,...(withEcho ? [echo] : [])]);
  expect(socket.sent.at(-1)).toMatchObject({type:'response.create',previous_response_id:'resp_1',input:[output,...(withEcho ? [echo] : [])]});
  socket.event({type:'response.created',response:{id:'resp_2'}});
  complete(socket,'resp_2','Tool result applied.');
  await Bun.sleep(0);
  if (withEcho) expect(socket.sent).toHaveLength(2);
  else {
    expect(socket.sent.at(-1)).toMatchObject({type:'response.create',previous_response_id:'resp_2',input:[{role:'user',content:'Use the new target.'}]});
    socket.event({type:'response.created',response:{id:'resp_3'}});
    complete(socket,'resp_3','New target applied.');
  }
  const body = await second.text();
  expect(body.match(/"type":"response.completed"/g)).toHaveLength(1);
  expect(socket.closeCount).toBe(0);
});

it.each(['wrapped', 'plain'])('drains late Sol input, reconciles its %s echo, and keeps native replay', async echoKind => {
  let flushed = false;
  const fetch = createResponsesWebSocketFetch('wss://test.invalid', undefined, {
    webSocketConstructor: Socket,
    subscribeQueuedInput: async (_id, receive) => ({close:()=>{},flush:async()=>{
      if (flushed) return;
      flushed = true;
      receive({id:'late-human',kind:'human',text:'Use the new target.'});
    }}),
  });
  const run = (input: object[]) => withResponsesWebSocketDiagnosticContext(localContext,
    () => fetch('https://test.invalid', {method:'POST',body:JSON.stringify({...solPayload,input})}));
  const first = await run(payload.input);
  const socket = sockets[0]!;
  socket.emit('open');
  socket.event({type:'response.created',response:{id:'resp_1'}});
  complete(socket,'resp_1','Original answer.','commentary');
  await Bun.sleep(0);
  expect(socket.sent.at(-1)).toMatchObject({previous_response_id:'resp_1',input:[{role:'user',content:'Use the new target.'}]});
  socket.event({type:'response.created',response:{id:'resp_2'}});
  complete(socket,'resp_2','New target applied.');
  await first.text();
  const echo = echoKind === 'plain' ? {role:'user',content:'Use the new target.'} : humanEcho('Use the new target.');
  const input = [...payload.input,assistant('Original answer.'),assistant('New target applied.'),echo];
  const second = await run(input);
  expect(sockets).toHaveLength(1);
  expect(socket.sent.at(-1)).toMatchObject({type:'response.create',previous_response_id:'resp_2',input:[]});
  socket.event({type:'error',error:{code:'previous_response_not_found'}});
  const replacement = sockets.at(-1)!;
  replacement.emit('open');
  expect(replacement.sent[0]?.input).toEqual([
    ...payload.input,
    {type:'message',id:'msg_resp_1',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Original answer.'}]},
    {role:'user',content:'Use the new target.'},
    {type:'message',id:'msg_resp_2',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'New target applied.'}]},
  ]);
  replacement.event({type:'response.created',response:{id:'resp_3'}});
  complete(replacement,'resp_3','Done.');
  await second.text();
});

it('matches each Claude echo to only one queued occurrence', () => {
  const session = new ResponseSteeringSession('boundary');
  session.attach(payload.input,()=>{});
  session.created('resp_1');
  session.submit({id:'first',kind:'human',text:'Continue.'});
  session.submit({id:'second',kind:'human',text:'Continue.'});
  const input = [...payload.input,humanEcho('Continue.')];
  expect(session.reconcile(input)).toEqual(input);
  expect(session.takeBoundaryInput('resp_2')).toEqual([{role:'user',content:'Continue.'}]);
  session.created('resp_3');
  const later = [...input,humanEcho('Continue.')];
  expect(session.reconcile(later)).toEqual(input);
});
