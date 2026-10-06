import './no-network.mjs';
// Offline cancellation gates with new payload references ENABLED.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {Session,SessionStore} from '@deepseek-ai/dsh-session';
import {createUserMessage,createAssistantMessage,createToolResultMessage,LlmRuntime,LlmAdapter} from '@deepseek-ai/dsh-llm';
import {TokenMeter} from '@deepseek-ai/dsh-token-meter';
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
import {AdaptiveCompactionEngine} from '../plugin/index.js';
import {toolResultContent,unfoldToolPayloads} from '../plugin/prompt.js';
const pins=['MUST: preserve BLUE_FINCH exactly.','CONSTRAINT: do not deploy or change database schema.','Q1: Explain the unresolved migration risk.','Q2: Supply the exact verification command.'];
const payload=('Exact unchanged source: ownerVersion=19; ERR_LEASE_RACE remains unresolved.\r\n').repeat(24)+'no-newline-tail';
const raw=JSON.stringify({schema_version:1,task_state:{goal:'Inspect BLUE_FINCH without deployment',open:[pins[2],pins[3]]},critical_facts:['ownerVersion=19; ERR_LEASE_RACE'],user_constraints:[pins[0],pins[1]],next_step:'Verify locally'});
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const records=[];
for(const mode of ['before-start','during-async-summary','before-commit-ignoring-adapter'])test('payload references enabled: cancellation/'+mode,async()=>{
 const controller=new AbortController(),reason=new Error('OFFLINE_CANCELLATION_'+mode);
 let enter,release;const entered=new Promise(r=>enter=r),released=new Promise(r=>release=r);
 const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);new LlmRuntime(ctx);new TokenMeter(ctx);
 class Adapter extends LlmAdapter {
  calls=[];completed=false;
  async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:32768},defaultMaxTokens:1024};}
  async *stream(options){
   // Deliberately never observes options.signal: the transaction must still abort.
   this.calls.push(options);
   if(mode==='during-async-summary'){
    yield {type:'text-delta',index:0,text:raw.slice(0,40)};
    enter();await released;
    yield {type:'text-delta',index:0,text:raw.slice(40)};
   }else yield {type:'text-delta',index:0,text:raw};
   yield {type:'finish',reason:{kind:'stop'}};this.completed=true;
  }
 }
 const adapter=new Adapter();ctx.llm.registerAdapter(['offline'],adapter);
 const engine=new AdaptiveCompactionEngine(ctx,{profile:'custom',auto:false,retainTokens:1024,maxTokens:768,compactionRetries:0,summary:{dedupeToolPayloads:true,onParseError:'fail'},security:{localProviders:['offline']},evidence:{enabled:false}});
 const s=Session.create('cost-cancel-'+mode),append={surfaceOp:'append'};
 s.append('turn/start',{turn:1});s.append('request/header',{header:{config:{provider:'offline',model:'mock',maxTokens:1024}},reason:'initial'});
 const start=s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:pins.join('\n')}]}),append).seq;
 let end;
 for(let i=0;i<6;i++){
  const id='cancel-tool-'+i,call={type:'tool-call',id,name:'ReadSource',arguments:'{"path":"a.py"}'};
  s.append('step/start',{turn:1,step:i+1});s.append('assistant/message',{turn:1,step:i+1,message:createAssistantMessage({source:{provider:'offline',model:'mock'},content:[call]}),stream:[]},append);
  s.append('tool/call',{turn:1,step:i+1,callId:id,name:call.name,arguments:call.arguments});
  end=s.append('tool/result',{turn:1,step:i+1,message:createToolResultMessage({callId:id,isError:i>=3,content:[{type:'text',text:payload}]})},append).seq;s.append('step/end',{turn:1,step:i+1});
 }
 s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Untouched retained tail'}]}),append);
 const before=s.snapshotEvents(),surface=s.surface.nodes.slice(),generation=s.surface.replaceGeneration;
 const sourceMessages=()=>s.surface.nodes.map(seq=>s.deriveEventMessage(s.eventAt(seq))).filter(Boolean);
 const originalMessages=sourceMessages(),beforeHash=sha(before),count=before.length;
 const idsAndErrors=()=>sourceMessages().filter(m=>m.source?.kind==='tool').map(m=>({id:m.id,source:m.source,callId:m.content[0].toolCallId,isError:m.content[0].isError,content:m.content}));
 const expectedToolData=idsAndErrors();assert.equal(expectedToolData.filter(x=>x.isError).length,3);
 let summaryCompletedBeforeAbort=false;
 if(mode==='before-commit-ignoring-adapter'){
  // Abort at the upstream frame-pricing boundary AFTER plugin summarization,
  // without replacing/bypassing the plugin's summarize cancellation check.
  const real=ctx.tokenMeter.estimateMessage.bind(ctx.tokenMeter);
  ctx.tokenMeter.estimateMessage=message=>{if(message.source?.kind==='plugin'&&message.source.plugin==='compact'){assert(adapter.completed);summaryCompletedBeforeAbort=true;controller.abort(reason);}return real(message);};
 }
 if(mode==='before-start')controller.abort(reason);
 const agent={session:s,options:{provider:'offline',model:'mock',maxTokens:1024}};
 const operation=mode==='before-start'?engine.compactIfNeeded(agent,'pressure',controller.signal):engine.compactRegion(start,end,agent,controller.signal);
 // Observe rejection immediately so asynchronous abort cannot create unhandled rejection.
 const rejected=assert.rejects(operation);
 if(mode==='during-async-summary'){await entered;controller.abort(reason);release();}
 await rejected;assert(controller.signal.aborted);
 assert.equal(sha(s.snapshotEvents().slice(0,count)),beforeHash);assert.deepEqual(s.surface.nodes,surface);assert.equal(s.surface.replaceGeneration,generation);assert.deepEqual(sourceMessages(),originalMessages);assert.deepEqual(idsAndErrors(),expectedToolData);
 const snapshot=JSON.stringify(s.snapshotEvents());for(const pin of pins)assert(snapshot.includes(pin));
 const events=s.snapshotEvents(),starts=events.filter(e=>e.type==='compaction/start').length,ends=events.filter(e=>e.type==='compaction/end').length;
 assert.equal(events.filter(e=>e.type==='compaction/summary').length,0);assert.equal(starts,ends);
 const pending=new Set();for(const m of sourceMessages()){if(m.role==='assistant')for(const b of m.content)if(b.type==='tool-call')pending.add(b.id);if(m.source?.kind==='tool')assert(pending.delete(m.source.callId));}assert.equal(pending.size,0);
 let references=0;
 if(mode==='before-start'){assert.equal(adapter.calls.length,0);assert.equal(events.length,count);assert.equal(starts,0);}
 else{
  assert.equal(adapter.calls.length,1);assert.equal(starts,1);
  const sent=adapter.calls[0].messages.slice(0,-1);references=sent.filter(m=>toolResultContent(m)?.[0]?.text.startsWith('[adaptive-tool:v1 ref=')).length;assert.equal(references,4);
  const decoded=unfoldToolPayloads(sent);assert.deepEqual(decoded,originalMessages.slice(0,-1));
 }
 if(mode==='before-commit-ignoring-adapter')assert(summaryCompletedBeforeAbort);
 records.push({mode,dedupe_enabled:true,mock_calls:adapter.calls.length,encoded_references:references,adapter_observes_signal:false,summary_completed_before_abort:summaryCompletedBeforeAbort,source_history_sha256:beforeHash,original_history_messages_unchanged:true,pins_constraints_questions_unchanged:true,tool_id_error_payload_unchanged:true,tool_pairs_balanced:true,surface_generation_unchanged:true,commits:0,partial_commit:false,transaction_starts:starts,transaction_ends:ends,new_real_api_calls:0});
});
test.after(()=>writeFileSync(new URL('../cost-cancellation-results.json',import.meta.url),JSON.stringify({records,new_real_api_calls:0},null,2)+'\n'));
