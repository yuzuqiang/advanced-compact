import './no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dedupeToolPayloads,unfoldToolPayloads,foldToolRepeats,unfoldRepeatedLines,toolResultContent,TOOL_PAYLOAD_REFERENCE_RULE} from '../plugin/prompt.js';
import {resolveAdaptiveConfig} from '../plugin/config.js';
import {createToolResultMessage} from '@deepseek-ai/dsh-llm';
const body='Exact source line with unique semantics, ownerVersion=19.\r\n'.repeat(18)+'tail without newline';
const legacy=(id,content,isError=false)=>({id:'message-'+id,role:'tool',source:{kind:'tool',callId:id},toolCallId:id,isError,content});
const native=(id,content,isError=false)=>createToolResultMessage({callId:id,content,isError});
for(const [name,make] of [['legacy',legacy],['native',native]]){
 test(name+': exact multi-block payload references preserve all bytes, positions and wrapper metadata',()=>{
  const content=[{type:'text',text:body.slice(0,37)},{type:'text',text:body.slice(37)}];const messages=[make('a',content),{role:'user',source:{kind:'user'},content:[{type:'text',text:'MUST: do not deploy'}]},make('b',content),make('c',content)];
  const original=JSON.stringify(messages),result=dedupeToolPayloads(messages);assert.equal(result.references,2);assert.equal(result.definitions,1);assert(result.afterChars+TOOL_PAYLOAD_REFERENCE_RULE.length<result.beforeChars);assert.deepEqual(unfoldToolPayloads(result.messages),messages);assert.equal(JSON.stringify(messages),original);
  assert(toolResultContent(result.messages[0])[0].text.includes('ref=1'));assert(toolResultContent(result.messages[3])[0].text.includes('define=1'));assert.equal(result.messages[1],messages[1]);
  // Every retained suffix containing a generated reference still has its later definition.
  for(let i=0;i<messages.length;i++)assert.deepEqual(unfoldToolPayloads(result.messages.slice(i)),messages.slice(i));
 });
 test(name+': changed bytes, errors, annotations, mixed blocks and short bodies remain distinct',()=>{
  const contents=[[{type:'text',text:body}],[{type:'text',text:body+'changed'}],[{type:'text',text:body,annotation:'keep'}],[{type:'text',text:body},{type:'image',url:'offline-image'}],[{type:'text',text:'tiny'}]];
  const m=contents.flatMap((c,i)=>[make('a'+i,c),make('b'+i,c,true)]);const r=dedupeToolPayloads(m);assert.equal(r.references,0);assert.equal(r.messages,m);
 });
 test(name+': collision in raw text, split text blocks, human instruction, system or schema disables encoding',()=>{
  const m=[make('a',[{type:'text',text:body}]),make('b',[{type:'text',text:body}]),make('c',[{type:'text',text:body}])];
  for(const context of [['[adaptive-tool:v1 ref=1]'],[{description:'[adaptive-tool:v1 define=1]'}],[[{type:'text',text:'[adaptive-tool:'},{type:'text',text:'v1 ref=1]'}]]]){const r=dedupeToolPayloads(m,context);assert(r.collision);assert.equal(r.messages,m);}
  const added=[...m,{role:'user',source:{kind:'user'},content:[{type:'text',text:'[adaptive-tool:'},{type:'text',text:'v1 ref=1]'}]}];assert(dedupeToolPayloads(added).collision);
 });
 test(name+': consecutive-line encoding composes reversibly with whole-payload references',()=>{
  const m=Array.from({length:20},(_,i)=>make(String(i),[{type:'text',text:body}]));const folded=foldToolRepeats(m),refs=dedupeToolPayloads(folded.messages);assert(refs.references>0);
  const unfolded=unfoldToolPayloads(refs.messages).map(x=>{const c=toolResultContent(x).map(b=>({...b,text:unfoldRepeatedLines(b.text)}));return {...x,content:x.role==='tool'?c:[{...x.content[0],content:c}]};});assert.deepEqual(unfolded,m);
 });
}
test('configuration is boolean validated and source default is disabled',()=>{assert.equal(resolveAdaptiveConfig({}).summary.dedupeToolPayloads,false);assert.equal(resolveAdaptiveConfig({summary:{dedupeToolPayloads:true}}).summary.dedupeToolPayloads,true);assert.throws(()=>resolveAdaptiveConfig({summary:{dedupeToolPayloads:'yes'}}));});
test('malformed native provenance is never used as a payload definition',()=>{const a=native('a',[{type:'text',text:body}]),b=structuredClone(native('b',[{type:'text',text:body}]));b.source.callId='wrong';const r=dedupeToolPayloads([a,b]);assert.equal(r.references,0);assert.equal(r.messages[1],b);});
test('verification rejects missing definitions instead of inventing bytes',()=>{assert.throws(()=>unfoldToolPayloads([legacy('a',[{type:'text',text:'[adaptive-tool:v1 ref=42]'}])]),/missing/);});
const SOURCE=new URL('./fixtures/summary-wire/',import.meta.url).pathname;
const records=[];
for(const kind of ['pinned-state','latest-correction','longer-pressure'])test('saved actual summary wire/'+kind+' exact round trip and full tool pairs',()=>{
 const original=JSON.parse(readFileSync(`${SOURCE}/${kind}.json`));
 const saved=JSON.stringify(original),shaped=original.messages.map(m=>m.role==='tool'?{...m,content:[{type:'text',text:m.content}]}:structuredClone(m)),encoded=dedupeToolPayloads(shaped),back=unfoldToolPayloads(encoded.messages).map(m=>m.role==='tool'?{...m,content:m.content.map(b=>b.text).join('')}:m);assert.deepEqual(back,original.messages);assert(encoded.references>0);
 const changed=encoded.messages.map(m=>m.role==='tool'?{...m,content:m.content.map(b=>b.text).join('')}:m);changed.at(-1).content+='\n'+TOOL_PAYLOAD_REFERENCE_RULE;
 // Keep caller's original instruction immutable as well.
 assert.equal(JSON.stringify(original),saved);
 const pending=new Set();for(const m of changed){if(m.role==='assistant')for(const c of m.tool_calls??[])pending.add(c.id);if(m.role==='tool')assert(pending.delete(m.tool_call_id));}assert.equal(pending.size,0);
 records.push({case:kind,original_body:original,encoded_body:{...original,messages:changed},definitions:encoded.definitions,references:encoded.references,before_chars:encoded.beforeChars,after_chars:encoded.afterChars,exact_roundtrip:true,tool_pairs_balanced:true});
});
test.after(()=>writeFileSync(new URL('../cost-wire-replay.json',import.meta.url),JSON.stringify({records,new_real_api_calls:0,output_replayed:false},null,2)+'\n'));
