#!/usr/bin/env python3
"""Run the real user headless profile with temporary observation/state overlays."""
import argparse,datetime,hashlib,json,os,pathlib,subprocess,time,urllib.request,yaml,shutil
PROJECT=pathlib.Path(__file__).resolve().parents[1];DSH=pathlib.Path(os.environ['DSH_REPO']).expanduser().resolve()
def dump(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--run',type=pathlib.Path,required=True);ap.add_argument('--offline',action='store_true');ap.add_argument('--resume',action='store_true');a=ap.parse_args();r=a.run.resolve();r.mkdir(parents=True,exist_ok=True)
 freeze=r/'evidence/freeze.json'
 if freeze.exists() and (a.offline or not a.resume):raise RuntimeError('Frozen run exists; use a new directory for new tests')
 installed=pathlib.Path.home()/'.dsh/profiles/headless/node_modules/adaptive-compact'
 release=json.loads((PROJECT/'packaging/adaptive-compact/release-integrity.json').read_text());assert json.loads((installed/'package.json').read_text())['version']==release['version']
 for name,digest in release['files'].items():assert sha(installed/name)==digest,'Installed release drift: '+name
 fixture_path=PROJECT/'tests/fixtures/pressure-cases.json';inventory=json.loads((PROJECT/'releases/0.1.22/test-integrity.json').read_text());assert sha(fixture_path)==inventory['tests/fixtures/pressure-cases.json']
 fixtures=json.loads(fixture_path.read_text());assert set(fixtures)=={'pinned-state','latest-correction','longer-pressure'};cases=[{'id':name,**data} for name,data in fixtures.items()]
 profile=pathlib.Path.home()/'.dsh/profiles/headless'
 profiles=[pathlib.Path.home()/'.dsh/settings.yaml']+[profile/name for name in ['package.json','pnpm-lock.yaml','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml']]+[installed/name for name in release['files']]
 integrity={str(p):sha(p) for p in profiles};compact={**next(entry['config'] for patch in yaml.safe_load((installed/'cordis.patch.yml').read_text()) for entry in patch.get('insert',[]) if entry['id']=='adaptive-compact'),'auto':False}
 if freeze.exists():
  f=json.loads(freeze.read_text());assert f['production_files']==integrity;assert sha(PROJECT/'scripts/headless-observer.mjs')==f['observer_sha256'] and sha(pathlib.Path(__file__))==f['runner_sha256']
 state=pathlib.Path.home()/'.cache/adaptive-compact-eval'/r.name;state.mkdir(parents=True,exist_ok=True)
 specs=[]
 for i,c in enumerate(cases):
  for arm in (['baseline','compact'] if i%2==0 else ['compact','baseline']):
   id=c['id']+'-'+arm;out=r/('offline' if a.offline else 'jobs')/id;out.mkdir(parents=True,exist_ok=True)
   history=c['history']
   config={'id':id,'root':str(r),'output':str(out),'arm':arm,'mode':'offline' if a.offline else 'formal','history':history,'maxCalls':3,'maxTotalCalls':18,'expectedModel':'qwen3.8-flash-next-iq3_xxs','expected':c['expected']};dump(out/'job.json',config)
   patch=[{'id':'session-persistence-jsonl','config':{'root':str(state/id/'sessions'),'compression':'none'}},{'id':'storage-json','config':{'root':str(state/id/'storages')}},{'id':'fs-sandbox','config':{'cwd':str(state/id/'workspace')}},{'insert':[{'id':'headless-performance-observer','name':str(PROJECT/'scripts/headless-observer.mjs')}]}]
   if arm=='baseline':patch.append({'id':'adaptive-compact','config':compact})
   (state/id/'workspace').mkdir(parents=True,exist_ok=True);dump(out/'observer.patch.yml',patch)
   prompt='Recall the latest project facts from the earlier prepared history. Return only one JSON object with exactly these six string keys: project, region, storage, timeout, rollback, owner. Apply the latest corrections when present. The old source snapshots are context-pressure fixtures and require no implementation. No tools, files, tests, subagents, external requests or messages are needed. Answer directly.'
   specs.append({'id':id,'arm':arm,'case':c['id'],'output':str(out),'patch':str(out/'observer.patch.yml'),'prompt':prompt,'job_sha256':sha(out/'job.json'),'patch_sha256':sha(out/'observer.patch.yml')})
 mode='offline' if a.offline else 'formal';manifest=r/(mode+'-manifest.json');records=json.loads(manifest.read_text()) if manifest.exists() else []
 if not a.offline:
  if not freeze.exists():
   offline=json.loads((r/'offline-manifest.json').read_text());assert len(offline)==6 and all(j['exit_code']==0 for j in offline)
   for j in offline:
    d=json.loads((pathlib.Path(j['output'])/'native-result.json').read_text())
    assert d['compactionStats']['compacted']==(1 if j['arm']=='compact' else 0),'Native auto preflight must exercise exactly one compaction per compact task'
   counter=PROJECT/'scripts/count-strata-wire.py';admission=[]
   for j in offline:
    out=pathlib.Path(j['output']);wires=[json.loads(p.read_text()) for p in sorted(out.glob('request-*.json'))];counts=json.loads(subprocess.check_output([os.environ['STRATA_PYTHON'],str(counter)],input=json.dumps([x['body'] for x in wires]),text=True))
    assert all(x['planning_tokens']<=131072 for x in counts);admission.append({'id':j['id'],'wire_counts':counts,'purposes':[x['purpose'] for x in wires]})
   dump(r/'evidence/offline-admission.json',admission)
   health=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=10));assert health['status']=='ok' and health['loaded'] and health['service']=='strata' and health['model']=='qwen3.8-flash-next-iq3_xxs' and health['max_context']==131072
   code=r/'evidence/runtime-code';code.mkdir(parents=True,exist_ok=True)
   for name in ['headless-run.py','headless-observer.mjs','headless-report.py','count-strata-wire.py']:(code/name).write_bytes((PROJECT/'scripts'/name).read_bytes())
   dump(r/'evidence/release-integrity.json',release)
   dump(freeze,{'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'protocol':'Actual dsh --profile headless native runner; prepared history recall pressure; 3 alternating paired tasks','plugin_version':release['version'],'installed_summary_config':json.loads((r/'offline/pinned-state-compact/native-result.json').read_text())['adaptiveConfig']['summary'],'health':health,'production_files':integrity,'observer_sha256':sha(PROJECT/'scripts/headless-observer.mjs'),'runner_sha256':sha(pathlib.Path(__file__)),'summary_config':'Installed headless bundle unchanged: threshold .25, retain 8192, release .2, cap4096, auto true; maxInputTokens=0 and verbatimFileArtifacts=false. Baseline only sets auto false in a temporary CLI patch.','model_parameters':'Production Strata settings, reasoning high, conversation default cap16384; no wire/request parameter override. Summary knobs remain plugin-owned. All actual requests captured.','jobs':specs,'request_limit':18,'per_process_request_limit':3,'offline_inference_requests':0,'state_roots':str(state),'history':'Identical to frozen final release paired fixtures and expected values. Prepared turn0, native headless task turn1.','limits':'3 paired single runs, no quality equivalence or general benchmark pass-rate claim. Includes other headless bundle plugins and native tool schemas. Prefix cache/order effects retained.'})
 for spec in specs:
  if any(j['id']==spec['id'] for j in records):continue
  out=pathlib.Path(spec['output']);assert not (out/'native-result.json').exists(),'Attempt already present: do not regenerate'
  env=dict(os.environ,HEADLESS_PERF_JOB=str(out/'job.json'),STRATA_API_KEY='local-headless-performance');env.pop('DSH_HOME',None)
  cmd=[shutil.which('node'),'--import','tsx/esm',str(DSH/'apps/cli/src/bin.ts'),'--profile','headless','--patch',spec['patch'],spec['prompt']]
  print('START '+mode+' '+spec['id'],flush=True);start=time.monotonic()
  with (out/'stdout.txt').open('w') as stdout,(out/'stderr.txt').open('w') as stderr:
   p=subprocess.run(cmd,cwd=DSH,env=env,stdout=stdout,stderr=stderr,timeout=600)
  record={**spec,'exit_code':p.returncode,'wall_seconds':round(time.monotonic()-start,3),'command':cmd};records.append(record);dump(manifest,records);print('END '+json.dumps({'id':spec['id'],'exit_code':p.returncode,'wall_seconds':record['wall_seconds']}),flush=True)
  if not (out/'native-result.json').exists() or p.returncode:raise RuntimeError('Actual headless run failed; inspect '+str(out))
 for p,h in integrity.items():assert sha(pathlib.Path(p))==h,'Production configuration changed: '+p
 print('DONE '+mode,flush=True)
if __name__=='__main__':main()
