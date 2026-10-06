import './no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Context} from '@deepseek-ai/cordis';
import {Session,SessionStore} from '@deepseek-ai/dsh-session';
import {LlmRuntime,LlmAdapter} from '@deepseek-ai/dsh-llm';
import {TokenMeter} from '@deepseek-ai/dsh-token-meter';
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
import {AdaptiveCompactionEngine} from '../plugin/index.js';
import {unfoldToolPayloads,toolResultContent} from '../plugin/prompt.js';
const source=new URL('./fixtures/headless/',import.meta.url).pathname;
const text=blocks=>blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
const records=[];
for(const name of ['pinned-state','latest-correction','longer-pressure'])test('actual native transaction with saved output/'+name,async()=>{
 const native=JSON.parse(readFileSync(`${source}/jobs/${name}-compact/native-result.json`)),job=JSON.parse(readFileSync(`${source}/jobs/${name}-compact/job.json`));
 const original=native.events.find(e=>e.type==='compaction/summary').data,seed=native.events.slice(0,native.events.findIndex(e=>e.type==='compaction/start'));
 const arms=[];
 for(const enabled of [false,true]){
  const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);new LlmRuntime(ctx);new TokenMeter(ctx);
  class Adapter extends LlmAdapter{calls=[];async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:131072},defaultMaxTokens:16384};}async *stream(o){this.calls.push(o);yield {type:'text-delta',index:0,text:text(original.rawOutput)};yield {type:'finish',reason:{kind:'stop'}};}}
  const adapter=new Adapter();ctx.llm.registerAdapter(['offline'],adapter);
  const engine=new AdaptiveCompactionEngine(ctx,{...native.adaptiveConfig,auto:false,summarizationProvider:'offline',summarizationModel:'mock',summary:{...native.adaptiveConfig.summary,dedupeToolPayloads:enabled}});
  const s=Session.create(`cost-replay-${name}-${enabled}`,structuredClone(seed)),before=JSON.stringify(s.snapshotEvents()),count=s.snapshotEvents().length,tail=s.surface.nodes.filter(seq=>seq>original.shadowedRange.end);
  const result=await engine.compactRegion(original.shadowedRange.start,original.shadowedRange.end,{session:s,options:{provider:'offline',model:'mock',maxTokens:16384}},new AbortController().signal);
  assert.equal(adapter.calls.length,1);assert.equal(JSON.stringify(s.snapshotEvents().slice(0,count)),before);assert.equal(s.snapshotEvents().filter(e=>e.type==='compaction/summary').length,1);assert.equal(s.snapshotEvents().filter(e=>e.type==='compaction/start').length,s.snapshotEvents().filter(e=>e.type==='compaction/end').length);
  assert(tail.every(seq=>s.surface.nodes.includes(seq)));assert.equal(text(result.summary),text(original.summary));for(const value of Object.values(job.expected))assert(text(result.summary).includes(value));
  const sent=adapter.calls[0].messages.slice(0,-1),decoded=unfoldToolPayloads(sent),markers=sent.filter(m=>toolResultContent(m)?.[0]?.text.startsWith('[adaptive-tool:v1 ref=')).length;
  if(enabled)assert(markers>0);else assert.equal(markers,0);
  const pending=new Set();for(const m of decoded){if(m.role==='assistant')for(const b of m.content)if(b.type==='tool-call')pending.add(b.id);if(m.source?.kind==='tool')assert(pending.delete(m.source.callId));}assert.equal(pending.size,0);
  const stored=s.snapshotEvents().find(e=>e.type==='compaction/summary').data;
  arms.push({enabled,decoded,markers,summary:text(result.summary),raw_text:text(stored.rawOutput),commits:1,pairs:true,tail:true,source_events_unchanged:true});
 }
 assert.deepEqual(arms[1].decoded,arms[0].decoded);assert.equal(arms[1].summary,arms[0].summary);assert.equal(arms[1].raw_text,arms[0].raw_text);
 records.push({case:name,source_events_unchanged:true,decoded_requests_identical:true,summary_exact_saved_022_checkpoint:true,replayed_facts:6,encoded_references:arms[1].markers,pairs_balanced:true,tail_preserved:true,one_commit_each:true,new_real_model_calls:0});
});
test('encoded native request parse failure keeps original surface and closes transaction',async()=>{
 const native=JSON.parse(readFileSync(`${source}/jobs/pinned-state-compact/native-result.json`)),original=native.events.find(e=>e.type==='compaction/summary').data,seed=native.events.slice(0,native.events.findIndex(e=>e.type==='compaction/start'));
 const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);new LlmRuntime(ctx);new TokenMeter(ctx);
 class Adapter extends LlmAdapter{calls=[];async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:131072},defaultMaxTokens:16384};}async *stream(o){this.calls.push(o);yield {type:'text-delta',index:0,text:'INVALID_OFFLINE_SUMMARY'};yield {type:'finish',reason:{kind:'stop'}};}}
 const adapter=new Adapter();ctx.llm.registerAdapter(['offline'],adapter);const engine=new AdaptiveCompactionEngine(ctx,{...native.adaptiveConfig,auto:false,summarizationProvider:'offline',summarizationModel:'mock',summary:{...native.adaptiveConfig.summary,dedupeToolPayloads:true,onParseError:'fail'}});
 const s=Session.create('cost-invalid-replay',structuredClone(seed)),surface=s.surface.nodes.slice(),before=JSON.stringify(s.snapshotEvents()),count=s.snapshotEvents().length;
 await assert.rejects(()=>engine.compactRegion(original.shadowedRange.start,original.shadowedRange.end,{session:s,options:{provider:'offline',model:'mock',maxTokens:16384}},new AbortController().signal));
 assert.equal(adapter.calls.length,1);assert.equal(engine.stats.parseFailures,1);assert.equal(s.snapshotEvents().filter(e=>e.type==='compaction/summary').length,0);assert.deepEqual(s.surface.nodes,surface);assert.equal(JSON.stringify(s.snapshotEvents().slice(0,count)),before);assert.equal(s.snapshotEvents().filter(e=>e.type==='compaction/start').length,1);assert.equal(s.snapshotEvents().filter(e=>e.type==='compaction/end').length,1);assert(adapter.calls[0].messages.some(m=>toolResultContent(m)?.[0]?.text.startsWith('[adaptive-tool:v1 ref=')));
 records.push({case:'invalid-summary',dedupe_enabled:true,parse_failures:1,commits:0,source_events_unchanged:true,surface_unchanged:true,transaction_closed:true,new_real_model_calls:0});
});
test.after(()=>writeFileSync(new URL('../cost-native-replay-results.json',import.meta.url),JSON.stringify({records,output_is_saved_replay:true,new_real_api_calls:0},null,2)+'\n'));
