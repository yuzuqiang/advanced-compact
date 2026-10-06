import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export async function load(dir) {
 const modules = {};
 for(const name of ['anchors','summary','range','prompt','sidecar-serialize','jcs']) Object.assign(modules, await import(pathToFileURL(resolve(dir,name+'.js'))));
 return modules;
}
const text = s=>({type:'text',text:s});
const human=(s)=>({role:'user',source:{kind:'user'},content:[text(s)]});
const tool=(s,i=0)=>({role:'tool',toolCallId:String(i),isError:false,source:{kind:'tool',callId:String(i)},content:[text(s)]});
const kinds=['commands','artifacts','files','tests','errors','user_pins','deliverables'];
const options={enabled:true,kinds,budgetTokens:1024,maxPerKind:24,maxAnchorChars:320,userPinMarkers:['MUST:','Correction:']};
const anchors=(n)=>({all:Array.from({length:n},(_,i)=>({kind:'deliverables',text:`Q${i%300}: Inspect item ${i}`,seq:i,sourceOrder:i})),overflow:[],lastAssistantSeq:n+10});
const task=(n)=>({goal:'Inspect',completed:Array.from({length:n},(_,i)=>`Q${i}: completed`),open:Array.from({length:n},(_,i)=>`Q${i+n}: still open`),current_plan:[]});
function range(n, retain=100) { const events=Array.from({length:n},(_,seq)=>({seq,type:seq===0?'system/message':'user/message',data:{source:{kind:'user'}}}));const nodes=events.map(e=>e.seq); const session={seq:n,surface:{nodes,replaceGeneration:0},events,eventAt(i){return events[i]}};return [session,{nodes:nodes.map(seq=>({seq,tokens:16}))},{retainTokens:retain,checkpointAbsorbFloor:.75,minCompactTokens:1}]; }
const mixed=Array.from({length:250},(_,i)=>({seq:i,message:human(`MUST: keep value ${i}\nQ${i}: Report result ${i}\nsrc/module${i}.js:2\nError: failed ${i}\n$ run ${i}\n${i} passed`)}));
const source='exact long source '+('0123456789abcdef '.repeat(2048));
const doc=(n,dup=true)=>({files:Array.from({length:n},(_,i)=>({path:`file${i}.js`,operation:'read',artifact:dup?'missing exact quote':`missing exact quote ${i}`}))});
const nested=Array.from({length:100},(_,i)=>({type:'tool-result',toolCallId:`id${i}`,isError:i%3===0,content:[text('alpha'),{type:'image',url:'fake'},text('beta'),{type:'tool-result',toolCallId:'inner',content:[text('tail'),{type:'reasoning',text:'reason'}]}]}));
const uniqueLines=Array.from({length:3000},(_,i)=>`output ${i}: exact retained row`).join('\n');
const repeatedLines=('long diagnostic observation without changed fields\n').repeat(1000)+'tail';
const payload=Array.from({length:100},(_,i)=>tool(('exact source line '+String(i%5)+' abcdefghijklmnopqrstuvwxyz\n').repeat(100),i));
const uniquePayload=Array.from({length:100},(_,i)=>tool(('source '+String(i)+' abcdefghijklmnopqrstuvwxyz\n').repeat(100),i));
const multiline=Array.from({length:100},(_,i)=>text(`line-${i}\n`));
export const benches={
 hashing:[['hash-large','summarySha256',[[{type:'text',text:source.repeat(10)}]]],['hash-small','summarySha256',[[{type:'text',text:'Short retained summary'}]]]],
 range:[['range-large','selectAdaptiveRange',range(2000)],['range-small','selectAdaptiveRange',range(30)]],
 reconcile:[['reconcile-wide','reconcileOpenDeliverables',[task(300),anchors(500)]],['reconcile-small','reconcileOpenDeliverables',[task(4),anchors(8)]]],
 coalesced:[['coalesced-single','coalescedBlockText',[[text(source)]]],['coalesced-mixed','coalescedBlockText',[nested]],['coalesced-multi','coalescedBlockText',[multiline]]],
 budget:[['anchor-mixed','extractAnchors',[mixed,options]],['anchor-small','extractAnchors',[mixed.slice(0,4),options]]],
 unresolved:[['unresolved-wide','unresolvedDeliverables',[anchors(1000),new Set(['q1','q5'])]],['unresolved-small','unresolvedDeliverables',[anchors(6),new Set()]]],
 grounding:[['ground-repeated','groundFileArtifacts',[doc(300),[source,source+'tail']]],['ground-unique','groundFileArtifacts',[doc(300,false),[source,source+'tail']]],['ground-small','groundFileArtifacts',[doc(3),[source]]]],
 collision:[['payload-repeated','dedupeToolPayloads',[payload]],['payload-unique','dedupeToolPayloads',[uniquePayload]],['payload-small','dedupeToolPayloads',[payload.slice(0,2)]]],
 linefold:[['fold-unique','foldRepeatedLines',[uniqueLines]],['fold-repeated','foldRepeatedLines',[repeatedLines]],['fold-small','foldRepeatedLines',['a\nb\nc\n']]],
 wire:[['wire-nested','toWireContentBlocks',[nested]],['wire-flat','toWireContentBlocks',[multiline]]],
 grouping:[['payload-repeated','dedupeToolPayloads',[payload]],['payload-unique','dedupeToolPayloads',[uniquePayload]],['payload-small','dedupeToolPayloads',[payload.slice(0,2)]]],
};
export function correctnessCases(){
 const cases=Object.values(benches).flat().map(([name,fn,args])=>[name,fn,args]);
 let s=0x18a1234;const rnd=n=>((s=(Math.imul(s,1664525)+1013904223)>>>0)%n);
 for(let c=0;c<200;c++){
  const blocks=[];for(let i=0;i<rnd(15);i++){const t=rnd(5);blocks.push(t<2?{type:t?'reasoning':'text',text:['','x','Q1: hi','\ud800','\r\n','artifact://sha256/'+ 'a'.repeat(64)][rnd(6)]}:t===2?{type:'tool-result',toolCallId:'t'+i,content:[text('x'),text('y')]}:t===3?{type:'tool-call',id:'a',name:'read',arguments:'{}'}:{type:'image',url:'x'});}
  cases.push(['coalesce'+c,'coalescedBlockText',[blocks]],['wire'+c,'toWireContentBlocks',[blocks]]);
  const a=anchors(rnd(25));a.overflow=a.all.splice(rnd(a.all.length+1));if(rnd(2))a.lastAssistantSeq=rnd(20);for(const x of [...a.all,...a.overflow]){if(rnd(4)===0)x.kind='files';if(rnd(4)===0){x.pendingDelivery=true;x.pendingAfterSeq=rnd(20);}}
  cases.push(['unresolved'+c,'unresolvedDeliverables',[a,new Set(['q1','q3'])]],['reconcile'+c,'reconcileOpenDeliverables',[task(rnd(15)),a]]);
  const lines=Array.from({length:rnd(35)},()=>['','same long exact diagnostic line','abc','\ud800','終わり','\r'][rnd(6)]).join('\n');cases.push(['fold'+c,'foldRepeatedLines',[lines]]);
  const ms=Array.from({length:rnd(8)},(_,i)=>tool([source.slice(0,300),source.slice(0,400),'tiny'][rnd(3)],i));
  if(c%5===0)ms.push(human('[adaptive-tool:v1 ref=1]'));if(c%7===0)ms.push({...human(''),content:[text('[adaptive-tool:'),{type:'reasoning',text:'v1 ref=1]'}]});
  cases.push(['payload'+c,'dedupeToolPayloads',[ms]]);
  const nodes=Array.from({length:rnd(12)},(_,i)=>({seq:c%3?-1:i,message:human(`Q${rnd(5)}: Inspect ${i}\nMUST: ${rnd(8)}\nError: issue ${rnd(10)}\nsrc/a${rnd(4)}.js\n$ echo ${rnd(5)}\n${rnd(8)} passed`)}));
  cases.push(['extract'+c,'extractAnchors',[nodes,{...options,budgetTokens:rnd(300),maxAnchorChars:[20,60,320][rnd(3)]}]]);
  const args=range(2+rnd(120),1+rnd(100));cases.push(['range'+c,'selectAdaptiveRange',args]);
 }
 for(const marker of ['[adaptive-tool:v1 ','[adaptive-repeat:v1 additional='])for(let split=0;split<=marker.length;split++){
  const context=[[text(marker.slice(0,split)),{type:'reasoning',text:marker.slice(split)}]];cases.push(['split'+marker+split,'dedupeToolPayloads',[payload.slice(0,3),context]]);
 }
 return cases;
}
export function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
