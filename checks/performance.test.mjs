import './performance-seams.mjs';
import '../tests/no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {load,correctnessCases,digest} from './performance-cases.mjs';
const lib = await load(new URL('../packaging/adaptive-compact/', import.meta.url).pathname);
test('1,678 deterministic cases retain the frozen main behavior', () => {
  const cases=correctnessCases(), actual=[];
  assert.equal(cases.length,1678);
  for(const [name,fn,args] of cases) {
    const before=digest(args);
    try { actual.push(lib[fn](...args)); } catch(e) {actual.push({error:e.message});}
    assert.equal(digest(args),before,`input changed: ${name}`);
  }
  // Generated using unmodified main e656a68b2ea1c189d72b8997fa9b59b85397d248.
  assert.equal(digest(actual),'8eea87a09e1dfc38c1e37fd9a781aa8c251e4492723f2839a87f221638026bda');
});
test('single text blocks retain coercion and read each text value once', () => {
  for(const value of ['',undefined,null,15,12n,{toString(){return 'coerced'}}]) {
    let reads=0;
    const out=lib.coalescedBlockText([{type:'text',get text(){reads++;return value}}]);
    assert.equal(out,[value].join(''));assert.equal(reads,1);
  }
  assert.throws(()=>lib.coalescedBlockText([{type:'text',text:Symbol('invalid')}]),TypeError);
});
test('payload references preserve message bytes and every retained suffix', () => {
  const messages=Array.from({length:8},(_,i)=>({role:'tool',toolCallId:String(i),isError:false,content:[{type:'text',text:'exact byte evidence\r\n'.repeat(100)}]}));
  const result=lib.dedupeToolPayloads(messages);
  assert.equal(result.references,7);
  for(let i=0;i<messages.length;i++)assert.deepEqual(lib.unfoldToolPayloads(result.messages.slice(i)),messages.slice(i));
});
test('same normalized deliverable label keeps first occurrence and stays unresolved', () => {
  const first={kind:'deliverables',text:'Question 1: first',seq:1};
  const set={all:[first],overflow:[{kind:'deliverables',text:'q1: second',seq:2}],lastAssistantSeq:3};
  const out=lib.unresolvedDeliverables(set,new Set(['q1']));
  assert.deepEqual(out,[{label:'Question 1',anchor:first}]);assert.equal(out[0].anchor,first);
});
test('range cuts retreat to the modeled balanced boundary without reordering sums', () => {
  const events=Array.from({length:8},(_,seq)=>({seq,type:seq===0?'system/message':'user/message',data:{source:{kind:'user'}}}));
  const session={surface:{nodes:events.map(e=>e.seq)},eventAt:i=>events[i],testBalancedCuts:new Set([3])};
  const priced=events.map(e=>({seq:e.seq,tokens:10}));
  assert.deepEqual(lib.selectAdaptiveRange(session,{nodes:priced},{retainTokens:10,minCompactTokens:0,checkpointAbsorbFloor:.75}),{start:1,end:2,tokens:20});
});
