import {performance} from 'node:perf_hooks';
import {writeFileSync,readFileSync} from 'node:fs';
import {cpus} from 'node:os';
import assert from 'node:assert/strict';
import {load,benches,correctnessCases,digest} from '../checks/performance-cases.mjs';
const [base,candidate,group,out]=process.argv.slice(2);
const a=await load(base),b=await load(candidate);
const cases=correctnessCases();
const expected=[];
for(const [name,fn,args] of cases){let x,y;try{x=a[fn](...args)}catch(e){x={error:e.message}}try{y=b[fn](...args)}catch(e){y={error:e.message}}assert.deepEqual(y,x,name);expected.push(x)}
const results=[];let sink;
const med=x=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)];
const run=(f,args,n)=>{const c=process.cpuUsage(),t=performance.now();for(let i=0;i<n;i++)sink=f(...args);return {ms:performance.now()-t,cpu:((d)=>d.user+d.system)(process.cpuUsage(c))/1000}};
for(const [name,fn,args] of benches[group]){
 for(let i=0;i<250;i++){sink=a[fn](...args);sink=b[fn](...args)}
 let n=1;while(run(a[fn],args,n).ms<50 && n<1e7)n*=2;
 const pairs=[];for(let i=0;i<11;i++){let x,y;if(i%2){y=run(b[fn],args,n);x=run(a[fn],args,n)}else{x=run(a[fn],args,n);y=run(b[fn],args,n)}pairs.push({baseline:x.ms/n,candidate:y.ms/n,cpuBaseline:x.cpu/n,cpuCandidate:y.cpu/n})}
 const ratios=pairs.map(p=>p.candidate/p.baseline), cpuRatios=pairs.map(p=>p.cpuCandidate/p.cpuBaseline);
 results.push({name,iterations:n,baselineMs:med(pairs.map(p=>p.baseline)),candidateMs:med(pairs.map(p=>p.candidate)),ratio:med(ratios),cpuRatio:med(cpuRatios),wins:ratios.filter(x=>x<1).length,pairs});
}
const report={timestamp:new Date().toISOString(),node:process.version,cpu:cpus()[0].model,group,correctnessCases:cases.length,correctnessDigest:digest(expected),inputDigest:digest(cases),results};
writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,results:results.map(({pairs,...r})=>r)},null,2));
