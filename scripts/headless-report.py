#!/usr/bin/env python3
"""Validate real headless performance, recall, native transport omissions and cost."""
import argparse,csv,datetime,hashlib,json,pathlib,re,statistics,subprocess,os
PROJECT=pathlib.Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def dump(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--run',type=pathlib.Path,required=True);args=ap.parse_args();r=args.run.resolve();f=json.loads((r/'evidence/freeze.json').read_text());manifest=json.loads((r/'formal-manifest.json').read_text());assert len(manifest)==6
 for p,h in f['production_files'].items():assert sha(pathlib.Path(p))==h
 assert sha(r/'evidence/runtime-code/headless-observer.mjs')==f['observer_sha256'] and sha(r/'evidence/runtime-code/headless-run.py')==f['runner_sha256']
 ledger=[];rows=[];exceptions=[];wire_count_inputs=[]
 assert {record['id'] for record in manifest}=={case+'-'+arm for case in ['pinned-state','latest-correction','longer-pressure'] for arm in ['baseline','compact']}
 for record in manifest:
  out=r/'jobs'/record['id'];cfg=json.loads((out/'job.json').read_text());d=json.loads((out/'native-result.json').read_text());ev=[json.loads(l) for l in (out/'events.jsonl').read_text().splitlines()];end={e['data']['index']:e['data'] for e in ev if e['kind']=='response-end'};ft={e['data']['index']:e['data']['wall_ms']/1000 for e in ev if e['kind']=='first-token'}
  assert record['exit_code']==0 and d['reason']['kind']=='completed';assert sha(out/'job.json')==record['job_sha256'] and sha(out/'observer.patch.yml')==record['patch_sha256']
  text=d['text'].strip();match=re.fullmatch(r'```(?:json)?\s*(.*?)\s*```',text,re.S)
  if match:text=match.group(1)
  try:answer=json.loads(text)
  except ValueError:answer=None
  checks={key:isinstance(answer,dict) and answer.get(key)==value for key,value in cfg['expected'].items()}
  pressure=[e['data'] for e in ev if e['kind']=='pre-step-end'];assert pressure
  comp=[e for e in d['events'] if e['type']=='compaction/end'];commits=[e for e in comp if not e['data'].get('error')];summary_seconds=sum((e['time']-next(s['time'] for s in d['events'] if s['type']=='compaction/start' and s['data']['compactionId']==e['data']['compactionId']))/1000 for e in comp)
  request_events=[e['data'] for e in ev if e['kind']=='request'];p=o=cache=0;network=summary_tokens=0;unknown=0;first_answer=None;native_coverage={};actual_message_count=None;pre_adapter_count=None;lengths={}
  for request in request_events:
   index=request['index'];entry=json.loads((out/f'request-{index}.json').read_text());body=entry['body'];purpose=entry['purpose'];assert body['model']==f['health']['model'];assert body['reasoning_effort']=='high';assert body['max_tokens']==({'compaction':4096,'conversation':16384,'session-title':64}[purpose])
   wire_count_inputs.append(body)
   raw=out/f'response-{index}.sse';chunks=[]
   if raw.exists():chunks=[json.loads(line[6:]) for line in raw.read_text().splitlines() if line.startswith('data: {')]
   usages=[x['usage'] for x in chunks if x.get('usage')];assert len(usages)<=1
   timings=next((x['timings'] for x in chunks if x.get('timings')),{});finishes=[c['finish_reason'] for x in chunks for c in x.get('choices',[]) if c.get('finish_reason')];lengths[purpose]=lengths.get(purpose,0)+finishes.count('length')
   usage=usages[0] if usages else None
   if usage:
    assert usage['prompt_tokens']+usage['completion_tokens']==usage['total_tokens'];p+=usage['prompt_tokens'];o+=usage['completion_tokens'];cache+=usage.get('prompt_tokens_details',{}).get('cached_tokens',0)
    if purpose=='compaction':summary_tokens+=usage['total_tokens']
   else:unknown+=1;exceptions.append({'job':record['id'],'request':index,'purpose':purpose,'kind':'usage-not-returned','cap':body['max_tokens'],'finish':finishes})
   sec=end.get(index,{}).get('wall_ms',0)/1000;network+=sec
   if purpose=='conversation' and first_answer is None:
    rendered=json.dumps(body['messages'],ensure_ascii=False);native_coverage={k:v in rendered for k,v in cfg['expected'].items()};actual_message_count=len(body['messages']);first_answer=ft.get(index)
    opts=next(e['data'] for e in ev if e['kind']=='llm-options' and e['data']['purpose']=='conversation');pre_adapter_count=len(opts['messages'])
   ledger.append({'job':record['id'],'case':record['case'],'arm':record['arm'],'index':index,'purpose':purpose,'usage':usage,'network_seconds':round(sec,3),'first_token_seconds':ft.get(index),'finish':finishes,'timings':timings,'wire_sha256':sha(out/f'request-{index}.json'),'sse_sha256':sha(raw) if raw.exists() else None})
  row={'job':record['id'],'case':record['case'],'arm':record['arm'],'completed':True,'fact_passed':sum(checks.values()),'fact_total':len(checks),'all_facts_correct':all(checks.values()),'field_checks':checks,'answer':answer,'expected':cfg['expected'],'requests':len(request_events),'prompt_tokens':p,'output_tokens':o,'total_tokens':p+o,'cached_tokens':cache,'summary_tokens':summary_tokens,'unknown_usage_requests':unknown,'network_seconds':round(network,3),'process_wall_seconds':record['wall_seconds'],'summary_wall_seconds':round(summary_seconds,3),'before_estimated_tokens':pressure[0]['beforeEstimatedTokens'],'after_estimated_tokens':pressure[0]['afterEstimatedTokens'],'context_reduction_pct':round(100*(1-pressure[0]['afterEstimatedTokens']/pressure[0]['beforeEstimatedTokens']),2),'committed_compactions':len(commits),'stats':d['compactionStats'],'first_answer_token_seconds':first_answer,'pre_adapter_message_count':pre_adapter_count,'actual_wire_message_count':actual_message_count,'expected_values_present_in_actual_first_answer_wire':native_coverage,'response_length_finishes':lengths,'native_reason':d['reason']}
  rows.append(row)
  if not row['all_facts_correct'] or d['compactionStats']['passFailures'] or d['compactionStats']['parseFailures']:exceptions.append({'job':record['id'],'kind':'native-outcome','fact_checks':checks,'stats':d['compactionStats']})
 counts=json.loads(subprocess.check_output([os.environ['STRATA_PYTHON'],str(PROJECT/'scripts/count-strata-wire.py')],input=json.dumps(wire_count_inputs),text=True))
 assert len(counts)==len(ledger),'Every dispatched request must have an exact token count'
 for item,count in zip(ledger,counts):
  assert count['planning_tokens']<=131072;item['offline_exact_count']=count
  if item['usage']:assert item['usage']['prompt_tokens']==count['input_tokens']
  item['conservative_unknown_usage_upper_tokens']=0 if item['usage'] else count['input_tokens']+count['output_cap']
 attempts=[json.loads(line) for line in (r/'attempts.jsonl').read_text().splitlines()];assert len(attempts)==len(ledger)<=f['request_limit']
 arms={}
 for arm in ['baseline','compact']:
  group=[x for x in rows if x['arm']==arm];assert len(group)==3
  arms[arm]={'runs':3,'all_facts_correct_tasks':sum(x['all_facts_correct'] for x in group),'fact_passed':sum(x['fact_passed'] for x in group),'fact_total':18,'median_process_wall_seconds':round(statistics.median(x['process_wall_seconds'] for x in group),3),'median_summary_wall_seconds':round(statistics.median(x['summary_wall_seconds'] for x in group),3),'median_context_reduction_pct':statistics.median(x['context_reduction_pct'] for x in group),'unknown_usage_upper_tokens':sum(x['conservative_unknown_usage_upper_tokens'] for x in ledger if x['arm']==arm)}
  for key in ['requests','prompt_tokens','output_tokens','total_tokens','cached_tokens','summary_tokens','unknown_usage_requests','committed_compactions','network_seconds','summary_wall_seconds']:arms[arm][key]=round(sum(x[key] for x in group),3)
  for key in ['parseFailures','proseFallbacks','shapeRepairs','passFailures']:arms[arm][key]=sum(x['stats'][key] for x in group)
 paired=[]
 for case in ['pinned-state','latest-correction','longer-pressure']:
  a=next(x for x in rows if x['case']==case and x['arm']=='baseline');b=next(x for x in rows if x['case']==case and x['arm']=='compact');cfgs=[json.loads((r/'jobs'/x['job']/'job.json').read_text()) for x in [a,b]]
  assert cfgs[0]['history']==cfgs[1]['history'] and cfgs[0]['expected']==cfgs[1]['expected']
  paired.append({'case':case,'initial_history_equal':True,'baseline_facts':a['fact_passed'],'compact_facts':b['fact_passed'],'baseline_process_seconds':a['process_wall_seconds'],'compact_process_seconds':b['process_wall_seconds'],'baseline_tokens':a['total_tokens'],'compact_tokens':b['total_tokens'],'compact_summary_seconds':b['summary_wall_seconds'],'context_reduction_pct':b['context_reduction_pct'],'baseline_pre_adapter_messages':a['pre_adapter_message_count'],'baseline_wire_messages':a['actual_wire_message_count'],'compact_wire_messages':b['actual_wire_message_count']})
 A,B=arms['baseline'],arms['compact'];delta=round(100*(B['total_tokens']/A['total_tokens']-1),2)
 version=f['plugin_version']
 result={'protocol':f['protocol'],'plugin_version':version,'production_profile':str(pathlib.Path.home()/'.dsh/profiles/headless'),'model':f['health']['model'],'production_model_parameters':f['model_parameters'],'arms':arms,'jobs':rows,'paired':paired,'sent_requests':len(ledger),'reported_total_tokens':sum(x['total_tokens'] for x in rows),'reported_token_change_pct':delta,'validation':{'actual_headless_native_runner':True,'production_config_and_plugin_hashes_unchanged':True,'initial_paired_history_equal':True,'exact_native_token_count_for_every_reported_usage':True,'all_dispatched_calls_charged':True,'no_model_calls_in_offline_preflight':True},'limitations':['3 controlled history-recall pressure tasks, one paired run each; does not establish coding success rate or quality equivalence.','Original headless provider maxContextTokens49152 may omit oldest human turns before transport. Lower baseline spend then buys different information; it is not a lossless-compression baseline.','Native high reasoning and default sampling preserved; prefix caching, MTP, request concurrency and launch overhead affect latency.','Total request-seconds include concurrent title and main calls, so they are not elapsed process seconds. All titles and summaries included in cost.'],'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 dump(r/'results.json',result);dump(r/'request-ledger.json',ledger);dump(r/'exceptions.json',exceptions)
 with (r/'results.csv').open('w') as file:
  fields=['case','arm','fact_passed','fact_total','requests','total_tokens','summary_tokens','committed_compactions','before_estimated_tokens','after_estimated_tokens','context_reduction_pct','summary_wall_seconds','process_wall_seconds','pre_adapter_message_count','actual_wire_message_count','unknown_usage_requests'];w=csv.DictWriter(file,fields,extrasaction='ignore');w.writeheader();w.writerows(rows)
 lines=[f'# Adaptive Compact {version}：實際 dsh headless 性能測試','',f"模型 `{f['health']['model']}`，本機 Strata。直接啟動 `node --import tsx/esm $DSH_REPO/apps/cli/src/bin.ts --profile headless --patch <observer>`，原生 headless runner 創建 Agent 並完成任務。實際載入使用者 headless 的全部 bundle 與 settings。",'', '保持正式設定：thresholdRatio=0.25、retainTokens=8192、releaseRatio=0.2、summary cap=4096；reasoning high、作答預設 cap=16384。Compact 臂沒有更改插件或模型參數；baseline 臂仅通过临时 CLI patch 关闭 auto。临时持久化和存储目录隔离，测试后正式配置、插件文件 hash 不变。','',f'| 指標 | 自動壓縮關閉 | Compact {version} |','|---|---:|---:|',f"| 關鍵資料正確 | {A['fact_passed']}/18 | {B['fact_passed']}/18 |",f"| 全部六項正確的任務 | {A['all_facts_correct_tasks']}/3 | {B['all_facts_correct_tasks']}/3 |",f"| 成功壓縮 | {A['committed_compactions']} | {B['committed_compactions']} |",f"| 壓縮耗時中位數 | — | {B['median_summary_wall_seconds']} 秒 |",f"| 上下文估算減少中位數 | — | {B['median_context_reduction_pct']}% |",f"| 完整程序耗時中位數 | {A['median_process_wall_seconds']} 秒 | {B['median_process_wall_seconds']} 秒 |",f"| 總 reported tokens（含摘要與標題） | {A['total_tokens']} | {B['total_tokens']} |",f"| 摘要 reported tokens | {A['summary_tokens']} | {B['summary_tokens']} |",f"| 模型請求 | {A['requests']} | {B['requests']} |",f"| 缺少 usage 的請求 | {A['unknown_usage_requests']} | {B['unknown_usage_requests']} |",f"| 摘要失敗／解析失敗 | {A['passFailures']}/{A['parseFailures']} | {B['passFailures']}/{B['parseFailures']} |"]
 lines += ['',f"三種情境為既有配置、最新更正、較長歷史。每題以完全一致的已凍結公開源碼讀取記錄及六項設定值構造歷史，再讓原生 headless 作答；離線假回應只用於確認原生 auto 和請求准入，沒有計入正式分數或成本。正式總請求 {len(ledger)}，reported tokens {result['reported_total_tokens']}。",'',f"原始總用量變化 {delta:+.2f}%。本測試不能把 baseline 的較低支出解釋為有效保留相同資訊的基準：正式 adapter 的 49,152-token 預算會省略最舊完整人類輪次，原歷史與實際 wire 的訊息數、關鍵值覆蓋皆已保存。這會讓 baseline 在作答前就丟失部分關鍵資料。Compact 的壓縮保留能力、額外成本與這個 adapter 行為應一起解讀。",'','| 情境 | baseline 正確項 | Compact 正確項 | 壓縮秒數 | 估算上下文減少 | baseline 送出訊息數／原訊息數 |','|---|---:|---:|---:|---:|---:|']
 for p in paired:lines.append(f"| {p['case']} | {p['baseline_facts']}/6 | {p['compact_facts']}/6 | {p['compact_summary_seconds']} | {p['context_reduction_pct']}% | {p['baseline_wire_messages']}/{p['baseline_pre_adapter_messages']} |")
 lines += ['', '輸入／輸出／cached tokens、各請求首次 token 時間、Strata prefill／decode 時間與速率、草稿接受量、原始 SSE、完整 wire、壓縮事件及每項回憶檢查见 `request-ledger.json`、`results.json` 和 `jobs/`。網路請求時間可包含併發的標題請求，不能直接當成完整程序 wall time。', '', '限制：只有三個固定壓力情境，屬於正式 headless 的整合性能與關鍵資料保留測試；不是 Vulcan 程式修復分數，也沒有證明任意長任務的摘要無損。正式 sampling、high reasoning、前綴快取、MTP 和全 profile 的其他插件都保留，因此數字只適用於這個運行配置。']
 if sum(x['unknown_usage_requests'] for x in rows):lines += ['',f"存在未回傳 usage 的請求；上限另外列在 results.json 的 unknown_usage_upper_tokens，總成本與比較不能視為完整。"]
 (r/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps({'arms':arms,'requests':len(ledger),'reported_token_change_pct':delta},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
