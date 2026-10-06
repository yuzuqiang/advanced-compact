// Read-only instrumentation over the user's actual headless runner.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
const require=createRequire(path.join(process.env.DSH_REPO,'apps/cli/package.json'));
const {createUserMessage,createAssistantMessage,createToolResultMessage}=await import(require.resolve('@deepseek-ai/dsh-llm'));
export const name='headless-performance-observer';
export const inject=['llm','compaction','tokenMeter'];
const MOCK=JSON.stringify({schema_version:1,task_state:{goal:'Recall the latest project facts accurately.',current_plan:['Return the six requested fields.'],completed:['Inspected prepared original source snapshots.'],open:['Answer the current recall question.']},decisions:[],files:[],tests:[],errors:[],critical_facts:[],next_step:'Return the requested JSON.'});
export function apply(ctx){
 const cfg=JSON.parse(fs.readFileSync(process.env.HEADLESS_PERF_JOB,'utf8'));fs.mkdirSync(cfg.output,{recursive:true});
 const write=(name,value)=>fs.writeFileSync(path.join(cfg.output,name),JSON.stringify(value,null,2));
 const log=(kind,data)=>fs.appendFileSync(path.join(cfg.output,'events.jsonl'),JSON.stringify({time:new Date().toISOString(),kind,data})+'\n');
 const trace=new AsyncLocalStorage();let agent,seeded=false,calls=0;const start=performance.now();
 const sha=s=>createHash('sha256').update(s).digest('hex');
 function seed(a){
  if(seeded)throw Error('Unexpected additional agent: no subagents in this performance task');seeded=true;agent=a;
  if(!cfg.history.reads.length){log('seed',{sessionId:a.session.id,reads:0});return;}
  const s=a.session;s.append('turn/start',{turn:0});
  s.append('request/header',{header:cfg.history.header,reason:'initial'});
  s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:cfg.history.instruction}]}),{surfaceOp:'append'});
  for(let i=0;i<cfg.history.reads.length;i++){
   const read=cfg.history.reads[i],step=i+1;const call={type:'tool-call',id:'perf-read-'+step,name:'read',arguments:JSON.stringify({file_path:read.path,offset:read.start_line,limit:read.end_line-read.start_line+1})};
   s.append('step/start',{turn:0,step});
   s.append('assistant/message',{turn:0,step,message:createAssistantMessage({content:[call],source:{provider:'prepared-replay',model:'original-source-snapshot'}}),stream:[{type:'chunk',time:0,chunk:{type:'block-end',index:0,block:call}},{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'tool-calls'}}}]},{surfaceOp:'append'});
   s.append('tool/call',{turn:0,step,callId:call.id,name:call.name,arguments:call.arguments});
   s.append('tool/result',{turn:0,step,message:createToolResultMessage({callId:call.id,isError:false,content:[{type:'text',text:`Prepared unchanged source snapshot: ${read.path}, lines ${read.start_line}-${read.end_line}\n${read.content}`}]})},{surfaceOp:'append'});
   s.append('step/end',{turn:0,step});
   if(cfg.history.correction&&i===Math.floor(cfg.history.reads.length/2))s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:cfg.history.correction}]}),{surfaceOp:'append'});
  }
  s.append('turn/end',{turn:0,reason:{kind:'completed'}});
  log('seed',{sessionId:s.id,reads:cfg.history.reads.length,historySha256:sha(JSON.stringify(cfg.history)),estimatedTokens:ctx.tokenMeter.measure(s).totalTokens});
  write('seed-messages.json',s.deriveMessages());
 }
 ctx.on('agent/created',({agent:a})=>seed(a),{global:true});
 ctx.on('agent/pre-step',async(payload,next)=>{
  const before=ctx.tokenMeter.measure(payload.agent.session).totalTokens,t=performance.now();
  log('pre-step-start',{turn:payload.turn,step:payload.step,estimatedTokens:before});
  try{return await next();}finally{log('pre-step-end',{turn:payload.turn,step:payload.step,beforeEstimatedTokens:before,afterEstimatedTokens:ctx.tokenMeter.measure(payload.agent.session).totalTokens,wall_ms:performance.now()-t,stats:{...ctx.compaction.stats}});}
 },{global:true,prepend:true});
 ctx.on('llm/stream',async function*(options,next){
  log('llm-options',{purpose:options.purpose??'conversation',messages:options.messages.map(m=>({role:m.role,source:m.source,chars:JSON.stringify(m.content).length})),tools:options.tools?.length});
  const state={purpose:options.purpose??'conversation',sessionId:options.sessionId,start:performance.now(),firstToken:false};const iterator=next()[Symbol.asyncIterator]();
  try{while(true){const part=await trace.run(state,()=>iterator.next());if(part.done)break;const c=part.value;
   if(!state.firstToken&&['text-delta','reasoning-delta','tool-call-delta'].includes(c.type)&&c.text){state.firstToken=true;log('first-token',{index:state.index,purpose:state.purpose,wall_ms:performance.now()-(state.fetchStart??state.start)});}
   if(c.type==='finish'||c.type==='usage')log('sdk-chunk',{index:state.index,purpose:state.purpose,chunk:c});yield c;
  }}finally{await iterator.return?.();}
 },{global:true});
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=typeof input==='string'?input:input.url??String(input);
  if(!url.includes('/chat/completions'))return originalFetch(input,init);
  if(url!=='http://127.0.0.1:8080/v1/chat/completions')throw Error('Performance test rejects non-Strata model dispatch');
  const body=JSON.parse(init.body),state=trace.getStore()??{purpose:'unknown'},index=++calls;
  const cap={compaction:4096,conversation:16384,'session-title':64}[state.purpose];
  if(body.model!==cfg.expectedModel||body.reasoning_effort!=='high'||cap===undefined||body.max_tokens!==cap)throw Error('Unexpected model, reasoning or output cap; no dispatch');
  if(index>cfg.maxCalls)throw Error('Headless performance request cap exceeded');state.index=index;state.fetchStart=performance.now();
  write('request-'+index+'.json',{purpose:state.purpose,body});log('request',{index,purpose:state.purpose,wireSha256:sha(JSON.stringify(body))});
  if(cfg.mode==='offline'){
   const content=state.purpose==='compaction'?MOCK:state.purpose==='session-title'?'Performance fixture':'{"offline":true}';
   const packet=(delta,finish_reason=null)=>({id:'offline-no-inference',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta,finish_reason}]});
   return new Response('data: '+JSON.stringify(packet({role:'assistant',content}))+'\n\ndata: '+JSON.stringify(packet({},'stop'))+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }
  const ledger=path.join(cfg.root,'attempts.jsonl'),previous=fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').split('\n').filter(Boolean).length:0;
  if(previous>=cfg.maxTotalCalls)throw Error('Global performance request cap exceeded');fs.appendFileSync(ledger,JSON.stringify({id:previous+1,job:cfg.id,index,purpose:state.purpose,time:new Date().toISOString(),wireSha256:sha(JSON.stringify(body))})+'\n');
  const response=await originalFetch(input,init);log('response-headers',{index,status:response.status,wall_ms:performance.now()-state.fetchStart});
  if(!response.body)return response;
  const reader=response.body.getReader(),decoder=new TextDecoder();let raw='',first=true;
  const stream=new ReadableStream({async pull(controller){try{const part=await reader.read();if(part.done){raw+=decoder.decode();fs.writeFileSync(path.join(cfg.output,'response-'+index+'.sse'),raw);log('response-end',{index,status:response.status,wall_ms:performance.now()-state.fetchStart});controller.close();}else{if(first){first=false;log('first-byte',{index,wall_ms:performance.now()-state.fetchStart});}raw+=decoder.decode(part.value,{stream:true});controller.enqueue(part.value);}}catch(error){fs.writeFileSync(path.join(cfg.output,'response-'+index+'.sse'),raw);log('response-error',{index,error:String(error),wall_ms:performance.now()-state.fetchStart});controller.error(error);}},cancel(reason){return reader.cancel(reason);}});
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
 ctx.effect(()=>()=>{globalThis.fetch=originalFetch;});
 const capture=()=>{if(!agent)return;const events=agent.session.snapshotEvents(),last=events.filter(e=>e.type==='turn/end'&&e.data.turn>=1).at(-1);const message=events.filter(e=>e.type==='assistant/message'&&e.data.turn>=1).at(-1)?.data.message;const text=(message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  write('native-result.json',{id:cfg.id,mode:cfg.mode,arm:cfg.arm,sessionId:agent.session.id,calls,wall_ms:performance.now()-start,reason:last?.data.reason??null,text,pressure:ctx.tokenMeter.measure(agent.session),compactionStats:{...ctx.compaction.stats},adaptiveConfig:ctx.compaction.adaptive,events});
 };
 ctx.on('session/event',(session,event)=>{log('session-event',{sessionId:session.id,event});if(agent&&session===agent.session&&event.type==='turn/end'&&event.data.turn>=1)capture();},{global:true});
 ctx.effect(()=>()=>capture());
}
