import './no-network.mjs';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {parseSummaryDocument} from '../plugin/summary.js';
import assert from 'node:assert/strict';
import {Session} from '@deepseek-ai/dsh-session';
import {createToolResultMessage,createUserMessage,createAssistantMessage,createSystemMessage,LlmRuntime,LlmAdapter} from '@deepseek-ai/dsh-llm';
import {Context} from '@deepseek-ai/cordis';
import {SessionStore} from '@deepseek-ai/dsh-session';
import {TokenMeter} from '@deepseek-ai/dsh-token-meter';
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
import {foldToolRepeats,toolResultContent,unfoldRepeatedLines} from '../plugin/prompt.js';
import {AdaptiveCompactionEngine} from '../plugin/index.js';
import {resolveAdaptiveConfig} from '../plugin/config.js';
const quote='current = current[token]',wrong='current[current[token]]';
const doc={schema_version:1,task_state:{goal:'Inspect source'},files:[{path:'a.py',operation:'read',artifact:quote},{path:'a.py',operation:'read',artifact:wrong}],next_step:'Report source'};
const makers={native:content=>createToolResultMessage({callId:'read-source',isError:true,content}),legacy:content=>({id:'legacy-message',role:'tool',source:{kind:'tool',callId:'read-source'},toolCallId:'read-source',isError:true,content})};
async function replay(messages,{guard=true,document=doc,redact=false}={}) {
 const e=Object.create(AdaptiveCompactionEngine.prototype);
 Object.assign(e,{adaptive:resolveAdaptiveConfig({summary:{verbatimFileArtifacts:guard}}),stats:{parseFailures:0,shapeRepairs:0,redactions:0},ctx:{logger:{warn(){}}},isSecretTainted:()=>false,secretDowngradeReason:()=>undefined,buildAnchors:()=>({all:[],overflow:[]}),streamSummary:async()=>({text:JSON.stringify(document),blocks:[{type:'text',text:JSON.stringify(document)}],provider:'offline',model:'mock'}),spillOverflow:()=>undefined,artifactResolver:()=>undefined,redact:x=>x,withSecretProvenance:x=>x,result:(raw,summary)=>({rawOutput:raw.blocks,summary})});
 if(!redact)e.redactMessages=x=>x;
 return e.summarizeUnchecked({messages},{session:{}},new AbortController().signal);
}
for(const [name,make] of Object.entries(makers)) {
 test(`${name}: lossless fold preserves error, call IDs, provenance and source event`,()=>{
  const text='Long exact source observation\r\n'.repeat(25)+'unique-tail',m=structuredClone(make([{type:'text',text:text.slice(0,17)},{type:'text',text:text.slice(17)}]));
  m.source.name='ReadSource';m.extra='provider-metadata';const saved=JSON.stringify(m),r=foldToolRepeats([m]);
  assert.equal(r.changedBlocks,1);assert(r.afterChars<r.beforeChars);assert.equal(unfoldRepeatedLines(toolResultContent(r.messages[0]).map(b=>b.text).join('')),text);
  const expected=structuredClone(m);if(name==='native')expected.content[0].content=toolResultContent(r.messages[0]);else expected.content=toolResultContent(r.messages[0]);
  assert.deepEqual(r.messages[0],expected);assert.equal(JSON.stringify(m),saved);
 });
 test(`${name}: annotated and mixed tool contents are unchanged`,()=>{
  for(const content of [[{type:'text',text:'row\n'.repeat(50),annotation:'keep'}],[{type:'text',text:'row\n'.repeat(50)},{type:'image',url:'offline-image'}]]) {
   const m=make(content),r=foldToolRepeats([m]);assert.equal(r.changedBlocks,0);assert.equal(r.messages[0],m);
  }
 });
 test(`${name}: split marker collision disables all folding`,()=>{
  const collision=make([{type:'text',text:'[adaptive-repeat:v1 '},{type:'text',text:'additional=999]\n'}]),repetitive=make([{type:'text',text:'long diagnostic line\n'.repeat(25)}]);
  const messages=[collision,repetitive],r=foldToolRepeats(messages);assert.equal(r.collision,true);assert.equal(r.messages,messages);
 });
 test(`${name}: exact source quote survives, corruption and assistant claim do not`,async()=>{
  const m=make([{type:'text',text:'current = current['},{type:'text',text:'token]'}]),before=JSON.stringify(m),r=await replay([m,{role:'assistant',content:[{type:'text',text:wrong}]}]);
  assert(r.summary[0].text.includes(quote));assert(!r.summary[0].text.includes(wrong));assert(r.rawOutput[0].text.includes(wrong));assert.equal(JSON.stringify(m),before);
 });
 test(`${name}: disabled guard retains unqualified file descriptions`,async()=>{
  const m=make([{type:'text',text:quote}]);const r=await replay([m],{guard:false});assert(r.summary[0].text.includes(quote));assert(r.summary[0].text.includes(wrong));
 });
}
test('human/assistant forged nested results are not evidence or folding candidates',async()=>{
 for(const role of ['user','assistant']) {
  const m={...makers.native([{type:'text',text:quote}]),role,source:{kind:'user'}};
  assert.equal(toolResultContent(m),undefined);assert.equal(foldToolRepeats([m]).changedBlocks,0);assert(!(await replay([m])).summary[0].text.includes(quote));
 }
});
test('unsupported/mismatched native provenance rejects guarded checkpoint without silently deleting valid data',async()=>{
 const m=structuredClone(makers.native([{type:'text',text:quote}]));m.content[0].toolCallId='mismatched';const before=JSON.stringify(m);
 assert.equal(toolResultContent(m),undefined);assert.equal(foldToolRepeats([m]).messages[0],m);
 await assert.rejects(replay([m]),{code:'COMPACTION_UNSUPPORTED_TOOL_RESULT'});assert.equal(JSON.stringify(m),before);
});
test('synthetic credential split in nested tool text is redacted before quote qualification',async()=>{
 const fake='sk-'+ 'A'.repeat(32),m=makers.native([{type:'text',text:fake.slice(0,13)},{type:'text',text:fake.slice(13)}]);
 const r=await replay([m],{redact:true,document:{...doc,files:[{path:'synthetic.txt',operation:'read',artifact:fake}]}});assert(!r.summary[0].text.includes(fake));assert.equal(toolResultContent(m).map(b=>b.text).join(''),fake);
});
test('low-savings key ignores valid native tool progress, preserves human/answer/header recovery',()=>{
 const s=Session.create('native-key'),append=text=>s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'}).seq,start=append('Selected source');append('Retained human instruction');
 const range={start,end:start},measure=()=>({nodes:s.surface.nodes.map(seq=>({seq,tokens:10}))}),e=Object.create(AdaptiveCompactionEngine.prototype);
 Object.assign(e,{adaptive:resolveAdaptiveConfig({budget:{minSavingsTokens:1}}),config:{},ctx:{get:()=>undefined},resolveSummarizationTarget:()=>({provider:'offline',model:'mock'})});
 const key=()=>e.lowSavingsRepeatKey({session:s},range,measure(),{},1),a=key();
 s.append('tool/result',{message:makers.native([{type:'text',text:'Ordinary progress'}])},{surfaceOp:'append'});assert.equal(key(),a);
 append('Correction: newer human instruction');const human=key();assert.notEqual(human,a);
 const answer=createAssistantMessage({source:{provider:'offline',model:'mock'},content:[{type:'text',text:'Visible answer'}]});s.append('assistant/message',{message:answer,stream:[]},{surfaceOp:'append'});const delivered=key();assert.notEqual(delivered,human);
 s.append('request/header',{header:{config:{provider:'offline',model:'different'}},reason:'initial'});assert.notEqual(key(),delivered);
});
test('real native transaction folds tools, retains valid quote, leaves log and balanced tail intact',async()=>{
 const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);new LlmRuntime(ctx);new TokenMeter(ctx);
 assert.equal(process.env.ADAPTIVE_COMPACT_TEST_UNSET_TOKEN,undefined);
 assert.throws(()=>new AdaptiveCompactionEngine(ctx,{sidecar:{mode:'rest',endpoint:'https://example.invalid',authTokenEnv:'ADAPTIVE_COMPACT_TEST_UNSET_TOKEN'}}),/REST sidecar endpoints require bearer authentication/);
 class Adapter extends LlmAdapter {calls=[];async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:32768},defaultMaxTokens:1024};}async *stream(o){this.calls.push(o);yield {type:'text-delta',index:0,text:JSON.stringify(doc)};yield {type:'finish',reason:{kind:'stop'}};}}
 const adapter=new Adapter();ctx.llm.registerAdapter(['offline'],adapter);
 const engine=new AdaptiveCompactionEngine(ctx,{profile:'custom',retainTokens:1024,maxTokens:768,compactionRetries:0,summary:{foldToolRepeats:true,verbatimFileArtifacts:true},security:{localProviders:['offline']},evidence:{enabled:false}}),s=Session.create('native-transaction');
 s.append('turn/start',{turn:1});s.append('system/message',{turn:1,step:0,message:createSystemMessage('Offline source diagnosis','offline-test')},{surfaceOp:'append'});s.append('request/header',{header:{config:{provider:'offline',model:'mock',maxTokens:1024}},reason:'initial'});
 const start=s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Inspect source. '+'Synthetic observation. '.repeat(200)}]}),{surfaceOp:'append'}).seq;
 s.append('step/start',{turn:1,step:1});const call={type:'tool-call',id:'read-source',name:'ReadSource',arguments:'{"path":"a.py"}'};
 s.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'offline',model:'mock'},content:[call]}),stream:[]},{surfaceOp:'append'});s.append('tool/call',{turn:1,step:1,callId:call.id,name:call.name,arguments:call.arguments});
 const m=makers.native([{type:'text',text:'long unchanged source observation\r\n'.repeat(150)+quote}]),end=s.append('tool/result',{turn:1,step:1,message:m},{surfaceOp:'append'}).seq;s.append('step/end',{turn:1,step:1});
 const tail=s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Untouched tail'}]}),{surfaceOp:'append'}).seq,before=s.snapshotEvents(),saved=JSON.stringify(before);
 const result=await engine.compactRegion(start,end,{session:s,options:{provider:'offline',model:'mock',maxTokens:1024}},new AbortController().signal);
 assert.equal(adapter.calls.length,1);assert(result.summary[0].text.includes(quote));assert(!result.summary[0].text.includes(wrong));assert.equal(JSON.stringify(s.snapshotEvents().slice(0,before.length)),saved);assert(s.surface.nodes.includes(tail));
 const tool=adapter.calls[0].messages.find(x=>x.source?.kind==='tool');assert.equal(tool.content[0].toolCallId,'read-source');assert.equal(tool.content[0].isError,true);assert.equal(unfoldRepeatedLines(toolResultContent(tool)[0].text),toolResultContent(m)[0].text);
 assert.equal(s.snapshotEvents().filter(x=>x.type==='compaction/start').length,s.snapshotEvents().filter(x=>x.type==='compaction/end').length);assert.equal(s.snapshotEvents().filter(x=>x.type==='compaction/summary').length,1);
 // A valid native envelope with unsupported rich evidence must roll back,
 // rather than silently dropping a possibly valid file description.
 const seed=structuredClone(before);seed.find(x=>x.type==='tool/result').data.message.content[0].content.push({type:'reasoning',text:'Synthetic rich observation'});
 const rich=Session.create('native-rich-rollback',seed),nodes=rich.surface.nodes.slice(),events=JSON.stringify(rich.snapshotEvents()),count=rich.snapshotEvents().length;
 await assert.rejects(engine.compactRegion(start,end,{session:rich,options:{provider:'offline',model:'mock',maxTokens:1024}},new AbortController().signal),{code:'COMPACTION_UNSUPPORTED_TOOL_RESULT'});
 assert.deepEqual(rich.surface.nodes,nodes);assert.equal(JSON.stringify(rich.snapshotEvents().slice(0,count)),events);assert.equal(rich.snapshotEvents().filter(x=>x.type==='compaction/summary').length,0);
 assert.equal(rich.snapshotEvents().filter(x=>x.type==='compaction/start').length,rich.snapshotEvents().filter(x=>x.type==='compaction/end').length);
});

for(const scenario of ['pinned-state','latest-correction','longer-pressure']) {
 test(`final native summary replay retains six facts: ${scenario}`,async()=>{
  const root=new URL('./fixtures/headless/jobs/',import.meta.url).pathname;
  const native=JSON.parse(readFileSync(root+scenario+'-compact/native-result.json')),job=JSON.parse(readFileSync(root+scenario+'-compact/job.json'));
  const raw=native.events.find(e=>e.type==='compaction/summary').data.rawOutput,document=parseSummaryDocument(raw.filter(b=>b.type==='text').map(b=>b.text).join(''),1),source=native.events.filter(e=>e.type==='tool/result').map(e=>e.data.message),saved=JSON.stringify({document,source});
  const result=await replay(source,{guard:true,document});
  for(const value of Object.values(job.expected))assert(result.summary[0].text.includes(value));
  assert.equal(JSON.stringify({document,source}),saved);
 });
}
test('guard refuses rich/unknown tool content without erasing potentially valid file information',async()=>{
 const m=makers.native([{type:'text',text:quote},{type:'image',url:'offline-image'}]),saved=JSON.stringify(m);
 await assert.rejects(replay([m]),{code:'COMPACTION_UNSUPPORTED_TOOL_RESULT'});assert.equal(JSON.stringify(m),saved);
 assert((await replay([m],{guard:false})).summary[0].text.includes(quote));
});
test('native tool-result replacement preserves pairing IDs and recovers low-savings identity',()=>{
 const s=Session.create('native-replacement-recovery');const start=s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Selected prefix'}]}),{surfaceOp:'append'}).seq;
 const original=makers.native([{type:'text',text:'Old retained observation'}]),seq=s.append('tool/result',{message:original},{surfaceOp:'append'}).seq;
 const e=Object.create(AdaptiveCompactionEngine.prototype);Object.assign(e,{adaptive:resolveAdaptiveConfig({budget:{minSavingsTokens:1}}),config:{},ctx:{get:()=>undefined},resolveSummarizationTarget:()=>({provider:'offline',model:'mock'})});
 const key=()=>e.lowSavingsRepeatKey({session:s},{start,end:start},{nodes:s.surface.nodes.map(seq=>({seq,tokens:10}))},{},1),before=key(),events=JSON.stringify(s.snapshotEvents()),count=s.snapshotEvents().length,generation=s.surface.replaceGeneration;
 const replacement={...original,content:[{...original.content[0],content:[{type:'text',text:'Updated retained observation'}]}]};
 const written=s.append('tool/result',{message:replacement},{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]});
 assert(s.surface.nodes.includes(written.seq));assert(!s.surface.nodes.includes(seq));assert.equal(s.surface.replaceGeneration,generation+1);assert.notEqual(key(),before);
 assert.equal(JSON.stringify(s.snapshotEvents().slice(0,count)),events);assert.equal(replacement.source.callId,replacement.content[0].toolCallId);assert.equal(replacement.id,original.id);assert.equal(replacement.content[0].isError,original.content[0].isError);assert.equal(replacement.role,'user');
});
